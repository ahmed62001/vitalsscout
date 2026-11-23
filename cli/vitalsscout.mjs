#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { auditUrl, slugifyUrl } from './audit-engine.mjs';
import { renderHtmlReport, renderMarkdownSnapshot } from './report-generator.mjs';

function printHelp() {
  console.log(`VitalsScout v1.0.0 — WCAG 2.2 AA, Core Web Vitals & Technical SEO Auditor

Usage:
  vitalsscout <url> [--out <dir>] [--slug <name>] [--quiet]

Options:
  --out <dir>    Directory to write audit outputs (default: ./vitalsscout-reports)
  --slug <name>  Base filename prefix (default: derived from URL)
  --quiet        Suppress human summary output (prints output paths as JSON)
  -h, --help     Show this help message
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }

  let url = null;
  let outDir = path.resolve(process.cwd(), 'vitalsscout-reports');
  let slug = null;
  let quiet = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--out' && args[i + 1]) {
      outDir = path.resolve(process.cwd(), args[i + 1]);
      i += 1;
    } else if (token === '--slug' && args[i + 1]) {
      slug = args[i + 1].replace(/[^a-zA-Z0-9_-]+/g, '-');
      i += 1;
    } else if (token === '--quiet') {
      quiet = true;
    } else if (!token.startsWith('-') && !url) {
      url = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }

  if (!url) {
    throw new Error('Missing target <url>.');
  }

  return { help: false, url, outDir, slug: slug || slugifyUrl(url), quiet };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.quiet) {
    console.log(`[VitalsScout] Auditing ${opts.url} ...`);
  }

  const report = await auditUrl(opts.url);

  fs.mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = path.join(opts.outDir, `${opts.slug}-audit.json`);
  const htmlPath = path.join(opts.outDir, `${opts.slug}-report.html`);
  const mdPath = path.join(opts.outDir, `${opts.slug}-snapshot.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(htmlPath, renderHtmlReport(report), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdownSnapshot(report), 'utf8');

  if (opts.quiet) {
    console.log(JSON.stringify({
      finalUrl: report.finalUrl,
      scores: report.lighthouse.scores,
      wcagViolations: report.accessibility.violationCount,
      files: { jsonPath, htmlPath, mdPath },
    }));
    return;
  }

  const s = report.lighthouse.scores;
  const m = report.lighthouse.metrics;
  console.log(`\n=== VitalsScout Audit Complete: ${report.finalUrl} ===`);
  console.log(
    `Scores (Mobile) -> Performance: ${s.performance ?? 'N/A'} | Accessibility: ${s.accessibility ?? 'N/A'} | Best Practices: ${s.bestPractices ?? 'N/A'} | SEO: ${s.seo ?? 'N/A'}`
  );
  console.log(
    `Core Web Vitals -> LCP: ${typeof m.lcpMs === 'number' ? (m.lcpMs / 1000).toFixed(2) + 's' : 'N/A'} | CLS: ${typeof m.cls === 'number' ? m.cls.toFixed(3) : 'N/A'} | TBT: ${typeof m.tbtMs === 'number' ? Math.round(m.tbtMs) + 'ms' : 'N/A'}`
  );
  console.log(
    `WCAG 2.2 AA     -> ${report.accessibility.violationCount} violation rule(s), ${report.accessibility.totalViolationNodes} affected node(s)`
  );
  console.log(`Prioritized Fix -> ${report.prioritizedFixes.length} total item(s)`);
  console.log(`Saved JSON      -> ${jsonPath}`);
  console.log(`Saved HTML      -> ${htmlPath}`);
  console.log(`Saved Snapshot  -> ${mdPath}`);
}

main().catch((err) => {
  console.error(`[VitalsScout] Fatal error: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
