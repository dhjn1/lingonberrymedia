// Demo backend: invented sample titles, kept in memory, nothing saved.
// Runs whenever config.js has no Supabase details, so the app can be tried
// (and tested) before any accounts exist.
import { isoDate } from './schedule.js';

const eps = (season, runtimes, names) =>
  runtimes.map((runtime, i) => ({
    id: season * 1000 + i + 1,
    season_number: season,
    episode_number: i + 1,
    name: names[i] || `Episode ${i + 1}`,
    runtime,
  }));

const SHOWS = {
  9001: {
    id: 9001, name: 'Harbor Lights', first_air_date: '2023-03-02', episode_run_time: [],
    seasons: [{ season_number: 1, name: 'Season 1' }, { season_number: 2, name: 'Season 2' }],
    episodes: {
      1: eps(1, [52, 48, 50, 47, 51, 49, 53, 58],
        ['Low Tide', 'The Ferryman', 'Salt Ledger', 'Night Crossing', 'Breakwater', 'Signal Fire', 'Undertow', 'Landfall']),
      2: eps(2, [54, 49, null, 51, null, 62],
        ['Return Passage', 'Dry Dock', 'Fog Bank', 'The Keeper', 'Riptide', 'Lighthouse']),
    },
  },
  9002: {
    id: 9002, name: 'The Quiet Orchard', first_air_date: '2025-09-14', episode_run_time: [44],
    seasons: [{ season_number: 1, name: 'Season 1' }],
    episodes: { 1: eps(1, [null, null, null, null, null], ['Graft', 'Frost Line', 'Windfall', 'Pruning', 'Cider']) },
  },
  9003: {
    id: 9003, name: 'Static Hours', first_air_date: '2019-10-31', episode_run_time: [],
    seasons: [{ season_number: 1, name: 'Season 1' }],
    episodes: { 1: eps(1, [null, null, null, null], ['Dial Tone', 'Dead Air', 'Test Pattern', 'Sign Off']) },
  },
};

const MOVIES = {
  8001: { id: 8001, title: 'Paper Moonlight', release_date: '2021-06-11', runtime: 118 },
  8002: { id: 8002, title: 'North of Nowhere', release_date: '2024-02-23', runtime: 0 },
  8003: { id: 8003, title: 'Glass Harvest', release_date: '2018-11-02', runtime: 141 },
};

export function createDemoApi() {
  const today = isoDate(new Date());
  const nights = new Map(); // date -> { night, items }
  nights.set(today, {
    night: { night_date: today, start_time: '21:00', version: 1, watched_at: null },
    items: [
      { kind: 'episode', tmdb_id: 2003, show_tmdb_id: 9001, season: 2, episode: 3, title: 'Harbor Lights',
        subtitle: 'Fog Bank', runtime_min: 53, runtime_source: 'season_median' },
      { kind: 'episode', tmdb_id: 2004, show_tmdb_id: 9001, season: 2, episode: 4, title: 'Harbor Lights',
        subtitle: 'The Keeper', runtime_min: 51, runtime_source: 'tmdb' },
    ],
  });
  let queue = [
    { id: 'q1', kind: 'movie', tmdb_id: 8003, title: 'Glass Harvest', year: '2018', poster_path: null },
    { id: 'q2', kind: 'tv', tmdb_id: 9002, title: 'The Quiet Orchard', year: '2025', poster_path: null },
  ];
  const progress = new Map([[9001, { show_tmdb_id: 9001, show_name: 'Harbor Lights', last_season: 2, last_episode: 2 }]]);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const wait = () => new Promise((r) => setTimeout(r, 120));

  return {
    demo: true,
    async session() { return { user: { email: 'demo' } }; },
    onAuthChange() {},
    async signIn() {},
    async signOut() {},

    async tmdb(path, params = {}) {
      await wait();
      let m;
      if (path === 'search/multi') {
        const q = String(params.query || '').toLowerCase().trim();
        const shows = Object.values(SHOWS)
          .filter((s) => s.name.toLowerCase().includes(q))
          .map((s) => ({ media_type: 'tv', id: s.id, name: s.name, first_air_date: s.first_air_date, poster_path: null }));
        const movies = Object.values(MOVIES)
          .filter((mv) => mv.title.toLowerCase().includes(q))
          .map((mv) => ({ media_type: 'movie', id: mv.id, title: mv.title, release_date: mv.release_date, poster_path: null }));
        return { results: q ? [...shows, ...movies] : [] };
      }
      if ((m = /^movie\/(\d+)$/.exec(path))) return clone(MOVIES[m[1]]);
      if ((m = /^tv\/(\d+)$/.exec(path))) {
        const { episodes, ...show } = SHOWS[m[1]];
        return clone(show);
      }
      if ((m = /^tv\/(\d+)\/season\/(\d+)$/.exec(path))) {
        return { episodes: clone(SHOWS[m[1]].episodes[m[2]] || []) };
      }
      throw new Error('path_not_allowed');
    },

    async loadNight(date) {
      await wait();
      return clone(nights.get(date) || { night: null, items: [] });
    },
    async loadRange(from, to) {
      return [...nights.values()]
        .filter((n) => n.night.night_date >= from && n.night.night_date <= to)
        .map((n) => ({ ...clone(n.night), lineup_items: clone(n.items) }));
    },
    async saveLineup(date, version, startTime, items) {
      const cur = nights.get(date);
      if ((cur ? cur.night.version : 0) !== version) {
        throw Object.assign(new Error('stale_lineup'), { stale: true });
      }
      const next = (cur ? cur.night.version : 0) + 1;
      nights.set(date, {
        night: { night_date: date, start_time: startTime, version: next, watched_at: cur?.night.watched_at ?? null },
        items: clone(items),
      });
      return next;
    },
    async markWatched(date) {
      const n = nights.get(date);
      if (!n) throw new Error('no_lineup');
      if (n.night.watched_at) throw new Error('already_marked');
      for (const i of n.items) {
        if (i.kind !== 'episode') continue;
        const p = progress.get(i.show_tmdb_id);
        if (!p || i.season > p.last_season || (i.season === p.last_season && i.episode > p.last_episode)) {
          progress.set(i.show_tmdb_id, { show_tmdb_id: i.show_tmdb_id, show_name: i.title, last_season: i.season, last_episode: i.episode });
        }
      }
      n.night.watched_at = new Date().toISOString();
      n.night.version += 1;
      return n.items.length;
    },

    async listQueue() { return clone(queue); },
    async addToQueue(entry) {
      if (!queue.some((q) => q.kind === entry.kind && q.tmdb_id === entry.tmdb_id)) {
        queue = [{ id: `q${Date.now()}`, ...entry }, ...queue];
      }
    },
    async removeFromQueue(id) { queue = queue.filter((q) => q.id !== id); },

    async listProgress() { return clone([...progress.values()]); },
    async setProgress(p) { progress.set(p.show_tmdb_id, clone(p)); },

    async postDiscord() { await wait(); },
    subscribe() {},
  };
}
