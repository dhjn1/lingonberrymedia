// TMDB proxy: keeps the API key secret, only allows the lookups the app needs,
// and caches show/season/movie details so flipping between seasons is instant.
import { adminClient, corsHeaders, json, requireUser } from "../_shared/common.ts";

// path pattern -> cache lifetime in hours (0 = never cache)
const ALLOWED: Array<[RegExp, number]> = [
  [/^search\/multi$/, 0],
  [/^movie\/\d+$/, 24 * 7],
  [/^tv\/\d+$/, 24],
  [/^tv\/\d+\/season\/\d+$/, 24 * 3],
  [/^(movie|tv)\/\d+\/watch\/providers$/, 24],
];

const ALLOWED_PARAMS = new Set(["query", "page", "include_adult"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(req, admin);
  if (!user) return json({ error: "sign_in_required" }, 401);

  let path = "";
  let params: Record<string, string> = {};
  try {
    const body = await req.json();
    path = String(body.path ?? "").replace(/^\/+/, "");
    params = body.params ?? {};
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const rule = ALLOWED.find(([re]) => re.test(path));
  if (!rule) return json({ error: "path_not_allowed" }, 400);
  const ttlHours = rule[1];

  const search = new URLSearchParams({ language: "en-US" });
  for (const [k, v] of Object.entries(params)) {
    if (ALLOWED_PARAMS.has(k)) search.set(k, String(v).slice(0, 200));
  }
  if (path === "search/multi") search.set("include_adult", "false");
  const cacheKey = `${path}?${search.toString()}`;

  if (ttlHours > 0) {
    const { data: hit } = await admin
      .from("tmdb_cache").select("body, fetched_at").eq("path", cacheKey).maybeSingle();
    if (hit && Date.now() - new Date(hit.fetched_at).getTime() < ttlHours * 3600_000) {
      return json(hit.body);
    }
  }

  const key = Deno.env.get("TMDB_API_KEY");
  if (!key) return json({ error: "tmdb_key_missing" }, 500);

  // Accept either a v4 "API Read Access Token" (a JWT) or a v3 "API Key".
  const headers: Record<string, string> = { accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else search.set("api_key", key);

  const res = await fetch(`https://api.themoviedb.org/3/${path}?${search}`, { headers });
  if (!res.ok) return json({ error: "tmdb_error", status: res.status }, 502);
  const body = await res.json();

  if (ttlHours > 0) {
    await admin.from("tmdb_cache").upsert({
      path: cacheKey,
      body,
      fetched_at: new Date().toISOString(),
    });
  }
  return json(body);
});
