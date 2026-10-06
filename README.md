# lingonberry media

A shared planner for watch nights: pick movies, episodes and NFL games for an
evening, see when it all ends, and post the lineup to Discord.

- **Frontend:** plain HTML/CSS/JS in `web/`, hosted on GitHub Pages
- **Backend:** Supabase (Postgres + Auth + Edge Functions) in `supabase/`
- **Data:** titles, posters and runtimes from TMDB

Open `web/index.html` through any static server with `config.js` left empty and
it runs in **demo mode** with invented sample titles, so you can try it before
any accounts exist.

## How it works

```
dhjn1.github.io/lingonberrymedia        GitHub Pages (this repo's web/ folder)
        │  sign in
        ▼
Supabase
  ├── Auth            two accounts, public sign-up off
  ├── Postgres        nights, lineup items, queue, show progress, history
  │                   Row Level Security: signed-in users only
  └── Edge Functions  tmdb (proxy + cache), post-lineup (Discord)
                      hold TMDB_API_KEY and DISCORD_WEBHOOK_URL as secrets
```

The code is public; the data is not. Without a signed-in session the database
returns nothing and the functions refuse to run.

### Runtimes and footnotes

Each lineup item records where its runtime came from. Anything that isn't a
TMDB runtime gets a small numbered footnote, and every time after it shows `~`:

| Source            | When                                  |
|-------------------|---------------------------------------|
| TMDB              | normal case, no mark                  |
| Season median     | episode runtime missing               |
| Show typical      | the whole season is missing runtimes  |
| Default (30/120)  | TMDB has nothing at all               |
| Custom estimate   | games and other blocks you mark as estimates |
| Edited            | you corrected it by hand (wins over everything) |

### Fixed-time blocks

A game (or any block) with a fixed start time is pinned to it. Items before it
are checked against kickoff (free time or overrun is shown); items after it
start when it ends.

## One-time setup

### 1. Supabase project
1. Create a project at supabase.com (name `lingonberrymedia`, region East US).
   Save the database password in your password manager.
2. **Authentication → Sign In / Providers:** turn off *Allow new users to sign up*.
3. **Authentication → Users → Add user:** one for each of you.
4. **Project Settings → API:** copy the Project URL and the anon / publishable key
   into `web/config.js`. Never put the `service_role` / secret key there.

### 2. Secrets in Supabase
**Edge Functions → Secrets:**
- `TMDB_API_KEY`: from themoviedb.org → Settings → API (either the API Key or
  the API Read Access Token works)
- `DISCORD_WEBHOOK_URL`: Discord channel → Edit Channel → Integrations → Webhooks

### 3. GitHub Pages
Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 4. Automatic Supabase deploys
Repo **Settings → Secrets and variables → Actions**:
- Secret `SUPABASE_ACCESS_TOKEN`: supabase.com → Account → Access Tokens
- Secret `SUPABASE_DB_PASSWORD`: the database password from step 1
- Variable `SUPABASE_PROJECT_REF`: the id in your project URL
  (`https://<this part>.supabase.co`)

Every push to `main` then runs the tests, publishes the site, applies database
migrations and deploys the Edge Functions. Until the Supabase settings exist,
that step is skipped with a notice and the rest still runs.

## Tests

```bash
node --test tests/*.test.mjs                                 # schedule + runtime logic
PGHOST=... PGUSER=postgres tests/sql/run.sh                   # schema, RLS, RPCs
deno test --allow-net --allow-env tests/functions_test.ts     # Edge Functions (faked network)
python3 tests/e2e_demo.py [screenshot_dir]                    # browser, demo mode
```

All four run in GitHub Actions on every push.

## Layout

```
web/
  index.html, styles.css, config.js
  js/app.js        UI
  js/schedule.js   pure scheduling/runtime logic
  js/api.js        Supabase access
  js/demo.js       in-memory demo backend
supabase/
  migrations/      schema, RLS, save_lineup + mark_night_watched
  functions/       tmdb, post-lineup
tests/
```

TMDB attribution: this product uses the TMDB API but is not endorsed or
certified by TMDB.
