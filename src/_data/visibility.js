// Reads every tracker run in data/runs/*.json and shapes it for the proof page.
// If there are no real runs yet, it falls back to data/runs-sample/ (dry-run data)
// and marks the result as a sample so the page can say so.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function loadRuns(dir) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  const runs = [];
  for (const f of files) {
    try {
      runs.push(JSON.parse(await readFile(path.join(dir, f), "utf8")));
    } catch {
      /* skip a broken file rather than failing the whole build */
    }
  }
  return runs;
}

export default async function () {
  let runs = await loadRuns(path.resolve("data/runs"));
  let isSample = false;
  if (!runs.length) {
    runs = await loadRuns(path.resolve("data/runs-sample"));
    isSample = runs.length > 0;
  }
  if (!runs.length) return { hasData: false, isSample: false };

  const latest = runs[runs.length - 1];
  const engines = latest.engines;
  const isOwn = (d) => latest.brand.domains.some((own) => d === own || d.endsWith("." + own));
  const ok = (r) => !r.error;

  // Share of answers citing us, per day (for the overall trend line)
  const daily = runs.map((run) => {
    const valid = run.results.filter(ok);
    const cited = valid.filter((r) => r.cited).length;
    return { date: run.date, rate: valid.length ? cited / valid.length : 0, cited, total: valid.length };
  });

  // Per prompt: latest status per engine + rate history
  const prompts = latest.prompts.map((p) => {
    const byEngine = engines.map((e) => {
      const r = latest.results.find((x) => x.promptId === p.id && x.engine === e.id);
      return {
        engine: e.id,
        label: e.label,
        status: !r ? "missing" : r.error ? "error" : r.cited ? "cited" : "not-cited",
        position: r?.position ?? null,
        topSources: (r?.sources || [])
          .map((s) => s.domain)
          .filter((d) => d && !isOwn(d))
          .slice(0, 4),
      };
    });
    const history = runs.map((run) => {
      const rs = run.results.filter((x) => x.promptId === p.id && ok(x));
      return rs.length ? rs.filter((x) => x.cited).length / rs.length : 0;
    });
    const firstCited = runs.find((run) => run.results.some((x) => x.promptId === p.id && x.cited));
    return { ...p, byEngine, history, firstCitedOn: firstCited?.date || null };
  });

  // Which other domains AI engines cite most across all prompts (latest run)
  const counts = {};
  for (const r of latest.results.filter(ok)) {
    for (const s of r.sources || []) {
      if (!s.domain || isOwn(s.domain)) continue;
      counts[s.domain] = (counts[s.domain] || 0) + 1;
    }
  }
  const topDomains = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([domain, count]) => ({ domain, count }));

  const today = daily[daily.length - 1];
  return {
    hasData: true,
    isSample,
    firstDate: runs[0].date,
    lastDate: latest.date,
    days: runs.length,
    engines,
    today,
    daily,
    prompts,
    topDomains,
    promptsCitedToday: prompts.filter((p) => p.byEngine.some((e) => e.status === "cited")).length,
  };
}
