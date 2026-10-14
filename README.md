# geosynced.io

Website for geosynced, a GEO / AEO consultancy, plus a tracker that checks every day whether AI search engines cite geosynced.io, and publishes the results on the site's Live proof page.

- **Site:** [11ty](https://www.11ty.dev/), plain static HTML, no client-side framework
- **Hosting:** Cloudflare (free plan), deployed automatically from GitHub on every push to `main`
- **Tracker:** a Node script run daily by GitHub Actions; results are committed as JSON in `data/runs/`

## How the pieces fit

```
GitHub Actions (daily)          GitHub repo                 Cloudflare
  scripts/track.mjs   ──commit──▶  data/runs/2026-10-15.json  ──push triggers build──▶  geosynced.io/proof/
  asks AI engines the                                          npm run build (11ty)
  questions in                                                 serves _site/
  tracker/prompts.json
```

## Folder guide

| Path | What it is |
| --- | --- |
| `src/` | Site pages (`.njk` and `.md`), layout, CSS |
| `src/_data/site.json` | Site name, URL, contact email |
| `src/_data/visibility.js` | Turns tracker results into data for the proof page |
| `tracker/prompts.json` | The questions the tracker asks. Edit freely |
| `scripts/track.mjs` | The tracker |
| `data/runs/` | One JSON file per day of results. Never edit by hand |
| `.github/workflows/track.yml` | The daily schedule |
| `wrangler.jsonc` | Cloudflare config |

## Run it on your Mac

```bash
npm install
npm run track:dry   # fake tracker data so the proof page has something to show
npm run dev         # site at http://localhost:8080, reloads on save
```

Dry-run data goes to `data/runs-sample/`, which is git-ignored and only used when no real runs exist, so it never reaches the live site.

## One-time setup

### 1. Connect Cloudflare to GitHub

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub and pick `jelenav412/geosynced`.
3. Build settings:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
4. Deploy. Then under the Worker's **Settings → Domains & Routes**, add `geosynced.io` (and `www.geosynced.io` if you want it).

From then on every push to `main` deploys, and other branches get preview URLs.

### 2. Let AI crawlers in

In the Cloudflare dashboard for geosynced.io, check **Security → Bots** (and **AI Crawl Control** if you see it). Make sure AI search crawlers aren't blocked, and that Cloudflare's *managed robots.txt* isn't replacing `src/robots.txt`.

### 3. Add tracker API keys

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `PERPLEXITY_API_KEY`: from Perplexity's API settings. Returns its sources directly.
- `OPENAI_API_KEY` (optional): uses the Responses API with web search.

Engines without a key are skipped. To change models, add repository **variables** `PERPLEXITY_MODEL` / `OPENAI_MODEL`.

Then go to **Actions → Track AI citations → Run workflow** to do the first run without waiting for the schedule.

### 4. Submit the site to search engines

- Google Search Console and Bing Webmaster Tools: verify the domain and submit `https://geosynced.io/sitemap.xml`. Bing matters here because several AI search products use its index.

## Before launch

- [ ] Replace the placeholder email in `src/_data/site.json`
- [ ] Review the questions in `tracker/prompts.json`
- [ ] Read through all page copy in `src/`
