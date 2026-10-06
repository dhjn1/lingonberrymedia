-- Behaviour tests for the migration. Run with: tests/sql/run.sh
\set ON_ERROR_STOP on
\set QUIET on

-- Act as a signed-in user
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 1. First save creates the night at version 1
do $$ begin assert public.save_lineup('2026-10-08', 0, '18:30', '[
  {"kind":"episode","tmdb_id":101,"show_tmdb_id":95396,"season":2,"episode":3,
   "title":"Severance","subtitle":"Who Is Alive?","runtime_min":55},
  {"kind":"custom","title":"NFL: TNF","subtitle":"Bears @ Packers",
   "runtime_min":195,"runtime_source":"custom_estimate","anchor_time":"19:15",
   "note":"typical game length; overtime not included"},
  {"kind":"episode","tmdb_id":102,"show_tmdb_id":95396,"season":2,"episode":4,
   "title":"Severance","subtitle":"Woe''s Hollow","runtime_min":53}
]'::jsonb) = 1, 'save creates v1'; end $$;

do $$ begin
  assert (select count(*) from public.lineup_items) = 3, 'three items saved';
  assert (select string_agg(subtitle, '|' order by position) from public.lineup_items)
         = 'Who Is Alive?|Bears @ Packers|Woe''s Hollow', 'order preserved';
  assert (select anchor_time from public.lineup_items where kind = 'custom') = '19:15',
         'anchor saved';
  assert (select added_by from public.lineup_items limit 1)
         = '11111111-1111-1111-1111-111111111111', 'added_by from auth.uid()';
end $$;

-- 2. Saving with the right version bumps it and replaces items
do $$ begin
  assert public.save_lineup('2026-10-08', 1, '18:00', '[
    {"kind":"movie","tmdb_id":603,"title":"The Matrix","runtime_min":136}]'::jsonb) = 2,
    'second save returns v2';
  assert (select count(*) from public.lineup_items) = 1, 'items replaced';
end $$;

-- 3. Saving with a stale version is rejected and changes nothing
do $$ declare ok boolean := false; begin
  begin
    perform public.save_lineup('2026-10-08', 1, '20:00', '[]'::jsonb);
  exception when others then
    ok := sqlerrm = 'stale_lineup';
  end;
  assert ok, 'stale save raises stale_lineup';
  assert (select version from public.nights where night_date = '2026-10-08') = 2, 'version unchanged';
  assert (select count(*) from public.lineup_items) = 1, 'items unchanged';
end $$;

-- 4. Stale check also applies to a night that does not exist yet
do $$ declare ok boolean := false; begin
  begin
    perform public.save_lineup('2026-10-09', 3, null, '[]'::jsonb);
  exception when others then ok := sqlerrm = 'stale_lineup'; end;
  assert ok, 'nonzero version on new night raises';
end $$;

-- 5. Marking watched logs history and advances progress, never backwards
do $$ begin
  perform public.save_lineup('2026-10-10', 0, null, '[
    {"kind":"episode","tmdb_id":201,"show_tmdb_id":95396,"season":2,"episode":3,"title":"Severance","runtime_min":55},
    {"kind":"episode","tmdb_id":202,"show_tmdb_id":95396,"season":2,"episode":4,"title":"Severance","runtime_min":53},
    {"kind":"custom","title":"NFL: MNF","runtime_min":195,"runtime_source":"custom_estimate"}]'::jsonb);
  assert public.mark_night_watched('2026-10-10') = 3, 'three history rows';
  assert (select last_season || 'x' || last_episode from public.show_progress
          where show_tmdb_id = 95396) = '2x4', 'progress at S2E4';

  -- Re-watching an earlier episode later must not move progress back
  perform public.save_lineup('2026-10-11', 0, null, '[
    {"kind":"episode","tmdb_id":199,"show_tmdb_id":95396,"season":1,"episode":9,"title":"Severance","runtime_min":50}]'::jsonb);
  perform public.mark_night_watched('2026-10-11');
  assert (select last_season || 'x' || last_episode from public.show_progress
          where show_tmdb_id = 95396) = '2x4', 'progress not moved backwards';
end $$;

-- 6. Marking the same night twice is refused
do $$ declare ok boolean := false; begin
  begin perform public.mark_night_watched('2026-10-10');
  exception when others then ok := sqlerrm = 'already_marked'; end;
  assert ok, 'double mark refused';
end $$;

-- 7. Bad runtime is rejected by the check constraint
do $$ declare ok boolean := false; begin
  begin
    perform public.save_lineup('2026-10-12', 0, null,
      '[{"kind":"movie","title":"x","runtime_min":0}]'::jsonb);
  exception when check_violation then ok := true; end;
  assert ok, 'zero runtime rejected';
end $$;

-- 8. Anonymous visitors see nothing and cannot write or call functions
reset request.jwt.claim.sub;
set role anon;
do $$ begin
  assert (select count(*) from public.nights) = 0, 'anon sees no nights';
  assert (select count(*) from public.lineup_items) = 0, 'anon sees no items';
end $$;
do $$ declare ok boolean := false; begin
  begin insert into public.queue_items (kind, tmdb_id, title) values ('movie', 1, 'x');
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon insert blocked';
end $$;
do $$ declare ok boolean := false; begin
  begin perform public.save_lineup('2026-11-01', 0, null, '[]'::jsonb);
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon cannot call save_lineup';
end $$;

-- 9. Signed-in users cannot read the TMDB cache directly
set role authenticated;
do $$ declare ok boolean := false; begin
  begin perform count(*) from public.tmdb_cache;
  exception when insufficient_privilege then ok := true; end;
  assert ok, 'tmdb_cache hidden from clients';
end $$;

reset role;
\echo ALL SQL TESTS PASSED
