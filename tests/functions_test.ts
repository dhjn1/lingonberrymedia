// Smoke tests for the Edge Functions with Supabase and TMDB faked out.
// Run: deno test --allow-net --allow-env tests/functions_test.ts
import { deepStrictEqual } from "node:assert";
const assertEquals = (a: unknown, b: unknown, msg?: string) => deepStrictEqual(a, b, msg);

Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
Deno.env.set("TMDB_API_KEY", "v3key");
Deno.env.set("DISCORD_WEBHOOK_URL", "https://discord.test/hook");

const realFetch = globalThis.fetch;
const calls: string[] = [];
const cache = new Map<string, unknown>();
let discordBody: any = null;

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  calls.push(`${req.method} ${url.hostname}${url.pathname}`);

  if (url.pathname === "/auth/v1/user") {
    const ok = req.headers.get("Authorization") === "Bearer good-user-token";
    return ok
      ? Response.json({ id: "u1", aud: "authenticated", role: "authenticated", email: "a@b.c" })
      : Response.json({ msg: "invalid JWT" }, { status: 401 });
  }
  if (url.pathname === "/rest/v1/tmdb_cache") {
    if (req.method === "GET") {
      const key = url.searchParams.get("path")!.replace(/^eq\./, "");
      const hit = cache.get(key);
      return hit ? Response.json(hit) : new Response(null, { status: 406 });
    }
    const row = await req.json();
    const r = Array.isArray(row) ? row[0] : row;
    cache.set(r.path, r);
    return new Response(null, { status: 201 });
  }
  if (url.hostname === "api.themoviedb.org") {
    assertEquals(url.searchParams.get("api_key"), "v3key");
    return Response.json({ path: url.pathname, query: url.searchParams.get("query") });
  }
  if (url.hostname === "discord.test") {
    discordBody = await req.json();
    return new Response(null, { status: 204 });
  }
  return new Response("unexpected " + req.url, { status: 500 });
}) as typeof fetch;

// Each module calls Deno.serve; capture the handlers instead of binding ports.
const handlers: Array<(r: Request) => Promise<Response>> = [];
(Deno as any).serve = (h: any) => {
  handlers.push(h);
  return { finished: Promise.resolve(), shutdown() {} };
};
await import("../supabase/functions/tmdb/index.ts");
await import("../supabase/functions/post-lineup/index.ts");
const [tmdb, post] = handlers;

const call = (h: typeof tmdb, body: unknown, token = "good-user-token") =>
  h(new Request("http://fn.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

Deno.test("tmdb: requires a signed-in user", async () => {
  const res = await call(tmdb, { path: "movie/603" }, "anon-key-only");
  assertEquals(res.status, 401);
});

Deno.test("tmdb: blocks paths outside the allowlist", async () => {
  for (const path of ["account", "movie/603/../../account", "tv/1/season/2/episode/3", "search/person"]) {
    const res = await call(tmdb, { path });
    assertEquals(res.status, 400, path);
    await res.body?.cancel();
  }
});

Deno.test("tmdb: search passes the query and is not cached", async () => {
  const res = await call(tmdb, { path: "search/multi", params: { query: "severance", sneaky: "x" } });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).query, "severance");
  assertEquals([...cache.keys()].some((k) => k.startsWith("search")), false);
});

Deno.test("tmdb: season lookups are cached after the first fetch", async () => {
  calls.length = 0;
  const a = await call(tmdb, { path: "tv/95396/season/2" });
  assertEquals((await a.json()).path, "/3/tv/95396/season/2");
  const tmdbCallsAfterFirst = calls.filter((c) => c.includes("themoviedb")).length;
  const b = await call(tmdb, { path: "tv/95396/season/2" });
  assertEquals((await b.json()).path, "/3/tv/95396/season/2");
  assertEquals(calls.filter((c) => c.includes("themoviedb")).length, tmdbCallsAfterFirst);
  assertEquals(tmdbCallsAfterFirst, 1);
});

Deno.test("post-lineup: requires a user, disables mentions, forwards the embed", async () => {
  assertEquals((await call(post, { title: "x", lines: ["y"] }, "nope")).status, 401);
  const res = await call(post, {
    title: "Thursday, Oct 8",
    lines: ["@everyone 7:15 PM NFL"],
    thumbnail: "https://evil.example/x.png",
  });
  assertEquals(res.status, 200);
  assertEquals(discordBody.allowed_mentions, { parse: [] });
  assertEquals(discordBody.embeds[0].title, "Thursday, Oct 8");
  assertEquals(discordBody.embeds[0].thumbnail, undefined); // only TMDB images allowed
});
