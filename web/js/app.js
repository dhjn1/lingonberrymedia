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
const dayName = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'long' });
const monthDay = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
const shortLabel = (iso) => dateFromIso(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function thumb(title, posterPath, size = 'w92') {
  if (posterPath) {
    return `<img class="thumb" src="${IMG}${size}${esc(posterPath)}" alt="" loading="lazy">`;
  }
  const initials = String(title || '?').replace(/^(the|a|an)\s+/i, '').split(/\s+/).slice(0, 2)
    .map((w) => w[0] || '').join('').toUpperCase();
  return `<span class="thumb thumb-tile tone-${hash(title) % 4}" aria-hidden="true">${esc(initials)}</span>`;
}

/** "~9:53" over a small "PM", so the time rail stays narrow on phones. */
function railClock(min, estimated) {
  const [clock, ampm] = formatClock(min).split(' ');
  return `<span class="clock">${estimated ? '~' : ''}${clock}</span><span class="ampm">${ampm}</span>`;
}

function isGame(item) {
  return item.kind === 'custom' && /\bNFL\b|football|game/i.test(`${item.title} ${item.subtitle || ''}`);
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
  progress: new Map(), // show id -> progress
  tab: 'search',
  search: { q: '', results: [], loading: false },
  picker: null, // { show, season, episodes, selected:Set }
  custom: null,
  editing: null, // { index, field }
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
      ? 'That email and password don\'t match. Check them and try again.'
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
  renderPanel();
  await Promise.all([loadNight(state.date), loadWeek(), loadQueue(), loadProgress()]);
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
  if (state.tab === 'queue' && !state.picker) renderPanel();
  const tab = $('[data-tab=queue]');
  if (tab) tab.textContent = `Queue${state.queue.length ? ` (${state.queue.length})` : ''}`;
}

async function loadProgress() {
  try {
    const rows = await state.api.listProgress();
    state.progress = new Map(rows.map((p) => [p.show_tmdb_id, p]));
  } catch (ex) {
    toast(friendlyError(ex));
  }
  if (state.picker || state.tab === 'queue') renderPanel();
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
    if (date === state.date) {
      state.night = { ...(state.night || { watched_at: null }), version };
    }
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
// Week strip
// ---------------------------------------------------------------------------
function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const t = today();
  const chips = days.map((d) => {
    const s = state.week.get(d);
    const date = dateFromIso(d);
    const wk = date.toLocaleDateString('en-US', { weekday: 'short' });
    const meta = s && s.count
      ? `${s.estimated ? '~' : ''}${formatDuration(s.total)}`
      : 'Open';
    return `
      <button class="day ${d === state.date ? 'is-current' : ''} ${d === t ? 'is-today' : ''} ${s?.count ? 'has-plan' : ''}"
              type="button" data-date="${d}" aria-pressed="${d === state.date}"
              aria-label="${esc(shortLabel(d))}${d === t ? ', today' : ''}: ${esc(meta)}${s?.game ? ', game night' : ''}">
        <span class="day-name">${wk}</span>
        <span class="day-num">${date.getDate()}</span>
        <span class="day-meta">${esc(meta)}</span>
        ${s?.game ? '<span class="day-flag" title="Game night">Game</span>' : ''}
        ${s?.watched ? '<span class="day-flag day-flag-done" title="Watched">Watched</span>' : ''}
      </button>`;
  }).join('');
  $('#week').innerHTML = `
    <button class="week-step" type="button" data-step="-7" aria-label="Previous week">&lsaquo;</button>
    <div class="days">${chips}</div>
    <button class="week-step" type="button" data-step="7" aria-label="Next week">&rsaquo;</button>
    <label class="week-jump">
      <span class="sr-only">Jump to date</span>
      <input type="date" value="${state.date}" aria-label="Jump to date">
    </label>`;
}

// ---------------------------------------------------------------------------
// Night board
// ---------------------------------------------------------------------------
function renderNight() {
  const night = state.night;
  const s = computeSchedule(night?.start_time, state.items);
  const editing = state.editing;

  const rows = [];
  s.rows.forEach((r, i) => {
    const it = r.item;
    if (r.gap > 0) rows.push(`<li class="interval">${formatDuration(r.gap)} free before kickoff</li>`);
    if (r.overlap > 0) {
      rows.push(`<li class="interval interval-clash" role="alert">The lineup runs ${formatDuration(r.overlap)} past kickoff</li>`);
    }

    const time = r.start != null ? railClock(r.start, r.startEstimated) : '';
    const rail = r.anchored
      ? `<label class="rail-anchor"><span>Kickoff</span>
           <input type="time" value="${esc(toTimeString(parseTime(it.anchor_time)))}" data-act="anchor" data-index="${i}"
                  aria-label="Kickoff time for ${esc(it.title)}"></label>`
      : `<time class="rail-time">${time}</time>`;

    const sub = it.kind === 'episode'
      ? `<span class="code">S${it.season}E${it.episode}</span> ${esc(it.subtitle || '')}`
      : esc(it.subtitle || (it.kind === 'movie' ? 'Movie' : ''));

    const runtimeLabel = `${r.itemEstimated ? '~' : ''}${formatDuration(it.runtime_min)}`;
    const note = footnoteText(it);
    const runtime = editing && editing.index === i
      ? `<input class="runtime-input" type="number" min="1" max="600" inputmode="numeric"
                value="${it.runtime_min}" data-act="runtime-input" data-index="${i}"
                aria-label="Runtime in minutes for ${esc(it.title)}">`
      : `<button class="runtime" type="button" data-act="edit-runtime" data-index="${i}"
                 title="${esc(note ? `${note}. Click to set the exact length.` : 'Click to correct the length')}">
           ${runtimeLabel}${r.mark ? `<sup>${r.mark}</sup>` : ''}${r.edited ? '<span class="edited">edited</span>' : ''}
         </button>`;

    rows.push(`
      <li class="slot ${r.anchored ? 'slot-anchored' : ''} ${isGame(it) ? 'slot-game' : ''}"
          data-index="${i}" draggable="true" style="--mins:${it.runtime_min}">
        <div class="rail">${rail}</div>
        <div class="card">
          <span class="grip" aria-hidden="true"></span>
          ${thumb(it.kind === 'episode' ? it.title : it.title, it.poster_path)}
          <div class="card-body">
            <p class="card-title">${esc(it.title)}</p>
            <p class="card-sub">${sub}</p>
          </div>
          ${runtime}
          <div class="card-tools">
            <button type="button" class="icon-btn" data-act="up" data-index="${i}" ${i === 0 ? 'disabled' : ''}
                    aria-label="Move ${esc(it.title)} earlier">&uarr;</button>
            <button type="button" class="icon-btn" data-act="down" data-index="${i}" ${i === s.rows.length - 1 ? 'disabled' : ''}
                    aria-label="Move ${esc(it.title)} later">&darr;</button>
            <button type="button" class="icon-btn icon-remove" data-act="remove" data-index="${i}"
                    aria-label="Remove ${esc(it.title)}">&times;</button>
          </div>
        </div>
      </li>`);
  });

  if (s.rows.length && s.end != null) {
    rows.push(`<li class="finish"><time class="rail-time">${railClock(s.end, s.endEstimated)}</time><span>Done for the night</span></li>`);
  }

  const startVal = night?.start_time ? toTimeString(parseTime(night.start_time)) : '';
  const ends = s.end != null ? `${s.endEstimated ? '~' : ''}${formatClock(s.end)}` : 'Set a start time';
  const total = s.rows.length ? `${s.totalEstimated ? '~' : ''}${formatDuration(s.total)}` : 'Nothing yet';

  $('#night').innerHTML = `
    <header class="night-head">
      <h2 class="night-title">
        <span class="night-day">${esc(dayName(state.date))}</span>
        <span class="night-date">${esc(monthDay(state.date))}${state.date === today() ? ', tonight' : ''}</span>
      </h2>
      <div class="night-stats">
        <label class="stat stat-start">
          <span class="stat-label">Starts</span>
          <input type="time" id="start-time" value="${startVal}" aria-label="Start time">
        </label>
        <div class="stat">
          <span class="stat-label">Ends</span>
          <span class="stat-value">${esc(ends)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Runtime</span>
          <span class="stat-value">${esc(total)}</span>
        </div>
      </div>
      ${night?.watched_at ? '<p class="watched-note">Marked as watched. Episodes from this night count toward show progress.</p>' : ''}
    </header>
    ${s.rows.length ? `<ol class="guide">${rows.join('')}</ol>` : `
      <div class="empty">
        <p class="empty-title">Nothing planned for ${esc(dayName(state.date))} yet.</p>
        <p>Search for a movie or show, pick from the queue, or add a game.</p>
      </div>`}
    ${s.footnotes.length ? `<div class="footnotes">${s.footnotes.map((f) => `<p><sup>${f.mark}</sup> ${esc(f.text)}</p>`).join('')}</div>` : ''}
    ${s.rows.length ? `
      <div class="night-actions">
        <button type="button" class="btn btn-primary" data-act="discord">Post to Discord</button>
        <button type="button" class="btn" data-act="watched" ${night?.watched_at ? 'disabled' : ''}>
          ${night?.watched_at ? 'Watched' : 'Mark night as watched'}
        </button>
      </div>` : ''}`;

  if (editing) {
    const input = $('.runtime-input');
    if (input) { input.focus(); input.select(); }
  }
}

// ---------------------------------------------------------------------------
// Side panel: search, queue, games
// ---------------------------------------------------------------------------
function renderPanel() {
  const panel = $('#panel');
  if (state.picker) {
    panel.innerHTML = pickerHtml();
    return;
  }
  const tabs = [['search', 'Search'], ['queue', `Queue${state.queue.length ? ` (${state.queue.length})` : ''}`], ['custom', 'Game or block']];
  let body = '';
  if (state.tab === 'search') body = searchHtml();
  if (state.tab === 'queue') body = queueHtml();
  if (state.tab === 'custom') body = customHtml();
  panel.innerHTML = `
    <div class="tabs" role="tablist">
      ${tabs.map(([id, label]) => `
        <button type="button" role="tab" class="tab ${state.tab === id ? 'is-current' : ''}"
                aria-selected="${state.tab === id}" data-tab="${id}">${esc(label)}</button>`).join('')}
    </div>
    <div class="panel-body">${body}</div>`;
  if (state.tab === 'search' && state.focusSearch) {
    state.focusSearch = false;
    const input = $('#search-input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function searchHtml() {
  const { q, results, loading } = state.search;
  let list = '';
  if (loading) list = '<p class="hint">Searching&hellip;</p>';
  else if (q && results.length === 0) list = `<p class="hint">No movies or shows match "${esc(q)}".</p>`;
  else if (!q) list = '<p class="hint">Type a title. Shows open an episode picker; movies add with their real runtime.</p>';
  else {
    list = `<ul class="results">${results.map((r) => {
      const isTv = r.media_type === 'tv';
      const title = isTv ? r.name : r.title;
      const year = (isTv ? r.first_air_date : r.release_date || '').slice(0, 4);
      return `
        <li class="result">
          ${thumb(title, r.poster_path)}
          <div class="result-body">
            <p class="result-title">${esc(title)}</p>
            <p class="result-meta">${isTv ? 'Series' : 'Movie'}${year ? `, ${year}` : ''}</p>
          </div>
          <div class="result-actions">
            ${isTv
              ? `<button type="button" class="btn btn-small btn-primary" data-act="open-show" data-id="${r.id}">Episodes</button>`
              : `<button type="button" class="btn btn-small btn-primary" data-act="add-movie" data-id="${r.id}">Add</button>`}
            <button type="button" class="btn btn-small" data-act="queue-add" data-id="${r.id}" data-kind="${isTv ? 'tv' : 'movie'}"
                    data-title="${esc(title)}" data-year="${esc(year)}" data-poster="${esc(r.poster_path || '')}">Queue</button>
          </div>
        </li>`;
    }).join('')}</ul>`;
  }
  return `
    <form class="search" data-act="search-form" role="search">
      <label class="sr-only" for="search-input">Search movies and shows</label>
      <input id="search-input" type="search" placeholder="Search movies and shows" value="${esc(q)}" autocomplete="off">
    </form>
    ${list}`;
}

function queueHtml() {
  if (!state.queue.length) {
    return '<p class="hint">The queue is for things you both want to get to. Use Queue on any search result to save it here.</p>';
  }
  return `<ul class="results">${state.queue.map((q) => {
    const p = q.kind === 'tv' ? state.progress.get(q.tmdb_id) : null;
    const meta = q.kind === 'tv'
      ? (p ? `Series, last watched S${p.last_season}E${p.last_episode}` : 'Series, not started')
      : `Movie${q.year ? `, ${q.year}` : ''}`;
    return `
      <li class="result">
        ${thumb(q.title, q.poster_path)}
        <div class="result-body">
          <p class="result-title">${esc(q.title)}</p>
          <p class="result-meta">${esc(meta)}</p>
        </div>
        <div class="result-actions">
          ${q.kind === 'tv'
            ? `<button type="button" class="btn btn-small btn-primary" data-act="open-show" data-id="${q.tmdb_id}">Episodes</button>`
            : `<button type="button" class="btn btn-small btn-primary" data-act="add-movie" data-id="${q.tmdb_id}">Add</button>`}
          <button type="button" class="btn btn-small" data-act="queue-remove" data-id="${q.id}"
                  aria-label="Remove ${esc(q.title)} from the queue">Remove</button>
        </div>
      </li>`;
  }).join('')}</ul>`;
}

const PRESETS = {
  mnf: { title: 'NFL: Monday Night Football', anchor: '19:15', minutes: 195, estimate: true, note: NFL_NOTE },
  tnf: { title: 'NFL: Thursday Night Football', anchor: '19:15', minutes: 195, estimate: true, note: NFL_NOTE },
  snf: { title: 'NFL: Sunday Night Football', anchor: '19:20', minutes: 195, estimate: true, note: NFL_NOTE },
};

function customHtml() {
  const c = state.custom || defaultCustom();
  return `
    <div class="presets">
      <button type="button" class="btn btn-small" data-act="preset" data-preset="mnf">Monday night game</button>
      <button type="button" class="btn btn-small" data-act="preset" data-preset="tnf">Thursday night game</button>
      <button type="button" class="btn btn-small" data-act="preset" data-preset="snf">Sunday night game</button>
    </div>
    <form class="custom-form" data-act="custom-form">
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
      <p class="hint">A fixed start time pins the block in place, like a kickoff. Everything before it is checked against it; everything after starts when it ends.</p>
      <button type="submit" class="btn btn-primary">Add to ${esc(dayName(state.date))}</button>
    </form>`;
}

function defaultCustom() {
  const dow = dateFromIso(state.date).getDay();
  if (dow === 1) return { ...PRESETS.mnf, subtitle: '' };
  if (dow === 4) return { ...PRESETS.tnf, subtitle: '' };
  return { title: '', subtitle: '', anchor: '', minutes: 60, estimate: false, note: '' };
}

function pickerHtml() {
  const p = state.picker;
  const prog = state.progress.get(p.show.id);
  const seasons = (p.show.seasons || []).filter((s) => s.season_number > 0)
    .concat((p.show.seasons || []).filter((s) => s.season_number === 0));
  let list = '<p class="hint">Loading episodes&hellip;</p>';
  if (!p.loading) {
    const next = new Set(nextUnwatched(p.episodes, prog).slice(0, 1).map((e) => e.id));
    list = p.episodes.length ? `<ul class="episodes">${p.episodes.map((e) => {
      const watched = isWatched(e, prog);
      const est = isEstimate(e.runtime_source);
      const note = footnoteText({ runtime_source: e.runtime_source, runtime_min: e.runtime_min });
      return `
        <li class="episode ${watched ? 'is-watched' : ''} ${next.has(e.id) ? 'is-next' : ''}">
          <label class="episode-pick">
            <input type="checkbox" data-act="pick-ep" data-id="${e.id}" ${p.selected.has(e.id) ? 'checked' : ''}>
            <span class="episode-num">E${e.episode_number}</span>
            <span class="episode-name">${esc(e.name)}${next.has(e.id) ? ' <em class="next-tag">Next up</em>' : ''}${watched ? ' <span class="watched-tag">Watched</span>' : ''}</span>
            <span class="episode-runtime" ${note ? `title="${esc(note)}"` : ''}>${est ? '~' : ''}${formatDuration(e.runtime_min)}${est ? '<sup>*</sup>' : ''}</span>
          </label>
          <button type="button" class="link-btn" data-act="set-progress" data-id="${e.id}"
                  aria-label="Mark everything through E${e.episode_number} as watched">Watched through here</button>
        </li>`;
    }).join('')}</ul>` : '<p class="hint">TMDB has no episodes listed for this season.</p>';
  }
  const anyEst = !p.loading && p.episodes.some((e) => isEstimate(e.runtime_source));
  const chosen = p.episodes.filter((e) => p.selected.has(e.id));
  const mins = chosen.reduce((s, e) => s + e.runtime_min, 0);
  const chosenEst = chosen.some((e) => isEstimate(e.runtime_source));
  return `
    <div class="picker">
      <button type="button" class="link-btn back" data-act="close-picker">Back</button>
      <div class="picker-head">
        ${thumb(p.show.name, p.show.poster_path, 'w154')}
        <div>
          <h3 class="picker-title">${esc(p.show.name)}</h3>
          <p class="result-meta">${prog ? `Last watched S${prog.last_season}E${prog.last_episode}` : 'Not started'}</p>
        </div>
      </div>
      <div class="season-tabs" role="tablist" aria-label="Seasons">
        ${seasons.map((s) => `
          <button type="button" role="tab" class="season ${s.season_number === p.season ? 'is-current' : ''}"
                  aria-selected="${s.season_number === p.season}" data-act="season" data-season="${s.season_number}">
            ${s.season_number === 0 ? 'Specials' : `S${s.season_number}`}</button>`).join('')}
      </div>
      ${p.loading ? '' : `
      <div class="quick-picks">
        <span>Select next</span>
        ${[1, 2, 3].map((n) => `<button type="button" class="btn btn-small" data-act="next-n" data-n="${n}">${n}</button>`).join('')}
      </div>`}
      ${list}
      ${anyEst ? '<p class="footnote-inline"><sup>*</sup> TMDB has no runtime for these; hover for how each was estimated.</p>' : ''}
      <div class="picker-foot">
        <span>${chosen.length ? `${chosen.length} selected, ${chosenEst ? '~' : ''}${formatDuration(mins)}` : 'Nothing selected'}</span>
        <button type="button" class="btn btn-primary" data-act="add-episodes" ${chosen.length ? '' : 'disabled'}>
          Add to ${esc(dayName(state.date))}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
let searchTimer;
function onSearchInput(q) {
  state.search.q = q;
  clearTimeout(searchTimer);
  if (!q.trim()) {
    state.search.results = [];
    state.search.loading = false;
    state.focusSearch = true;
    renderPanel();
    return;
  }
  searchTimer = setTimeout(async () => {
    state.search.loading = true;
    state.focusSearch = true;
    renderPanel();
    try {
      const data = await state.api.tmdb('search/multi', { query: q });
      if (state.search.q !== q) return;
      state.search.results = (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 12);
    } catch (ex) {
      toast(friendlyError(ex));
      state.search.results = [];
    }
    state.search.loading = false;
    state.focusSearch = true;
    renderPanel();
  }, 350);
}

async function addMovie(id) {
  try {
    const m = await state.api.tmdb(`movie/${id}`);
    const rt = resolveMovieRuntime(m);
    changeLineup((items) => items.push({
      kind: 'movie', tmdb_id: m.id, title: m.title,
      subtitle: m.release_date ? m.release_date.slice(0, 4) : 'Movie',
      poster_path: m.poster_path || null, ...rt,
    }));
    toast(`Added ${m.title} to ${dayName(state.date)}.`);
  } catch (ex) {
    toast(friendlyError(ex));
  }
}

async function openShow(id) {
  state.picker = { show: { id, name: 'Loading', seasons: [] }, season: 1, episodes: [], selected: new Set(), loading: true };
  renderPanel();
  try {
    const show = await state.api.tmdb(`tv/${id}`);
    const prog = state.progress.get(show.id);
    const real = (show.seasons || []).filter((s) => s.season_number > 0);
    let season = real[0]?.season_number ?? 0;
    if (prog) {
      // Open where you left off: the progress season, or the next one if it's finished
      const cur = real.find((s) => s.season_number === prog.last_season);
      season = prog.last_season;
      if (cur && cur.episode_count && prog.last_episode >= cur.episode_count) {
        season = real.find((s) => s.season_number > prog.last_season)?.season_number ?? prog.last_season;
      }
    }
    state.picker = { show, season, episodes: [], selected: new Set(), loading: true };
    await loadSeason(season);
  } catch (ex) {
    toast(friendlyError(ex));
    state.picker = null;
    renderPanel();
  }
}

async function loadSeason(n) {
  const p = state.picker;
  p.season = n;
  p.loading = true;
  p.selected = new Set();
  renderPanel();
  try {
    const data = await state.api.tmdb(`tv/${p.show.id}/season/${n}`);
    if (state.picker !== p || p.season !== n) return;
    p.episodes = resolveEpisodeRuntimes(data.episodes || [], p.show);
  } catch (ex) {
    toast(friendlyError(ex));
    p.episodes = [];
  }
  p.loading = false;
  renderPanel();
}

function addEpisodes() {
  const p = state.picker;
  const chosen = p.episodes.filter((e) => p.selected.has(e.id));
  if (!chosen.length) return;
  changeLineup((items) => {
    for (const e of chosen) {
      items.push({
        kind: 'episode', tmdb_id: e.id, show_tmdb_id: p.show.id,
        season: e.season_number, episode: e.episode_number,
        title: p.show.name, subtitle: e.name,
        poster_path: p.show.poster_path || null,
        runtime_min: e.runtime_min, runtime_source: e.runtime_source,
      });
    }
  });
  toast(`Added ${chosen.length} episode${chosen.length > 1 ? 's' : ''} to ${dayName(state.date)}.`);
  p.selected = new Set();
  renderPanel();
}

async function markProgressThrough(epId) {
  const p = state.picker;
  const e = p.episodes.find((x) => x.id === epId);
  const entry = { show_tmdb_id: p.show.id, show_name: p.show.name, last_season: e.season_number, last_episode: e.episode_number };
  try {
    await state.api.setProgress(entry);
    state.progress.set(p.show.id, entry);
    toast(`${p.show.name}: watched through S${e.season_number}E${e.episode_number}.`);
  } catch (ex) {
    toast(friendlyError(ex));
  }
  renderPanel();
}

function addCustom(form) {
  const f = new FormData(form);
  const minutes = Number(f.get('minutes'));
  if (!(minutes > 0)) return;
  const estimate = f.get('estimate') === 'on';
  const title = String(f.get('title')).trim();
  const preset = Object.values(PRESETS).find((x) => x.title === title);
  changeLineup((items) => {
    const item = {
      kind: 'custom',
      title,
      subtitle: String(f.get('subtitle') || '').trim() || null,
      runtime_min: minutes,
      runtime_source: estimate ? 'custom_estimate' : 'manual',
      anchor_time: f.get('anchor') || null,
      note: estimate ? (preset?.note || 'Estimated length') : null,
    };
    // Keep anchored blocks in time order relative to other anchored blocks
    items.push(item);
  });
  toast(`Added ${title} to ${dayName(state.date)}.`);
  state.custom = null;
  renderPanel();
}

async function postToDiscord() {
  await flushSave();
  const { title, lines } = discordSummary(shortLabel(state.date), state.night?.start_time, state.items);
  const poster = state.items.find((i) => i.poster_path)?.poster_path;
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <form method="dialog" class="dialog-body">
      <h3>Post this lineup to Discord?</h3>
      <div class="discord-preview">
        <p class="discord-title">${esc(title)}</p>
        ${lines.map((l) => `<p>${esc(l.replace(/\*\*/g, '').replace(/`/g, '')) || '&nbsp;'}</p>`).join('')}
      </div>
      ${state.api.demo ? '<p class="hint">Demo mode: nothing will actually be sent.</p>' : ''}
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
      await state.api.postDiscord({ title, lines, thumbnail: poster ? `${IMG}w185${poster}` : null });
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
    toast(`${dayName(state.date)} marked as watched. Show progress updated.`);
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
  state.custom = null;
  if (state.tab === 'custom' && !state.picker) renderPanel();
  await loadNight(date);
  if (!state.picker) renderPanel(); // button labels name the day
}

// ---------------------------------------------------------------------------
// Event wiring (delegated)
// ---------------------------------------------------------------------------
function wireEvents() {
  const week = $('#week');
  week.addEventListener('click', (e) => {
    const day = e.target.closest('[data-date]');
    if (day) selectDate(day.dataset.date);
    const step = e.target.closest('[data-step]');
    if (step) {
      state.weekStart = addDays(state.weekStart, Number(step.dataset.step));
      loadWeek();
    }
  });
  week.addEventListener('change', (e) => {
    if (e.target.type === 'date' && e.target.value) selectDate(e.target.value);
  });

  const night = $('#night');
  night.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = Number(b.dataset.index);
    switch (b.dataset.act) {
      case 'up': moveItem(i, i - 1); break;
      case 'down': moveItem(i, i + 1); break;
      case 'remove': changeLineup((items) => items.splice(i, 1)); break;
      case 'edit-runtime': state.editing = { index: i }; renderNight(); break;
      case 'discord': postToDiscord(); break;
      case 'watched': markWatched(); break;
      default: break;
    }
  });
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

  // Drag to reorder
  night.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.slot');
    if (!li) return;
    state.dragFrom = Number(li.dataset.index);
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.index);
  });
  night.addEventListener('dragover', (e) => {
    const li = e.target.closest('.slot');
    if (!li || state.dragFrom == null) return;
    e.preventDefault();
    night.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  night.addEventListener('drop', (e) => {
    const li = e.target.closest('.slot');
    if (!li || state.dragFrom == null) return;
    e.preventDefault();
    let to = Number(li.dataset.index);
    const after = li.classList.contains('drop-after');
    if (after) to += 1;
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

  const panel = $('#panel');
  panel.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      if (state.tab === 'search') state.focusSearch = true;
      renderPanel();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    switch (b.dataset.act) {
      case 'add-movie': addMovie(id); break;
      case 'open-show': openShow(id); break;
      case 'close-picker': state.picker = null; renderPanel(); break;
      case 'season': loadSeason(Number(b.dataset.season)); break;
      case 'add-episodes': addEpisodes(); break;
      case 'set-progress': markProgressThrough(id); break;
      case 'next-n': {
        const p = state.picker;
        const nexts = nextUnwatched(p.episodes, state.progress.get(p.show.id)).slice(0, Number(b.dataset.n));
        p.selected = new Set(nexts.map((x) => x.id));
        renderPanel();
        if (!nexts.length) toast('Everything in this season is watched. Try the next season.');
        break;
      }
      case 'preset': {
        state.custom = { ...PRESETS[b.dataset.preset], subtitle: state.custom?.subtitle || '' };
        renderPanel();
        break;
      }
      case 'queue-add': {
        const d = b.dataset;
        try {
          await state.api.addToQueue({ kind: d.kind, tmdb_id: Number(d.id), title: d.title, year: d.year || null, poster_path: d.poster || null });
          toast(`Saved ${d.title} to the queue.`);
          await loadQueue();
          renderPanel();
        } catch (ex) { toast(friendlyError(ex)); }
        break;
      }
      case 'queue-remove':
        try {
          await state.api.removeFromQueue(b.dataset.id);
          await loadQueue();
          renderPanel();
        } catch (ex) { toast(friendlyError(ex)); }
        break;
      default: break;
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'pick-ep') {
      const sel = state.picker.selected;
      const id = Number(e.target.dataset.id);
      if (e.target.checked) sel.add(id); else sel.delete(id);
      renderPanel();
    }
  });
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'search-input') onSearchInput(e.target.value);
    const form = e.target.closest('[data-act="custom-form"]');
    if (form) {
      const f = new FormData(form);
      state.custom = {
        title: f.get('title'), subtitle: f.get('subtitle'), anchor: f.get('anchor'),
        minutes: f.get('minutes'), estimate: f.get('estimate') === 'on',
      };
    }
  });
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.dataset.act === 'custom-form') addCustom(e.target);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.saveTimer || state.saving) e.preventDefault();
  });
}

boot().catch((ex) => {
  document.body.insertAdjacentHTML('afterbegin', `<p class="form-error boot-error">${esc(friendlyError(ex))}</p>`);
});
