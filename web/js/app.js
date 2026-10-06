import config from '../config.js';
import { createApi } from './api.js';
import {
  computeSchedule, formatClock, formatDuration, parseTime, toTimeString, isoDate, addDays,
  dateFromIso, resolveEpisodeRuntimes, resolveMovieRuntime, footnoteText, isWatched,
  nextUnwatched, discordSummary, isEstimate,
} from './schedule.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const IMG = 'https://image.tmdb.org/t/p/';
const NFL_NOTE = 'Typical NFL game length; overtime not included';

const today = () => isoDate(new Date());
const weekday = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'long' });
const weekdayShort = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'short' });
const longDate = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shortLabel = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

/** 24-hour clock for the timeline: 1155 -> "19:15". */
function clock24(min) {
  if (min == null) return '';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** Poster image, or a quiet tinted placeholder when TMDB has none. */
function poster(title, path, size = 'w185', cls = 'poster') {
  if (path) return `<img class="${cls}" src="${IMG}${size}${esc(path)}" alt="" loading="lazy">`;
  return `<span class="${cls} poster-blank tone-${hash(title) % 5}" aria-hidden="true"></span>`;
}

function isGame(item) {
  return item.kind === 'custom' && /\bNFL\b|football|game/i.test(`${item.title} ${item.subtitle || ''}`);
}

function itemSub(it) {
  if (it.kind === 'episode') return `S${it.season}E${it.episode}${it.subtitle ? ` ${it.subtitle}` : ''}`;
  return it.subtitle || (it.kind === 'movie' ? 'Movie' : '');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  if (/sign_in_required|JWT|401/i.test(msg)) return 'Your session expired. Sign in again.';
  if (/tmdb_key_missing/.test(msg)) return 'The TMDB key is not set up yet in Supabase.';
  if (/webhook_missing/.test(msg)) return 'The Discord webhook is not set up yet in Supabase.';
  if (/already_marked/.test(msg)) return 'This night is already marked as watched.';
  return `Something went wrong: ${msg}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  api: null,
  date: today(),
  weekStart: today(),
  night: null, // { start_time, version, watched_at }
  items: [],
  week: new Map(), // date -> summary
  queue: [],
  queueFilter: 'all',
  progress: new Map(), // show id -> progress
  shows: new Map(), // show id -> TMDB show details (seasons, poster)
  search: { q: '', results: [], loading: false, open: false },
  drawer: null, // { mode: 'picker', ... } | { mode: 'custom', ... }
  editing: null, // { index }
  saveTimer: null,
  saving: false,
  pendingSave: false,
  loadToken: 0,
  dragFrom: null,
};

// ---------------------------------------------------------------------------
// Boot and auth
// ---------------------------------------------------------------------------
async function boot() {
  state.api = await createApi(config);
  if (state.api.demo) $('#demo-banner').hidden = false;

  $('#login-form').addEventListener('submit', onLogin);
  $('#sign-out').addEventListener('click', async () => {
    await state.api.signOut();
    showLogin();
  });
  state.api.onAuthChange((session) => {
    if (!session) showLogin();
  });

  const session = await state.api.session();
  if (session) startApp();
  else showLogin();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form input[name=email]').focus();
}

async function onLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await state.api.signIn(form.email.value.trim(), form.password.value);
    form.reset();
    startApp();
  } catch (ex) {
    err.textContent = /invalid/i.test(ex.message)
      ? "That email and password don't match. Check them and try again."
      : friendlyError(ex);
  } finally {
    btn.disabled = false;
  }
}

let started = false;
async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (!started) {
    started = true;
    wireEvents();
    state.api.subscribe(onRemoteChange);
  }
  await Promise.all([loadNight(state.date), loadWeek(), loadProgress()]);
  await loadQueue();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function loadNight(date) {
  const token = ++state.loadToken;
  state.date = date;
  state.editing = null;
  renderWeek();
  try {
    const { night, items } = await state.api.loadNight(date);
    if (token !== state.loadToken) return;
    state.night = night;
    state.items = items;
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderNight();
  renderQueue();
}

async function loadWeek() {
  const from = state.weekStart;
  const to = addDays(from, 6);
  try {
    const rows = await state.api.loadRange(from, to);
    state.week = new Map(rows.map((r) => [r.night_date, summarize(r.lineup_items || [], r.watched_at)]));
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderWeek();
}

function summarize(items, watchedAt) {
  return {
    total: items.reduce((s, i) => s + (i.runtime_min || 0), 0),
    estimated: items.some((i) => isEstimate(i.runtime_source)),
    game: items.some(isGame),
    count: items.length,
    watched: !!watchedAt,
  };
}

async function loadQueue() {
  try {
    state.queue = await state.api.listQueue();
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderQueue();
  // Fetch show details for series in the queue so cards can show progress.
  await Promise.all(state.queue.filter((q) => q.kind === 'tv').map((q) => ensureShow(q.tmdb_id).catch(() => null)));
  renderQueue();
}

async function loadProgress() {
  try {
    const rows = await state.api.listProgress();
    state.progress = new Map(rows.map((p) => [p.show_tmdb_id, p]));
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderQueue();
}

async function ensureShow(id) {
  if (!state.shows.has(id)) state.shows.set(id, await state.api.tmdb(`tv/${id}`));
  return state.shows.get(id);
}

function onRemoteChange(table, record) {
  if (table === 'queue') {
    loadQueue();
    return;
  }
  loadWeek();
  if (record && record.night_date === state.date && record.version !== state.night?.version
      && !state.saving && !state.saveTimer) {
    loadNight(state.date);
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
function changeLineup(mutator) {
  const items = state.items.map((i) => ({ ...i }));
  mutator(items);
  state.items = items;
  state.week.set(state.date, summarize(items, state.night?.watched_at));
  renderNight();
  renderWeek();
  renderQueue();
  queueSave();
}

function setStartTime(value) {
  state.night = { ...(state.night || { version: 0, watched_at: null }), start_time: value || null };
  renderNight();
  queueSave();
}

function queueSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 500);
}

async function save() {
  state.saveTimer = null;
  if (state.saving) {
    state.pendingSave = true;
    return;
  }
  state.saving = true;
  const date = state.date;
  try {
    const version = await state.api.saveLineup(
      date, state.night?.version ?? 0, state.night?.start_time ?? null, state.items,
    );
    if (date === state.date) state.night = { ...(state.night || { watched_at: null }), version };
  } catch (ex) {
    if (ex.stale) {
      toast('The other person changed this night. Showing their latest version.');
      await loadNight(date);
    } else {
      toast(friendlyError(ex));
    }
  } finally {
    state.saving = false;
    if (state.pendingSave) {
      state.pendingSave = false;
      save();
    }
  }
}

async function flushSave() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    await save();
  }
  while (state.saving) await new Promise((r) => setTimeout(r, 50));
}

// ---------------------------------------------------------------------------
// Header: nights
// ---------------------------------------------------------------------------
function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const t = today();
  $('#week').innerHTML = `
    <button class="seg-step" type="button" data-step="-7" aria-label="Previous week">&lsaquo;</button>
    <div class="seg">
      ${days.map((d) => {
        const s = state.week.get(d);
        const label = `${weekdayShort(d)} ${dateFromIso(d).getDate()}`;
        const meta = s?.count ? `${s.estimated ? '~' : ''}${formatDuration(s.total)} planned` : 'nothing planned';
        return `
          <button type="button" class="seg-item ${d === state.date ? 'is-current' : ''}" data-date="${d}"
                  aria-pressed="${d === state.date}"
                  aria-label="${esc(shortLabel(d))}${d === t ? ', today' : ''}, ${esc(meta)}${s?.game ? ', game night' : ''}">
            ${esc(label)}
            ${s?.count ? `<span class="seg-dot ${s.game ? 'is-game' : ''}" aria-hidden="true"></span>` : ''}
          </button>`;
      }).join('')}
    </div>
    <button class="seg-step" type="button" data-step="7" aria-label="Next week">&rsaquo;</button>`;
}

// ---------------------------------------------------------------------------
// Night: header, timeline, lineup list
// ---------------------------------------------------------------------------

/**
 * Place every item on a clock so the timeline can draw it. With a start time
 * that's the real schedule. Without one, the night is anchored to the first
 * kickoff if there is one, otherwise drawn from an arbitrary 19:00 with the
 * clock hidden.
 */
function timelineLayout(startTime, items) {
  const real = computeSchedule(startTime, items);
  if (real.rows.every((r) => r.start != null)) return { s: real, clock: true };
  let pre = 0;
  for (const it of items) {
    if (it.anchor_time) {
      const start = parseTime(it.anchor_time) - pre;
      return { s: computeSchedule(toTimeString(start), items), clock: true, provisional: true };
    }
    pre += Number(it.runtime_min) || 0;
  }
  return { s: computeSchedule('19:00', items), clock: false, provisional: true };
}

function renderNight() {
  const night = state.night;
  const real = computeSchedule(night?.start_time, state.items);
  const startVal = night?.start_time ? toTimeString(parseTime(night.start_time)) : '';
  const ends = real.end != null ? `${real.endEstimated ? '~' : ''}${formatClock(real.end)}` : 'set a start time';
  const total = real.rows.length ? `${real.totalEstimated ? '~' : ''}${formatDuration(real.total)}` : 'none yet';

  $('#night').innerHTML = `
    <div class="night-head">
      <div>
        <h1 class="night-title">${esc(longDate(state.date))}${state.date === today() ? '<span class="tag">Tonight</span>' : ''}</h1>
        <div class="night-meta">
          <label class="meta-start">Starts
            <input type="time" id="start-time" value="${startVal}" aria-label="Start time"></label>
          <span>Ends <strong>${esc(ends)}</strong></span>
          <span>Runtime <strong>${esc(total)}</strong></span>
          ${night?.watched_at ? '<span class="meta-done">Watched</span>' : ''}
        </div>
      </div>
      <div class="night-actions">
        <button type="button" class="btn" data-act="watched" ${!real.rows.length || night?.watched_at ? 'disabled' : ''}>
          ${night?.watched_at ? 'Watched' : 'Mark as watched'}</button>
        <button type="button" class="btn btn-primary" data-act="discord" ${real.rows.length ? '' : 'disabled'}>Post to Discord</button>
      </div>
    </div>
    ${timelineHtml(real)}
    ${lineupHtml(real)}`;

  if (state.editing) {
    const input = $('.runtime-input');
    if (input) { input.focus(); input.select(); }
  }
}

function timelineHtml(real) {
  if (!state.items.length) {
    return `
      <div class="panel timeline timeline-empty">
        <p class="empty-title">Nothing planned for ${esc(weekday(state.date))} yet.</p>
        <p class="muted">Search for a movie or show above, add one from the queue below, or add a game.</p>
        <div class="empty-actions">
          <button type="button" class="btn" data-act="focus-search">Search</button>
          <button type="button" class="btn" data-act="open-custom">Add a game or block</button>
        </div>
      </div>`;
  }
  const { s, clock } = timelineLayout(state.night?.start_time, state.items);
  const first = s.rows[0].start;
  const last = Math.max(...s.rows.map((r) => r.end));
  const lo = Math.floor(first / 60) * 60;
  const hi = Math.max(Math.ceil(last / 60) * 60, lo + 120);
  const span = hi - lo;
  const pct = (m) => `${(((m - lo) / span) * 100).toFixed(3)}%`;
  const w = (m) => `${((m / span) * 100).toFixed(3)}%`;
  const step = span > 480 ? 120 : 60;

  const ruler = [];
  for (let m = lo; m <= hi; m += step) {
    ruler.push(`<span style="left:${pct(m)}" class="${m === hi ? 'is-last' : ''}">${clock ? clock24(m) : ''}</span>`);
  }

  const blocks = [];
  s.rows.forEach((r, i) => {
    const it = r.item;
    const prevEnd = i > 0 ? s.rows[i - 1].end : null;
    if (r.gap > 0 && prevEnd != null) {
      blocks.push(`<li class="tl-gap" style="left:${pct(prevEnd)};width:${w(r.gap)}"
        aria-label="${formatDuration(r.gap)} free before kickoff"><span>${formatDuration(r.gap)}</span></li>`);
    }
    if (r.overlap > 0) {
      blocks.push(`<li class="tl-clash" style="left:${pct(r.start)};width:${w(r.overlap)}"
        aria-label="Runs ${formatDuration(r.overlap)} past kickoff"></li>`);
    }
    const showTime = clock && !(real.rows[i].start == null && !r.anchored);
    const time = showTime ? `${r.anchored ? 'Kickoff ' : ''}${r.startEstimated ? '~' : ''}${clock24(r.start)}${r.anchored ? ', fixed' : ''}` : '';
    const dur = `${r.itemEstimated ? '~' : ''}${formatDuration(it.runtime_min)}`;
    blocks.push(`
      <li class="tl-block ${isGame(it) || r.anchored ? 'is-fixed' : ''}" style="left:${pct(r.start)};width:${w(it.runtime_min)}">
        ${it.poster_path ? `<img class="tl-poster" src="${IMG}w154${esc(it.poster_path)}" alt="" loading="lazy">` : ''}
        <div class="tl-body">
          ${time ? `<span class="tl-time">${r.anchored ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(time)}</span>` : ''}
          <span class="tl-title">${esc(it.title)}</span>
          <span class="tl-sub">${esc(itemSub(it))}</span>
          <span class="tl-dur">${dur}${r.mark ? `<sup>${r.mark}</sup>` : ''}</span>
        </div>
      </li>`);
  });
  if (clock && real.end != null) {
    blocks.push(`<li class="tl-end" style="left:${pct(real.end)}" aria-label="Done around ${formatClock(real.end)}"></li>`);
  }

  const width = Math.max(span * 3.4, 640);
  return `
    <section class="panel timeline" aria-label="Timeline">
      <div class="tl-scroll">
        <div class="tl-canvas" style="min-width:${width}px">
          <div class="tl-ruler" aria-hidden="true">${ruler.join('')}</div>
          <ol class="tl-lane" style="--hour:${((60 / span) * 100).toFixed(3)}%">${blocks.join('')}</ol>
        </div>
      </div>
      <div class="tl-foot">
        ${s.footnotes.map((f) => `<span><sup>${f.mark}</sup> ${esc(f.text)}</span>`).join('')}
        ${!state.night?.start_time ? '<span>Set a start time to see when everything happens.</span>' : ''}
        ${real.end != null ? `<span class="tl-done">Done <strong>${real.endEstimated ? '~' : ''}${clock24(real.end)}</strong></span>` : ''}
      </div>
    </section>`;
}

function lineupHtml(real) {
  if (!state.items.length) return '';
  const rows = real.rows.map((r, i) => {
    const it = r.item;
    const note = footnoteText(it);
    const time = r.start != null ? `${r.startEstimated ? '~' : ''}${clock24(r.start)}` : '';
    const runtime = state.editing && state.editing.index === i
      ? `<input class="runtime-input" type="number" min="1" max="600" inputmode="numeric" value="${it.runtime_min}"
                data-act="runtime-input" data-index="${i}" aria-label="Runtime in minutes for ${esc(it.title)}">`
      : `<button class="runtime" type="button" data-act="edit-runtime" data-index="${i}"
                 title="${esc(note ? `${note}. Click to set the exact length.` : 'Click to correct the length')}">
           ${r.itemEstimated ? '~' : ''}${formatDuration(it.runtime_min)}${r.mark ? `<sup>${r.mark}</sup>` : ''}${r.edited ? '<span class="edited">edited</span>' : ''}
         </button>`;
    const fixed = r.anchored
      ? `<label class="kickoff">Kickoff <input type="time" value="${esc(toTimeString(parseTime(it.anchor_time)))}"
           data-act="anchor" data-index="${i}" aria-label="Fixed start time for ${esc(it.title)}"></label>` : '';
    const warn = r.overlap > 0 ? `<span class="row-warn">Runs ${formatDuration(r.overlap)} into kickoff</span>` : '';
    return `
      <li class="row ${r.anchored ? 'is-fixed' : ''}" data-index="${i}" draggable="true">
        <span class="row-time">${esc(time)}</span>
        ${poster(it.title, it.poster_path, 'w92', 'row-poster')}
        <span class="row-main">
          <span class="row-title">${esc(it.title)}</span>
          <span class="row-sub">${esc(itemSub(it))}</span>
          ${fixed}${warn}
        </span>
        ${runtime}
        <span class="row-tools">
          <button type="button" class="icon-btn" data-act="up" data-index="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(it.title)} earlier">&uarr;</button>
          <button type="button" class="icon-btn" data-act="down" data-index="${i}" ${i === real.rows.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(it.title)} later">&darr;</button>
          <button type="button" class="icon-btn icon-remove" data-act="remove" data-index="${i}" aria-label="Remove ${esc(it.title)}">&times;</button>
        </span>
      </li>`;
  });
  return `
    <section class="lineup" aria-label="Lineup">
      <div class="section-head">
        <h2>Lineup</h2>
        <button type="button" class="btn btn-ghost btn-sm" data-act="open-custom">+ Game or block</button>
      </div>
      <ol class="rows">${rows.join('')}</ol>
    </section>`;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** The next episode to add for a show: after progress and after anything already in this night. */
function nextEpisodeFor(showId) {
  const show = state.shows.get(showId);
  if (!show) return null;
  let s = 1;
  let e = 0;
  const p = state.progress.get(showId);
  if (p) { s = p.last_season; e = p.last_episode; }
  for (const it of state.items) {
    if (it.kind === 'episode' && it.show_tmdb_id === showId
        && (it.season > s || (it.season === s && it.episode > e))) {
      s = it.season; e = it.episode;
    }
  }
  const seasons = (show.seasons || []).filter((x) => x.season_number > 0);
  const cur = seasons.find((x) => x.season_number === s);
  if (cur && cur.episode_count && e >= cur.episode_count) {
    const nxt = seasons.find((x) => x.season_number > s);
    return nxt ? { season: nxt.season_number, episode: 1 } : null;
  }
  return { season: s, episode: e + 1 };
}

function queueProgress(q) {
  const show = state.shows.get(q.tmdb_id);
  const p = state.progress.get(q.tmdb_id);
  if (!p || !show) return { text: p ? `Last watched S${p.last_season}E${p.last_episode}` : 'Not started', pct: 0 };
  const season = (show.seasons || []).find((x) => x.season_number === p.last_season);
  if (!season?.episode_count) return { text: `Last watched S${p.last_season}E${p.last_episode}`, pct: 0 };
  const left = Math.max(season.episode_count - p.last_episode, 0);
  return {
    text: left ? `Season ${p.last_season}, ${left} of ${season.episode_count} left` : `Season ${p.last_season} done`,
    pct: Math.min(100, Math.round((p.last_episode / season.episode_count) * 100)),
  };
}

function renderQueue() {
  const day = weekdayShort(state.date);
  const filters = [['all', 'All'], ['progress', 'In progress'], ['movie', 'Movies']];
  const list = state.queue.filter((q) => {
    if (state.queueFilter === 'movie') return q.kind === 'movie';
    if (state.queueFilter === 'progress') return q.kind === 'tv' && state.progress.has(q.tmdb_id);
    return true;
  });
  const cards = list.map((q) => {
    const show = q.kind === 'tv' ? state.shows.get(q.tmdb_id) : null;
    const posterPath = q.poster_path || show?.poster_path || null;
    let meta;
    let bar = '';
    let action;
    if (q.kind === 'tv') {
      const prog = queueProgress(q);
      meta = prog.text;
      if (prog.pct) bar = `<span class="bar"><span style="width:${prog.pct}%"></span></span>`;
      const next = nextEpisodeFor(q.tmdb_id);
      action = next
        ? `<button type="button" class="btn btn-sm btn-block" data-act="add-next" data-id="${q.tmdb_id}">Add S${next.season}E${next.episode} to ${esc(day)}</button>`
        : `<button type="button" class="btn btn-sm btn-block" data-act="open-show" data-id="${q.tmdb_id}">Episodes</button>`;
    } else {
      meta = `Movie${q.year ? `, ${q.year}` : ''}`;
      action = `<button type="button" class="btn btn-sm btn-block" data-act="add-movie" data-id="${q.tmdb_id}">Add to ${esc(day)}</button>`;
    }
    return `
      <li class="card">
        <div class="card-art">
          ${poster(q.title, posterPath, 'w342', 'card-poster')}
          ${bar}
          <button type="button" class="card-remove icon-btn" data-act="queue-remove" data-id="${esc(q.id)}"
                  aria-label="Remove ${esc(q.title)} from the queue">&times;</button>
        </div>
        <div class="card-body">
          ${q.kind === 'tv'
            ? `<button type="button" class="card-title link" data-act="open-show" data-id="${q.tmdb_id}">${esc(q.title)}</button>`
            : `<span class="card-title">${esc(q.title)}</span>`}
          <span class="card-meta">${esc(meta)}</span>
          ${action}
        </div>
      </li>`;
  });
  $('#queue').innerHTML = `
    <div class="section-head">
      <h2>Queue <span class="count">${state.queue.length}</span></h2>
      <div class="seg seg-sm" role="group" aria-label="Filter queue">
        ${filters.map(([id, label]) => `
          <button type="button" class="seg-item ${state.queueFilter === id ? 'is-current' : ''}"
                  aria-pressed="${state.queueFilter === id}" data-filter="${id}">${label}</button>`).join('')}
      </div>
    </div>
    ${state.queue.length ? `
      <ul class="cards">
        ${cards.join('')}
        <li><button type="button" class="card-add" data-act="focus-search">Save something for later</button></li>
      </ul>` : `
      <div class="panel queue-empty">
        <p class="muted">The queue is for things you both want to get to. Search above and use <strong>Queue</strong> on any result.</p>
      </div>`}`;
}

// ---------------------------------------------------------------------------
// Search dropdown
// ---------------------------------------------------------------------------
function renderSearch() {
  const box = $('#search-results');
  const input = $('#search-input');
  const { q, results, loading, open } = state.search;
  const show = open && q.trim();
  box.hidden = !show;
  input.setAttribute('aria-expanded', String(!!show));
  if (!show) return;
  if (loading) { box.innerHTML = '<p class="muted pad">Searching&hellip;</p>'; return; }
  if (!results.length) { box.innerHTML = `<p class="muted pad">No movies or shows match "${esc(q)}".</p>`; return; }
  const day = weekdayShort(state.date);
  box.innerHTML = `<ul>${results.map((r) => {
    const isTv = r.media_type === 'tv';
    const title = isTv ? r.name : r.title;
    const year = (isTv ? r.first_air_date : r.release_date || '').slice(0, 4);
    return `
      <li class="result">
        ${poster(title, r.poster_path, 'w92', 'result-poster')}
        <span class="result-main">
          <span class="result-title">${esc(title)}</span>
          <span class="result-meta">${isTv ? 'Series' : 'Movie'}${year ? `, ${year}` : ''}</span>
        </span>
        <span class="result-actions">
          ${isTv
            ? `<button type="button" class="btn btn-sm" data-act="open-show" data-id="${r.id}">Episodes</button>`
            : `<button type="button" class="btn btn-sm" data-act="add-movie" data-id="${r.id}">Add to ${esc(day)}</button>`}
          <button type="button" class="btn btn-sm btn-ghost" data-act="queue-add" data-id="${r.id}" data-kind="${isTv ? 'tv' : 'movie'}"
                  data-title="${esc(title)}" data-year="${esc(year)}" data-poster="${esc(r.poster_path || '')}">Queue</button>
        </span>
      </li>`;
  }).join('')}</ul>`;
}

let searchTimer;
function onSearchInput(q) {
  state.search.q = q;
  state.search.open = true;
  clearTimeout(searchTimer);
  if (!q.trim()) {
    state.search.results = [];
    state.search.loading = false;
    renderSearch();
    return;
  }
  searchTimer = setTimeout(async () => {
    state.search.loading = true;
    renderSearch();
    try {
      const data = await state.api.tmdb('search/multi', { query: q });
      if (state.search.q !== q) return;
      state.search.results = (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 10);
    } catch (ex) {
      toast(friendlyError(ex));
      state.search.results = [];
    }
    state.search.loading = false;
    renderSearch();
  }, 300);
}

function closeSearch() {
  state.search.open = false;
  renderSearch();
}

// ---------------------------------------------------------------------------
// Drawer: episode picker and game/block form
// ---------------------------------------------------------------------------
function openDrawer(content) {
  state.drawer = content;
  renderDrawer();
  const d = $('#drawer');
  if (!d.open) d.showModal();
}

function closeDrawer() {
  state.drawer = null;
  const d = $('#drawer');
  if (d.open) d.close();
}

function renderDrawer() {
  const d = $('#drawer');
  if (!state.drawer) return;
  d.innerHTML = state.drawer.mode === 'picker' ? pickerHtml() : customHtml();
}

function pickerHtml() {
  const p = state.drawer;
  const prog = state.progress.get(p.show.id);
  const seasons = (p.show.seasons || []).filter((s) => s.season_number > 0)
    .concat((p.show.seasons || []).filter((s) => s.season_number === 0));
  const next = new Set(nextUnwatched(p.episodes, prog).slice(0, 1).map((e) => e.id));
  const inLineup = new Set(state.items.filter((i) => i.kind === 'episode').map((i) => i.tmdb_id));
  let list = '<p class="muted pad">Loading episodes&hellip;</p>';
  if (!p.loading) {
    list = p.episodes.length ? `<ul class="episodes">${p.episodes.map((e) => {
      const watched = isWatched(e, prog);
      const est = isEstimate(e.runtime_source);
      const note = footnoteText({ runtime_source: e.runtime_source, runtime_min: e.runtime_min });
      return `
        <li class="episode ${watched ? 'is-watched' : ''}">
          <label class="episode-pick">
            <input type="checkbox" data-act="pick-ep" data-id="${e.id}" ${p.selected.has(e.id) ? 'checked' : ''}>
            <span class="episode-num">E${e.episode_number}</span>
            <span class="episode-name">${esc(e.name)}
              ${next.has(e.id) ? '<span class="pill pill-berry">Next up</span>' : ''}
              ${watched ? '<span class="pill">Watched</span>' : ''}
              ${inLineup.has(e.id) ? '<span class="pill">In lineup</span>' : ''}</span>
            <span class="episode-runtime" ${note ? `title="${esc(note)}"` : ''}>${est ? '~' : ''}${formatDuration(e.runtime_min)}${est ? '<sup>*</sup>' : ''}</span>
          </label>
          <button type="button" class="link small" data-act="set-progress" data-id="${e.id}"
                  aria-label="Mark everything through E${e.episode_number} as watched">Watched through here</button>
        </li>`;
    }).join('')}</ul>` : '<p class="muted pad">TMDB has no episodes listed for this season.</p>';
  }
  const anyEst = !p.loading && p.episodes.some((e) => isEstimate(e.runtime_source));
  const chosen = p.episodes.filter((e) => p.selected.has(e.id));
  const mins = chosen.reduce((s, e) => s + e.runtime_min, 0);
  const chosenEst = chosen.some((e) => isEstimate(e.runtime_source));
  return `
    <div class="drawer-inner">
      <div class="drawer-head">
        ${poster(p.show.name, p.show.poster_path, 'w154', 'drawer-poster')}
        <div class="drawer-titles">
          <h2 id="drawer-title">${esc(p.show.name)}</h2>
          <p class="muted">${prog ? `Last watched S${prog.last_season}E${prog.last_episode}` : 'Not started'}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close-drawer" aria-label="Close">&times;</button>
      </div>
      <div class="drawer-tools">
        <div class="seg seg-sm" role="group" aria-label="Seasons">
          ${seasons.map((s) => `
            <button type="button" class="seg-item ${s.season_number === p.season ? 'is-current' : ''}"
                    aria-pressed="${s.season_number === p.season}" data-act="season" data-season="${s.season_number}">
              ${s.season_number === 0 ? 'Specials' : `S${s.season_number}`}</button>`).join('')}
        </div>
        ${p.loading ? '' : `
        <div class="quick-picks">
          <span class="muted">Select next</span>
          ${[1, 2, 3].map((n) => `<button type="button" class="btn btn-sm" data-act="next-n" data-n="${n}">${n}</button>`).join('')}
        </div>`}
      </div>
      <div class="drawer-body">
        ${list}
        ${anyEst ? '<p class="footnote-inline"><sup>*</sup> TMDB has no runtime for these; hover for how each was estimated.</p>' : ''}
      </div>
      <div class="drawer-foot">
        <span class="muted">${chosen.length ? `${chosen.length} selected, ${chosenEst ? '~' : ''}${formatDuration(mins)}` : 'Nothing selected'}</span>
        <button type="button" class="btn btn-primary" data-act="add-episodes" ${chosen.length ? '' : 'disabled'}>
          Add to ${esc(weekday(state.date))}</button>
      </div>
    </div>`;
}

const PRESETS = {
  mnf: { title: 'NFL: Monday Night Football', anchor: '19:15', minutes: 195, estimate: true, note: NFL_NOTE },
  tnf: { title: 'NFL: Thursday Night Football', anchor: '19:15', minutes: 195, estimate: true, note: NFL_NOTE },
  snf: { title: 'NFL: Sunday Night Football', anchor: '19:20', minutes: 195, estimate: true, note: NFL_NOTE },
};

function defaultCustom() {
  const dow = dateFromIso(state.date).getDay();
  if (dow === 1) return { ...PRESETS.mnf, subtitle: '' };
  if (dow === 4) return { ...PRESETS.tnf, subtitle: '' };
  return { title: '', subtitle: '', anchor: '', minutes: 60, estimate: false, note: '' };
}

function customHtml() {
  const c = state.drawer.form;
  return `
    <div class="drawer-inner">
      <div class="drawer-head">
        <div class="drawer-titles">
          <h2 id="drawer-title">Add a game or block</h2>
          <p class="muted">Anything that isn't on TMDB: a game, a stream, a break.</p>
        </div>
        <button type="button" class="icon-btn" data-act="close-drawer" aria-label="Close">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="presets">
          <button type="button" class="btn btn-sm" data-act="preset" data-preset="mnf">Monday night game</button>
          <button type="button" class="btn btn-sm" data-act="preset" data-preset="tnf">Thursday night game</button>
          <button type="button" class="btn btn-sm" data-act="preset" data-preset="snf">Sunday night game</button>
        </div>
        <form id="custom-form" class="custom-form">
          <label class="field"><span>Name</span>
            <input name="title" required maxlength="120" value="${esc(c.title)}" placeholder="NFL: Thursday Night Football"></label>
          <label class="field"><span>Details</span>
            <input name="subtitle" maxlength="120" value="${esc(c.subtitle)}" placeholder="Bears at Packers"></label>
          <div class="field-row">
            <label class="field"><span>Fixed start time</span>
              <input name="anchor" type="time" value="${esc(c.anchor)}"></label>
            <label class="field"><span>Length (min)</span>
              <input name="minutes" type="number" min="1" max="600" required value="${esc(c.minutes)}"></label>
          </div>
          <label class="check"><input name="estimate" type="checkbox" ${c.estimate ? 'checked' : ''}>
            <span>The length is an estimate (adds a footnote)</span></label>
          <p class="muted small">A fixed start time pins the block, like a kickoff. Items before it are checked against it; items after start when it ends.</p>
        </form>
      </div>
      <div class="drawer-foot">
        <span></span>
        <button type="submit" form="custom-form" class="btn btn-primary">Add to ${esc(weekday(state.date))}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function addMovie(id) {
  try {
    const m = await state.api.tmdb(`movie/${id}`);
    const rt = resolveMovieRuntime(m);
    changeLineup((items) => items.push({
      kind: 'movie', tmdb_id: m.id, title: m.title,
      subtitle: m.release_date ? m.release_date.slice(0, 4) : 'Movie',
      poster_path: m.poster_path || null, ...rt,
    }));
    toast(`Added ${m.title} to ${weekday(state.date)}.`);
  } catch (ex) {
    toast(friendlyError(ex));
  }
}

function episodeItem(show, e) {
  return {
    kind: 'episode', tmdb_id: e.id, show_tmdb_id: show.id,
    season: e.season_number, episode: e.episode_number,
    title: show.name, subtitle: e.name,
    poster_path: show.poster_path || null,
    runtime_min: e.runtime_min, runtime_source: e.runtime_source,
  };
}

async function addNextEpisode(showId) {
  try {
    const show = await ensureShow(showId);
    const next = nextEpisodeFor(showId);
    if (!next) { toast(`No more episodes listed for ${show.name}.`); return; }
    const data = await state.api.tmdb(`tv/${showId}/season/${next.season}`);
    const eps = resolveEpisodeRuntimes(data.episodes || [], show);
    const e = eps.find((x) => x.episode_number === next.episode);
    if (!e) { toast(`TMDB doesn't list S${next.season}E${next.episode} yet.`); return; }
    changeLineup((items) => items.push(episodeItem(show, e)));
    toast(`Added ${show.name} S${next.season}E${next.episode} to ${weekday(state.date)}.`);
  } catch (ex) {
    toast(friendlyError(ex));
  }
}

async function openShow(id) {
  closeSearch();
  openDrawer({ mode: 'picker', show: { id, name: 'Loading', seasons: [] }, season: 1, episodes: [], selected: new Set(), loading: true });
  try {
    const show = await ensureShow(id);
    const prog = state.progress.get(show.id);
    const real = (show.seasons || []).filter((s) => s.season_number > 0);
    let season = real[0]?.season_number ?? 0;
    if (prog) {
      const cur = real.find((s) => s.season_number === prog.last_season);
      season = prog.last_season;
      if (cur && cur.episode_count && prog.last_episode >= cur.episode_count) {
        season = real.find((s) => s.season_number > prog.last_season)?.season_number ?? prog.last_season;
      }
    }
    if (!state.drawer || state.drawer.mode !== 'picker') return;
    state.drawer = { mode: 'picker', show, season, episodes: [], selected: new Set(), loading: true };
    await loadSeason(season);
  } catch (ex) {
    toast(friendlyError(ex));
    closeDrawer();
  }
}

async function loadSeason(n) {
  const p = state.drawer;
  p.season = n;
  p.loading = true;
  p.selected = new Set();
  renderDrawer();
  try {
    const data = await state.api.tmdb(`tv/${p.show.id}/season/${n}`);
    if (state.drawer !== p || p.season !== n) return;
    p.episodes = resolveEpisodeRuntimes(data.episodes || [], p.show);
  } catch (ex) {
    toast(friendlyError(ex));
    p.episodes = [];
  }
  p.loading = false;
  renderDrawer();
}

function addEpisodes() {
  const p = state.drawer;
  const chosen = p.episodes.filter((e) => p.selected.has(e.id));
  if (!chosen.length) return;
  changeLineup((items) => { for (const e of chosen) items.push(episodeItem(p.show, e)); });
  toast(`Added ${chosen.length} episode${chosen.length > 1 ? 's' : ''} to ${weekday(state.date)}.`);
  closeDrawer();
}

async function markProgressThrough(epId) {
  const p = state.drawer;
  const e = p.episodes.find((x) => x.id === epId);
  const entry = { show_tmdb_id: p.show.id, show_name: p.show.name, last_season: e.season_number, last_episode: e.episode_number };
  try {
    await state.api.setProgress(entry);
    state.progress.set(p.show.id, entry);
    toast(`${p.show.name}: watched through S${e.season_number}E${e.episode_number}.`);
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderDrawer();
  renderQueue();
}

function addCustom(form) {
  const f = new FormData(form);
  const minutes = Number(f.get('minutes'));
  if (!(minutes > 0)) return;
  const estimate = f.get('estimate') === 'on';
  const title = String(f.get('title')).trim();
  const preset = Object.values(PRESETS).find((x) => x.title === title);
  changeLineup((items) => items.push({
    kind: 'custom',
    title,
    subtitle: String(f.get('subtitle') || '').trim() || null,
    runtime_min: minutes,
    runtime_source: estimate ? 'custom_estimate' : 'manual',
    anchor_time: f.get('anchor') || null,
    note: estimate ? (preset?.note || 'Estimated length') : null,
  }));
  toast(`Added ${title} to ${weekday(state.date)}.`);
  closeDrawer();
}

async function postToDiscord() {
  await flushSave();
  const { title, lines } = discordSummary(shortLabel(state.date), state.night?.start_time, state.items);
  const posterPath = state.items.find((i) => i.poster_path)?.poster_path;
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <form method="dialog" class="dialog-body">
      <h2>Post this lineup to Discord?</h2>
      <div class="discord-preview">
        <p class="discord-title">${esc(title)}</p>
        ${lines.map((l) => `<p>${esc(l.replace(/\*\*/g, '').replace(/`/g, '')) || '&nbsp;'}</p>`).join('')}
      </div>
      ${state.api.demo ? '<p class="muted small">Demo mode: nothing will actually be sent.</p>' : ''}
      <div class="dialog-actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn btn-primary" value="post">Post</button>
      </div>
    </form>`;
  dlg.showModal();
  dlg.addEventListener('close', async function onClose() {
    dlg.removeEventListener('close', onClose);
    if (dlg.returnValue !== 'post') return;
    try {
      await state.api.postDiscord({ title, lines, thumbnail: posterPath ? `${IMG}w185${posterPath}` : null });
      toast('Posted to Discord.');
    } catch (ex) {
      toast(friendlyError(ex));
    }
  });
}

async function markWatched() {
  await flushSave();
  try {
    await state.api.markWatched(state.date);
    toast(`${weekday(state.date)} marked as watched. Show progress updated.`);
    await Promise.all([loadNight(state.date), loadProgress(), loadWeek()]);
  } catch (ex) {
    toast(friendlyError(ex));
  }
}

function moveItem(from, to) {
  if (to < 0 || to >= state.items.length || from === to) return;
  changeLineup((items) => {
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
  });
}

function commitRuntime(index, value) {
  state.editing = null;
  const n = Math.round(Number(value));
  if (!(n > 0 && n <= 600) || n === state.items[index]?.runtime_min) {
    renderNight();
    return;
  }
  changeLineup((items) => {
    items[index].runtime_min = n;
    items[index].runtime_source = 'manual';
    items[index].note = null;
  });
}

async function selectDate(date) {
  if (date === state.date) return;
  await flushSave();
  if (date < state.weekStart || date > addDays(state.weekStart, 6)) {
    state.weekStart = date;
    loadWeek();
  }
  await loadNight(date);
}

function focusSearch() {
  const input = $('#search-input');
  input.focus();
  input.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Event wiring (delegated)
// ---------------------------------------------------------------------------
async function handleAction(b) {
  const act = b.dataset.act;
  const i = Number(b.dataset.index);
  const id = Number(b.dataset.id);
  switch (act) {
    case 'up': moveItem(i, i - 1); break;
    case 'down': moveItem(i, i + 1); break;
    case 'remove': changeLineup((items) => items.splice(i, 1)); break;
    case 'edit-runtime': state.editing = { index: i }; renderNight(); break;
    case 'discord': postToDiscord(); break;
    case 'watched': markWatched(); break;
    case 'focus-search': focusSearch(); break;
    case 'open-custom': openDrawer({ mode: 'custom', form: defaultCustom() }); break;
    case 'add-movie': closeSearch(); addMovie(id); break;
    case 'add-next': addNextEpisode(id); break;
    case 'open-show': openShow(id); break;
    case 'close-drawer': closeDrawer(); break;
    case 'season': loadSeason(Number(b.dataset.season)); break;
    case 'add-episodes': addEpisodes(); break;
    case 'set-progress': markProgressThrough(id); break;
    case 'next-n': {
      const p = state.drawer;
      const nexts = nextUnwatched(p.episodes, state.progress.get(p.show.id)).slice(0, Number(b.dataset.n));
      p.selected = new Set(nexts.map((x) => x.id));
      renderDrawer();
      if (!nexts.length) toast('Everything in this season is watched. Try the next season.');
      break;
    }
    case 'preset':
      state.drawer.form = { ...PRESETS[b.dataset.preset], subtitle: state.drawer.form?.subtitle || '' };
      renderDrawer();
      break;
    case 'queue-add': {
      const d = b.dataset;
      try {
        await state.api.addToQueue({ kind: d.kind, tmdb_id: Number(d.id), title: d.title, year: d.year || null, poster_path: d.poster || null });
        toast(`Saved ${d.title} to the queue.`);
        await loadQueue();
      } catch (ex) { toast(friendlyError(ex)); }
      break;
    }
    case 'queue-remove':
      try {
        await state.api.removeFromQueue(b.dataset.id);
        await loadQueue();
      } catch (ex) { toast(friendlyError(ex)); }
      break;
    default: break;
  }
}

function wireEvents() {
  document.addEventListener('click', (e) => {
    const day = e.target.closest('[data-date]');
    if (day) { selectDate(day.dataset.date); return; }
    const step = e.target.closest('[data-step]');
    if (step) {
      state.weekStart = addDays(state.weekStart, Number(step.dataset.step));
      loadWeek();
      return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) { state.queueFilter = filter.dataset.filter; renderQueue(); return; }
    if (state.search.open && !e.target.closest('.search-wrap')) closeSearch();
    const b = e.target.closest('[data-act]');
    if (b && !b.matches('input')) handleAction(b);
  });

  const input = $('#search-input');
  input.addEventListener('input', () => onSearchInput(input.value));
  input.addEventListener('focus', () => { if (input.value.trim()) { state.search.open = true; renderSearch(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) {
      e.preventDefault();
      focusSearch();
    }
    if (e.key === 'Escape' && state.search.open) closeSearch();
  });

  const night = $('#night');
  night.addEventListener('change', (e) => {
    if (e.target.id === 'start-time') setStartTime(e.target.value);
    if (e.target.dataset.act === 'anchor') {
      const i = Number(e.target.dataset.index);
      const v = e.target.value || null;
      changeLineup((items) => { items[i].anchor_time = v; });
    }
  });
  night.addEventListener('keydown', (e) => {
    if (e.target.dataset.act !== 'runtime-input') return;
    if (e.key === 'Enter') commitRuntime(Number(e.target.dataset.index), e.target.value);
    if (e.key === 'Escape') { state.editing = null; renderNight(); }
  });
  night.addEventListener('focusout', (e) => {
    if (e.target.dataset.act === 'runtime-input' && state.editing) {
      commitRuntime(Number(e.target.dataset.index), e.target.value);
    }
  });

  // Drag to reorder rows
  night.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.row');
    if (!li) return;
    state.dragFrom = Number(li.dataset.index);
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.index);
  });
  night.addEventListener('dragover', (e) => {
    const li = e.target.closest('.row');
    if (!li || state.dragFrom == null) return;
    e.preventDefault();
    night.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  night.addEventListener('drop', (e) => {
    const li = e.target.closest('.row');
    if (!li || state.dragFrom == null) return;
    e.preventDefault();
    let to = Number(li.dataset.index);
    if (li.classList.contains('drop-after')) to += 1;
    if (state.dragFrom < to) to -= 1;
    const from = state.dragFrom;
    state.dragFrom = null;
    moveItem(from, to);
  });
  night.addEventListener('dragend', () => {
    state.dragFrom = null;
    night.querySelectorAll('.is-dragging, .drop-before, .drop-after')
      .forEach((x) => x.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  });

  const drawer = $('#drawer');
  drawer.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'pick-ep') {
      const sel = state.drawer.selected;
      const id = Number(e.target.dataset.id);
      if (e.target.checked) sel.add(id); else sel.delete(id);
      renderDrawer();
    }
  });
  drawer.addEventListener('input', (e) => {
    const form = e.target.closest('#custom-form');
    if (form && state.drawer?.mode === 'custom') {
      const f = new FormData(form);
      state.drawer.form = {
        title: f.get('title'), subtitle: f.get('subtitle'), anchor: f.get('anchor'),
        minutes: f.get('minutes'), estimate: f.get('estimate') === 'on',
      };
    }
  });
  drawer.addEventListener('submit', (e) => {
    if (e.target.id === 'custom-form') { e.preventDefault(); addCustom(e.target); }
  });
  drawer.addEventListener('close', () => { state.drawer = null; });
  drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });

  window.addEventListener('beforeunload', (e) => {
    if (state.saveTimer || state.saving) e.preventDefault();
  });
}

boot().catch((ex) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="form-error boot-error">${esc(friendlyError(ex))}</p>`);
});
