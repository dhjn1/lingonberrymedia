-- Minimal stand-ins for what Supabase provides, so the migration can be
-- tested against plain Postgres. Not deployed anywhere.
-- Roles are cluster-wide, so tolerate them already existing from a prior run
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
