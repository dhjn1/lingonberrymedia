// Posts a night's lineup to Discord. The webhook URL stays secret here;
// mentions are disabled so the message can never ping @everyone.
import { adminClient, corsHeaders, json, requireUser } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = adminClient();
  const user = await requireUser(req, admin);
  if (!user) return json({ error: "sign_in_required" }, 401);

  const webhook = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!webhook) return json({ error: "webhook_missing" }, 500);

  let title = "";
  let lines: string[] = [];
  let thumbnail: string | undefined;
  try {
    const body = await req.json();
    title = String(body.title ?? "").slice(0, 256);
    lines = (Array.isArray(body.lines) ? body.lines : []).map((l: unknown) => String(l).slice(0, 300));
    if (typeof body.thumbnail === "string" && body.thumbnail.startsWith("https://image.tmdb.org/")) {
      thumbnail = body.thumbnail;
    }
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!title || lines.length === 0) return json({ error: "empty_lineup" }, 400);

  const description = lines.join("\n").slice(0, 4000);
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "lingonberry media",
      allowed_mentions: { parse: [] },
      embeds: [{
        title,
        description,
        color: 0xc0304e,
        ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
      }],
    }),
  });
  if (!res.ok) return json({ error: "discord_error", status: res.status }, 502);
  return json({ ok: true });
});
