#!/usr/bin/env node
/**
 * geosynced content drafter
 *
 * Looks at the latest tracker results, picks the question(s) where geosynced.io
 * is least cited and has no page yet, and asks Claude to draft an answer page.
 * The draft is written to src/answers/<slug>.md. The GitHub workflow then opens
 * it as a draft pull request, so nothing is published until you review and merge.
 *
 * Drafts never invent facts about geosynced. Wherever your own experience, data
 * or examples are needed, the draft contains a marker like:
 *   [[NEEDS INPUT: a real example of a client site blocked by Cloudflare bot settings]]
 * Markers show up highlighted on the preview site; fill or delete them before merging.
 *
 * Env:
 *   ANTHROPIC_API_KEY   required for real drafts
 *   ANTHROPIC_MODEL     optional, default "claude-sonnet-5-5"
 *   DRAFT_COUNT         optional, how many drafts per run (default 1)
 *
 * Usage:
 *   node scripts/draft.mjs              real draft
 *   node scripts/draft.mjs --dry-run    no API call, writes a placeholder draft to test the pipeline
 *   node scripts/draft.mjs --prompt=llms-txt   draft for a specific question id
 */
import { readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const forced = process.argv.find((a) => a.startsWith("--prompt="))?.slice(9);
const COUNT = Number(process.env.DRAFT_COUNT || 1);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const config = JSON.parse(await readFile(path.join(root, "tracker/prompts.json"), "utf8"));

// ---------- what already exists ----------

async function existingPromptIds() {
  const dir = path.join(root, "src/answers");
  const ids = new Set();
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".md")); } catch { return ids; }
  for (const f of files) {
    const m = (await readFile(path.join(dir, f), "utf8")).match(/^promptId:\s*"?([\w-]+)"?/m);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function openDraftBranches() {
  // Branches named draft/<promptId> mean a draft PR is already waiting for review
  try {
    return new Set(
      execSync("git ls-remote --heads origin 'draft/*'", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
        .toString().split("\n").map((l) => l.split("refs/heads/draft/")[1]).filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

async function latestRun() {
  const dir = path.join(root, "data/runs");
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
  if (!files.length) return null;
  return JSON.parse(await readFile(path.join(dir, files.at(-1)), "utf8"));
}

// ---------- pick what to write ----------

const TOPIC_WEIGHT = { Buying: 3, "How-to": 2, Technical: 2, Education: 1 };

function pickPrompts(run, skip) {
  return config.prompts
    .filter((p) => (forced ? p.id === forced : !skip.has(p.id)))
    .map((p) => {
      const rs = (run?.results || []).filter((r) => r.promptId === p.id && !r.error);
      const uncited = rs.length ? rs.filter((r) => !r.cited).length / rs.length : 1;
      return { prompt: p, results: rs, score: uncited * 10 + (TOPIC_WEIGHT[p.topic] || 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, forced ? 1 : COUNT);
}

// ---------- Claude ----------

const SYSTEM = `You write answer pages for geosynced.io, a small generative engine optimization (GEO / AEO) consultancy.
Each page answers one real question people ask AI search engines. The goal is a page that AI engines would want to cite: accurate, direct, specific, easy to quote.

Rules:
- Open with a direct 2-3 sentence answer to the question. No preamble.
- Then use plain, descriptive H2 headings (## in markdown) that match follow-up questions a reader would have.
- Be concrete: steps, settings, examples, trade-offs. Short paragraphs; lists where they help.
- Never invent statistics, studies, quotes, client names, prices, results, or anything about geosynced's own work.
- Where geosynced's real experience, data or an example would make the page stronger, insert a marker exactly like
  [[NEEDS INPUT: short description of what the owner should add]]. Use 2 to 4 markers. Put each on its own line.
- If something is uncertain or changes often (product settings, crawler names), say so and suggest checking the official docs.
- Do not copy wording from other sites. Write everything in your own words.
- Mention geosynced at most once, naturally, near the end. No sales pitch.
- Do not include a top-level # title; the page template adds it.
- 600 to 1000 words of body text. Plain English, active voice, no hype.
- Only list sources from the URLs provided to you, and only ones the content actually relies on.`;

const TOOL = {
  name: "save_draft",
  description: "Save the drafted answer page.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Page title phrased close to how people ask the question, under 70 characters" },
      slug: { type: "string", description: "URL slug, lowercase words joined by hyphens, under 60 characters" },
      description: { type: "string", description: "Meta description, one sentence, under 160 characters" },
      body: { type: "string", description: "Page body in markdown, starting with the direct answer" },
      faq: {
        type: "array",
        description: "3 to 5 short follow-up questions with 1-2 sentence answers",
        items: { type: "object", properties: { q: { type: "string" }, a: { type: "string" } }, required: ["q", "a"] },
      },
      sources: {
        type: "array",
        description: "Sources the content relies on, chosen only from the provided URLs",
        items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] },
      },
    },
    required: ["title", "slug", "description", "body", "faq", "sources"],
  },
};

function buildUserMessage(prompt, results) {
  const parts = [`Question to answer: "${prompt.text}"`, `Topic: ${prompt.topic}`];
  if (results.length) {
    parts.push("\nHere is what AI search engines currently answer, and which sources they cite. Cover what they cover, then go further and be more specific. Do not copy their wording.");
    for (const r of results) {
      parts.push(`\n--- ${r.engine} (${r.cited ? "cites geosynced" : "does not cite geosynced"}) ---\n${(r.answer || "").slice(0, 1500)}`);
      const urls = (r.sources || []).slice(0, 8).map((s) => `- ${s.url}`).join("\n");
      if (urls) parts.push(`Sources cited:\n${urls}`);
    }
  } else {
    parts.push("\nNo tracker data yet for this question. Use your own knowledge, flag anything time-sensitive, and leave sources empty.");
  }
  return parts.join("\n");
}

async function askClaude(prompt, results) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 6000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "save_draft" },
      messages: [{ role: "user", content: buildUserMessage(prompt, results) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const call = data.content?.find((c) => c.type === "tool_use");
  if (!call) throw new Error("Claude did not return a draft.");
  return call.input;
}

function fakeDraft(prompt) {
  return {
    title: prompt.text.replace(/\?$/, ""),
    slug: prompt.id,
    description: `Dry-run placeholder for: ${prompt.text}`,
    body: `This is a dry-run placeholder. A real run asks Claude to write the answer here.\n\n## What a real draft contains\n\nA direct answer first, then sections for follow-up questions.\n\n[[NEEDS INPUT: an example from your own client work]]\n`,
    faq: [{ q: "Is this a real draft?", a: "No. It was made with --dry-run to test the pipeline." }],
    sources: [],
  };
}

// ---------- write ----------

const yamlStr = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML

function toMarkdown(prompt, d) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `title: ${yamlStr(d.title)}`,
    `description: ${yamlStr(d.description)}`,
    `promptId: ${yamlStr(prompt.id)}`,
    `question: ${yamlStr(prompt.text)}`,
    `date: ${today}`,
    `faq: ${JSON.stringify(d.faq || [])}`,
    `sources: ${JSON.stringify(d.sources || [])}`,
    "---",
    "",
    d.body.trim(),
    "",
  ].join("\n");
}

function cleanSlug(s, fallback) {
  const slug = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return slug || fallback;
}

// ---------- main ----------

if (!DRY && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Use --dry-run to test without it.");
  process.exit(1);
}

const run = await latestRun();
const skip = new Set([...(await existingPromptIds()), ...openDraftBranches()]);
const picks = pickPrompts(run, skip);

if (!picks.length) {
  console.log("Nothing to draft: every question already has a page or an open draft.");
  process.exit(0);
}

const written = [];
for (const { prompt, results } of picks) {
  console.log(`Drafting: ${prompt.id}`);
  const d = DRY ? fakeDraft(prompt) : await askClaude(prompt, results);
  const slug = cleanSlug(d.slug, prompt.id);
  const file = path.join(root, "src/answers", `${slug}.md`);
  await writeFile(file, toMarkdown(prompt, d));
  const markers = [...d.body.matchAll(/\[\[NEEDS INPUT:\s*([^\]]+)\]\]/g)].map((m) => m[1].trim());
  written.push({ prompt, slug, title: d.title, file: path.relative(root, file), markers });
  console.log(`  wrote ${path.relative(root, file)} (${markers.length} input markers)`);
}

// Hand details to the GitHub workflow (one draft per PR, so it uses the first)
if (process.env.GITHUB_OUTPUT && written.length) {
  const w = written[0];
  await appendFile(process.env.GITHUB_OUTPUT, `prompt_id=${w.prompt.id}\nslug=${w.slug}\nfile=${w.file}\n`);
  const body = [
    `New answer page drafted for the tracked question:`,
    `> ${w.prompt.text}`,
    "",
    `File: \`${w.file}\``,
    "",
    "### Before merging",
    ...w.markers.map((m) => `- [ ] ${m}`),
    "- [ ] Read it through and fix anything inaccurate",
    "- [ ] Check the Cloudflare preview link below",
    "",
    "Merging publishes the page. The tracker will show whether AI engines start citing it.",
  ].join("\n");
  await writeFile(path.join(root, ".draft-pr-body.md"), body);
  await writeFile(path.join(root, ".draft-pr-title.txt"), `Draft answer: ${w.title}`);
}
