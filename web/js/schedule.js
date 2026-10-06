// Pure scheduling and runtime logic. No DOM, no network: unit-tested in tests/.

export const ESTIMATE_SOURCES = new Set(['season_median', 'show_typical', 'default', 'custom_estimate']);
export const DEFAULT_EPISODE_MIN = 30;
export const DEFAULT_MOVIE_MIN = 120;

export function isEstimate(source) {
  return ESTIMATE_SOURCES.has(source);
}

export function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/** "19:15" or "19:15:00" -> 1155. Empty -> null. */
export function parseTime(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 1155 -> "19:15" (for <input type=time> and the database). */
export function toTimeString(min) {
  if (min == null) return null;
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 1155 -> "7:15 PM". Wraps past midnight. */
export function formatClock(min) {
  if (min == null) return '';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** 108 -> "1h 48m", 45 -> "45m", 120 -> "2h". */
export function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Footnote text for an item whose runtime is not straight from TMDB. */
export function footnoteText(item) {
  switch (item.runtime_source) {
    case 'season_median':
      return 'Estimated from other episodes in this season';
    case 'show_typical':
      return "Estimated from the show's typical episode length";
    case 'default':
      return `No runtime listed on TMDB; assumed ${item.runtime_min} min`;
    case 'custom_estimate':
      return item.note || 'Estimated length';
    default:
      return null;
  }
}

/**
 * Fill in runtimes for a season's episodes, recording where each one came from.
 * Chain: TMDB episode runtime -> median of this season -> show's typical length -> default.
 */
export function resolveEpisodeRuntimes(episodes, show = {}) {
  const seasonMedian = median(episodes.map((e) => e.runtime));
  const showTypical =
    median(show.episode_run_time || []) ??
    (show.last_episode_to_air && show.last_episode_to_air.runtime > 0
      ? show.last_episode_to_air.runtime
      : null);

  return episodes.map((e) => {
    if (e.runtime > 0) return { ...e, runtime_min: e.runtime, runtime_source: 'tmdb' };
    if (seasonMedian) return { ...e, runtime_min: seasonMedian, runtime_source: 'season_median' };
    if (showTypical) return { ...e, runtime_min: showTypical, runtime_source: 'show_typical' };
    return { ...e, runtime_min: DEFAULT_EPISODE_MIN, runtime_source: 'default' };
  });
}

export function resolveMovieRuntime(movie) {
  if (movie.runtime > 0) return { runtime_min: movie.runtime, runtime_source: 'tmdb' };
  return { runtime_min: DEFAULT_MOVIE_MIN, runtime_source: 'default' };
}

/**
 * Lay out a night. Items flow back to back from the start time, except
 * anchored items (NFL kickoff), which start at their anchor no matter what.
 * Works with no start time: rows before the first anchor just have no clock.
 *
 * Returns rows with start/end (minutes, may exceed 1440 past midnight),
 * gap/overlap before anchored items, estimate flags, and numbered footnotes.
 */
export function computeSchedule(startTime, items) {
  const startMin = parseTime(startTime);
  let cursor = startMin;
  let cursorEstimated = false;
  const rows = [];
  const footnotes = [];
  const noteIndex = new Map();

  for (const item of items) {
    const runtime = Number(item.runtime_min) || 0;
    let anchor = parseTime(item.anchor_time);
    let start = cursor;
    let startEstimated = cursorEstimated;
    let gap = 0;
    let overlap = 0;

    if (anchor != null) {
      // Keep the anchor on the same night as the start time (a 12:30 AM
      // kickoff after a 7 PM start belongs to the following morning).
      const ref = startMin ?? anchor;
      while (anchor < ref - 360) anchor += 1440;
      if (cursor != null) {
        if (cursor > anchor) overlap = cursor - anchor;
        else gap = anchor - cursor;
      }
      start = anchor;
      startEstimated = false; // kickoff is a fixed time
    }

    const itemEstimated = isEstimate(item.runtime_source);
    const end = start == null ? null : start + runtime;
    const endEstimated = startEstimated || itemEstimated;

    let mark = null;
    const text = footnoteText(item);
    if (text) {
      if (!noteIndex.has(text)) {
        noteIndex.set(text, footnotes.length + 1);
        footnotes.push({ mark: footnotes.length + 1, text });
      }
      mark = noteIndex.get(text);
    }

    rows.push({
      item,
      start,
      end,
      startEstimated,
      endEstimated,
      itemEstimated,
      anchored: anchor != null,
      gap,
      overlap,
      mark,
      edited: item.runtime_source === 'manual',
    });

    cursor = end;
    cursorEstimated = endEstimated;
  }

  const total = items.reduce((s, i) => s + (Number(i.runtime_min) || 0), 0);
  const last = rows[rows.length - 1];
  return {
    rows,
    total,
    totalEstimated: rows.some((r) => r.itemEstimated),
    end: last ? last.end : null,
    endEstimated: last ? last.endEstimated : false,
    footnotes,
  };
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

export function dateFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Episodes after the last watched one, in order. */
export function nextUnwatched(episodes, progress) {
  if (!progress) return episodes;
  return episodes.filter(
    (e) =>
      e.season_number > progress.last_season ||
      (e.season_number === progress.last_season && e.episode_number > progress.last_episode),
  );
}

export function isWatched(ep, progress) {
  if (!progress) return false;
  return (
    ep.season_number < progress.last_season ||
    (ep.season_number === progress.last_season && ep.episode_number <= progress.last_episode)
  );
}

/** Plain-text lineup for Discord. */
export function discordSummary(dateLabel, startTime, items) {
  const s = computeSchedule(startTime, items);
  const lines = s.rows.map((r) => {
    const i = r.item;
    const when = r.start != null ? `\`${formatClock(r.start).padStart(8)}\`  ` : '';
    const label =
      i.kind === 'episode'
        ? `**${i.title}** S${i.season}E${i.episode}${i.subtitle ? `: ${i.subtitle}` : ''}`
        : `**${i.title}**${i.subtitle ? ` (${i.subtitle})` : ''}`;
    const dur = `${r.itemEstimated ? '~' : ''}${formatDuration(i.runtime_min)}`;
    const kick = r.anchored ? ' kickoff' : '';
    return `${when}${label}  ${dur}${kick}`;
  });
  const tail = [`Total ${s.totalEstimated ? '~' : ''}${formatDuration(s.total)}`];
  if (s.end != null) tail.push(`ends ${s.endEstimated ? '~' : ''}${formatClock(s.end)}`);
  lines.push('', tail.join(', '));
  const title = startTime ? `${dateLabel}, starting ${formatClock(parseTime(startTime))}` : dateLabel;
  return { title, lines };
}
