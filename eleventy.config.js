export default function (eleventyConfig) {
  // Files copied to the site as-is
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });

  // Drafts mark missing owner input as [[NEEDS INPUT: ...]]. Show these as a loud
  // highlighted box, so they are impossible to miss on a preview deploy.
  eleventyConfig.addTransform("needs-input", function (content) {
    if (!(this.page.outputPath || "").endsWith(".html")) return content;
    return content.replace(
      /\[\[NEEDS INPUT:\s*([^\]]+)\]\]/g,
      '<mark class="needs-input"><strong>Needs your input:</strong> $1</mark>'
    );
  });

  // Rebuild when tracker results change during `npm run dev`
  eleventyConfig.addWatchTarget("./data/runs/");

  // "2026-10-14" -> "14 Oct 2026"
  eleventyConfig.addFilter("readableDate", (value) => {
    if (!value) return "";
    const d = new Date(value);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  });

  // ISO date for sitemap / schema
  eleventyConfig.addFilter("isoDate", (value) => new Date(value || Date.now()).toISOString().slice(0, 10));

  // Find the published answer page for a tracker question id
  eleventyConfig.addFilter("answerFor", (answers = [], promptId) =>
    (answers || []).find((a) => a.data.promptId === promptId)
  );

  // [{rate: 0.2}, ...] | pluck("rate") -> [0.2, ...]
  eleventyConfig.addFilter("pluck", (arr = [], key) => arr.map((x) => x[key]));

  eleventyConfig.addFilter("percent", (n) => (n == null ? "–" : `${Math.round(n * 100)}%`));

  // Inline SVG sparkline from an array of 0..1 values, built at build time (no JS needed on the page)
  eleventyConfig.addFilter("sparkline", (values = [], width = 160, height = 32) => {
    if (!values.length) return "";
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    const pts = values
      .map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - v * (height - 4)).toFixed(1)}`)
      .join(" ");
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Citation rate over time"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  });

  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
