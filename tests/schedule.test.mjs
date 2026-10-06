// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSchedule, resolveEpisodeRuntimes, resolveMovieRuntime, formatClock,
  formatDuration, parseTime, median, nextUnwatched, isWatched, discordSummary, addDays,
} from '../web/js/schedule.js';

const ep = (runtime_min, runtime_source = 'tmdb', extra = {}) =>
  ({ kind: 'episode', title: 'Show', runtime_min, runtime_source, ...extra });

test('formatting helpers', () => {
  assert.equal(formatClock(parseTime('19:15')), '7:15 PM');
  assert.equal(formatClock(0), '12:00 AM');
  assert.equal(formatClock(12 * 60), '12:00 PM');
  assert.equal(formatClock(1440 + 46), '12:46 AM'); // past midnight wraps
  assert.equal(formatDuration(108), '1h 48m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(120), '2h');
  assert.equal(median([52, 48, 0, null, 55]), 52);
  assert.equal(median([40, 50]), 45);
  assert.equal(median([]), null);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('items flow back to back from the start time', () => {
  const s = computeSchedule('21:30', [ep(55), ep(53)]);
  assert.deepEqual(s.rows.map((r) => [r.start, r.end]), [[1290, 1345], [1345, 1398]]);
  assert.equal(s.total, 108);
  assert.equal(formatClock(s.end), '11:18 PM');
  assert.equal(s.endEstimated, false);
  assert.deepEqual(s.footnotes, []);
});

test('no start time: durations only, no clock', () => {
  const s = computeSchedule(null, [ep(55), ep(53)]);
  assert.equal(s.rows[0].start, null);
  assert.equal(s.end, null);
  assert.equal(s.total, 108);
});

test('estimates make every later time approximate and get numbered footnotes', () => {
  const s = computeSchedule('21:30', [
    ep(55),
    ep(44, 'season_median'),
    ep(44, 'show_typical'),
    ep(44, 'season_median'),
    ep(50, 'manual'),
  ]);
  assert.deepEqual(s.rows.map((r) => r.mark), [null, 1, 2, 1, null]);
  assert.equal(s.footnotes.length, 2);
  assert.match(s.footnotes[0].text, /this season/);
  assert.match(s.footnotes[1].text, /typical episode length/);
  assert.equal(s.rows[0].endEstimated, false);
  assert.equal(s.rows[1].endEstimated, true);
  assert.equal(s.rows[4].endEstimated, true, 'estimate carries forward');
  assert.equal(s.rows[4].edited, true);
  assert.equal(s.totalEstimated, true);
});

test('anchored NFL block: gap before kickoff, exact start, flow after', () => {
  const nfl = {
    kind: 'custom', title: 'NFL: TNF', runtime_min: 195, runtime_source: 'custom_estimate',
    anchor_time: '19:15', note: 'Typical NFL game length; overtime not included',
  };
  const s = computeSchedule('18:30', [ep(30), nfl, ep(44)]);
  const [a, game, b] = s.rows;
  assert.equal(formatClock(a.end), '7:00 PM');
  assert.equal(game.gap, 15);
  assert.equal(game.overlap, 0);
  assert.equal(formatClock(game.start), '7:15 PM');
  assert.equal(game.startEstimated, false);
  assert.equal(game.endEstimated, true);
  assert.equal(formatClock(b.start), '10:30 PM');
  assert.equal(b.startEstimated, true);
  assert.equal(s.footnotes[0].text, nfl.note);
});

test('anchored block flags items that run past kickoff', () => {
  const nfl = { kind: 'custom', title: 'NFL', runtime_min: 195, runtime_source: 'custom_estimate', anchor_time: '19:15' };
  const s = computeSchedule('18:30', [ep(55), nfl]);
  assert.equal(s.rows[1].overlap, 10);
  assert.equal(s.rows[1].gap, 0);
});

test('anchor with no start time still schedules what follows', () => {
  const nfl = { kind: 'custom', title: 'NFL', runtime_min: 195, runtime_source: 'custom_estimate', anchor_time: '19:15' };
  const s = computeSchedule(null, [ep(44), nfl, ep(44)]);
  assert.equal(s.rows[0].start, null);
  assert.equal(formatClock(s.rows[1].start), '7:15 PM');
  assert.equal(formatClock(s.rows[2].start), '10:30 PM');
});

test('after-midnight anchor stays on the same night', () => {
  const late = { kind: 'custom', title: 'Late', runtime_min: 60, runtime_source: 'manual', anchor_time: '00:30' };
  const s = computeSchedule('22:00', [ep(60), late]);
  assert.equal(s.rows[1].start, 1440 + 30);
  assert.equal(s.rows[1].gap, 90);
});

test('episode runtime fallback chain', () => {
  const season = [
    { episode_number: 1, runtime: 52 },
    { episode_number: 2, runtime: null },
    { episode_number: 3, runtime: 48 },
  ];
  const r = resolveEpisodeRuntimes(season, {});
  assert.deepEqual(r.map((e) => [e.runtime_min, e.runtime_source]),
    [[52, 'tmdb'], [50, 'season_median'], [48, 'tmdb']]);

  const blank = [{ runtime: null }, { runtime: 0 }];
  assert.deepEqual(resolveEpisodeRuntimes(blank, { episode_run_time: [44] }).map((e) => e.runtime_source),
    ['show_typical', 'show_typical']);
  assert.equal(resolveEpisodeRuntimes(blank, { episode_run_time: [], last_episode_to_air: { runtime: 41 } })[0].runtime_min, 41);
  const none = resolveEpisodeRuntimes(blank, {});
  assert.deepEqual([none[0].runtime_min, none[0].runtime_source], [30, 'default']);

  assert.deepEqual(resolveMovieRuntime({ runtime: 136 }), { runtime_min: 136, runtime_source: 'tmdb' });
  assert.deepEqual(resolveMovieRuntime({ runtime: 0 }), { runtime_min: 120, runtime_source: 'default' });
});

test('watched / next-up helpers', () => {
  const eps = [1, 2, 3].map((n) => ({ season_number: 2, episode_number: n }));
  const p = { last_season: 2, last_episode: 1 };
  assert.deepEqual(nextUnwatched(eps, p).map((e) => e.episode_number), [2, 3]);
  assert.equal(isWatched(eps[0], p), true);
  assert.equal(isWatched(eps[1], p), false);
  assert.equal(isWatched({ season_number: 1, episode_number: 9 }, p), true);
  assert.equal(nextUnwatched(eps, null).length, 3);
});

test('discord summary', () => {
  const { title, lines } = discordSummary('Thursday, Oct 8', '18:30', [
    ep(30, 'tmdb', { title: 'Severance', season: 2, episode: 3, subtitle: 'Who Is Alive?' }),
    { kind: 'custom', title: 'NFL: TNF', subtitle: 'Bears @ Packers', runtime_min: 195,
      runtime_source: 'custom_estimate', anchor_time: '19:15' },
  ]);
  assert.equal(title, 'Thursday, Oct 8, starting 6:30 PM');
  assert.match(lines[0], /\*\*Severance\*\* S2E3: Who Is Alive\?  30m$/);
  assert.match(lines[1], /7:15 PM.*NFL: TNF.*~3h 15m kickoff/);
  assert.equal(lines.at(-1), 'Total ~3h 45m, ends ~10:30 PM');
});
