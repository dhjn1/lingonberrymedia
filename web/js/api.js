// Backend access. One interface, two implementations:
//   live: Supabase (auth, Postgres, Edge Functions)
//   demo: in-memory sample data, used when config.js has no Supabase details
import { createDemoApi } from './demo.js';

export async function createApi(config) {
  if (!config.supabaseUrl || !config.supabaseKey) return createDemoApi();
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return createLiveApi(createClient(config.supabaseUrl, config.supabaseKey));
}

class StaleError extends Error {
  constructor() { super('stale_lineup'); this.stale = true; }
}

function check({ data, error }) {
  if (error) throw error;
  return data;
}

function createLiveApi(sb) {
  return {
    demo: false,

    async session() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session));
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async tmdb(path, params = {}) {
      const { data, error } = await sb.functions.invoke('tmdb', { body: { path, params } });
      if (error) throw error;
      return data;
    },

    async loadNight(date) {
      const night = check(await sb.from('nights')
        .select('id, night_date, start_time, version, watched_at')
        .eq('night_date', date).maybeSingle());
      if (!night) return { night: null, items: [] };
      const items = check(await sb.from('lineup_items')
        .select('*').eq('night_id', night.id).order('position'));
      return { night, items };
    },

    async loadRange(from, to) {
      return check(await sb.from('nights')
        .select('night_date, start_time, watched_at, lineup_items(runtime_min, kind, title, runtime_source)')
        .gte('night_date', from).lte('night_date', to));
    },

    async saveLineup(date, version, startTime, items) {
      const { data, error } = await sb.rpc('save_lineup', {
        p_night_date: date,
        p_expected_version: version,
        p_start_time: startTime,
        p_items: items.map(stripItem),
      });
      if (error) {
        if (String(error.message).includes('stale_lineup')) throw new StaleError();
        throw error;
      }
      return data;
    },

    async markWatched(date) {
      return check(await sb.rpc('mark_night_watched', { p_night_date: date }));
    },

    async listQueue() {
      return check(await sb.from('queue_items').select('*').order('created_at', { ascending: false }));
    },
    async addToQueue(entry) {
      check(await sb.from('queue_items').upsert(entry, { onConflict: 'kind,tmdb_id', ignoreDuplicates: true }));
    },
    async removeFromQueue(id) {
      check(await sb.from('queue_items').delete().eq('id', id));
    },

    async listProgress() {
      return check(await sb.from('show_progress').select('*'));
    },
    async setProgress(p) {
      check(await sb.from('show_progress').upsert({ ...p, updated_at: new Date().toISOString() }));
    },

    async postDiscord(payload) {
      const { error } = await sb.functions.invoke('post-lineup', { body: payload });
      if (error) throw error;
    },

    subscribe(onChange) {
      sb.channel('lineup-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'nights' }, (p) => onChange('nights', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_items' }, () => onChange('queue'))
        .subscribe();
    },
  };
}

const ITEM_FIELDS = ['kind', 'tmdb_id', 'show_tmdb_id', 'season', 'episode', 'title', 'subtitle',
  'poster_path', 'runtime_min', 'runtime_source', 'anchor_time', 'note', 'added_by'];

export function stripItem(item) {
  const out = {};
  for (const k of ITEM_FIELDS) if (item[k] != null && item[k] !== '') out[k] = item[k];
  return out;
}

export { StaleError };
