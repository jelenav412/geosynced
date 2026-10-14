#!/usr/bin/env node
/**
 * geosynced AI-citation tracker
 *
 * Asks each prompt in tracker/prompts.json to every AI search engine that has an
 * API key set, records which sources each answer cites, and writes one JSON file
 * per day to data/runs/YYYY-MM-DD.json. The site reads those files at build time.
 *
 * Engines (each runs only if its key is present):
 *   PERPLEXITY_API_KEY  -> Perplexity Sonar (returns its citations directly)
 *   OPENAI_API_KEY      -> OpenAI Responses API with the web_search tool
 *
 * Optional model overrides: PERPLEXITY_MODEL (default "sonar"), OPENAI_MODEL (default "gpt-4.1-mini").
 *
 * Usage:
 *   node scripts/track.mjs            real run, writes today's file
 *   node scripts/track.mjs --dry-run  no API calls; writes fake data to data/runs-sample/ to test the pipeline
 *   node scripts/track.mjs --dry-run --date=2026-10-01   fake a past day, to preview the trend line
 *
 * No npm dependencies: Node 20+ has fetch built in.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const config = JSON.parse(await readFile(path.join(root, "tracker/prompts.json"), "utf8"));
const ownDomains = config.brand.domains.map((d) => d.toLowerCase());

// ---------- helpers ----------

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isOwn(host) {
  return !!host && ownDomains.some((d) => host === d || host.endsWith("." + d));
}

function summarise(urls) {
  const unique = [...new Set(urls.filter(Boolean))];
  const hosts = unique.map(hostOf);
  const ownIndex = hosts.findIndex(isOwn);
  return {
    cited: ownIndex !== -1,
    position: ownIndex === -1 ? null : ownIndex + 1, // 1 = first source listed
    sources: unique.slice(0, 15).map((url, i) => ({ url, domain: hosts[i] })),
  };
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function postJSON(url, key, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- engines ----------

const engines = [
  {
    id: "perplexity",
    label: "Perplexity",
    key: process.env.PERPLEXITY_API_KEY,
    async ask(prompt) {
      const model = process.env.PERPLEXITY_MODEL || "sonar";
      const data = await postJSON("https://api.perplexity.ai/chat/completions", this.key, {
        model,
        messages: [{ role: "user", content: prompt }],
      });
      const urls = [
        ...(data.citations || []),
        ...((data.search_results || []).map((r) => r.url)),
      ];
      return { model, answer: data.choices?.[0]?.message?.content || "", ...summarise(urls) };
    },
  },
  {
    id: "openai",
    label: "ChatGPT search (API)",
    key: process.env.OPENAI_API_KEY,
    async ask(prompt) {
      const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
      const data = await postJSON("https://api.openai.com/v1/responses", this.key, {
        model,
        tools: [{ type: "web_search" }],
        input: prompt,
      });
      const urls = [];
      let answer = "";
      for (const item of data.output || []) {
        if (item.type !== "message") continue;
        for (const part of item.content || []) {
          if (part.type !== "output_text") continue;
          answer += part.text;
          for (const a of part.annotations || []) if (a.type === "url_citation") urls.push(a.url);
        }
      }
      return { model, answer, ...summarise(urls) };
    },
  },
];

// ---------- dry run ----------

function fakeResult(promptId, engineId) {
  // Deterministic pseudo-random so the sample looks stable between runs
  let h = 0;
  for (const c of promptId + engineId + date) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const cited = h % 3 === 0;
  const pool = ["example-agency.com", "wikipedia.org", "searchengineland.com", "reddit.com", "example-blog.net"];
  const urls = pool.slice(0, 3 + (h % 3)).map((d) => `https://${d}/${promptId}`);
  if (cited) urls.splice(h % urls.length, 0, `https://${ownDomains[0]}/${promptId}`);
  return { model: "dry-run", answer: "(dry run: no API call made)", ...summarise(urls) };
}

// ---------- main ----------

const active = DRY ? engines.map((e) => ({ ...e, key: "dry" })) : engines.filter((e) => e.key);
if (!active.length) {
  console.error("No API keys found. Set PERPLEXITY_API_KEY and/or OPENAI_API_KEY, or use --dry-run.");
  process.exit(1);
}

// --date=YYYY-MM-DD lets a dry run fake past days (to preview the trend line locally)
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const date = DRY && dateArg ? dateArg.slice(7) : new Date().toISOString().slice(0, 10);
const results = [];
let failures = 0;

for (const p of config.prompts) {
  for (const engine of active) {
    try {
      const r = DRY ? fakeResult(p.id, engine.id) : await withRetry(() => engine.ask(p.text));
      results.push({ promptId: p.id, engine: engine.id, ...r, answer: r.answer.slice(0, 1500) });
      console.log(`${r.cited ? "CITED " : "  -   "} ${engine.id.padEnd(10)} ${p.id}${r.position ? ` (#${r.position})` : ""}`);
    } catch (err) {
      failures++;
      results.push({ promptId: p.id, engine: engine.id, error: String(err.message || err).slice(0, 300) });
      console.error(`ERROR  ${engine.id.padEnd(10)} ${p.id}: ${err.message}`);
    }
  }
}

const run = {
  date,
  generatedAt: new Date().toISOString(),
  dryRun: DRY,
  brand: config.brand,
  engines: active.map((e) => ({ id: e.id, label: e.label })),
  prompts: config.prompts,
  results,
};

const outDir = path.join(root, DRY ? "data/runs-sample" : "data/runs");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${date}.json`);
await writeFile(outFile, JSON.stringify(run, null, 2) + "\n");

const cited = results.filter((r) => r.cited).length;
console.log(`\nWrote ${path.relative(root, outFile)}: cited in ${cited}/${results.length - failures} answers, ${failures} errors.`);

// Fail the workflow only if every single call failed (e.g. bad key)
if (failures && failures === results.length) process.exit(1);
