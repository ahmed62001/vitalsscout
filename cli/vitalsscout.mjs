#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { auditUrl, slugifyUrl } from './audit-engine.mjs';
import { renderHtmlReport, renderMarkdownSnapshot } from './report-generator.mjs';

function printHelp() {
  console.log(`VitalsScout v1.0.0 — WCAG 2.2 AA, Core Web Vitals & Technical SEO Auditor

Usage:
  vitalsscout <url> [--out <dir>] [--slug <name>] [--allow-localhost] [--quiet]

Options:
  --out <dir>         Directory to write audit outputs (default: ./vitalsscout-reports)
  --slug <name>       Base filename prefix (alphanumeric, hyphens, underscores only)
  --allow-localhost   Explicitly permit auditing loopback targets (127.0.0.1 / ::1 / localhost)
  --quiet             Suppress human summary output (prints output paths as JSON)
  -h, --help          Show this help message
`);
}

function sanitizeSlug(rawSlug, fallbackUrl) {
  const cleaned = String(rawSlug || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(cleaned)) {
    return slugifyUrl(fallbackUrl);
  }
  return cleaned;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }

  let url = null;
  let outDir = path.resolve(process.cwd(), 'vitalsscout-reports');
  let rawSlug = null;
  let allowLocalhost = false;
  let quiet = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--out' && args[i + 1]) {
      outDir = path.resolve(process.cwd(), args[i + 1]);
      i += 1;
    } else if (token === '--slug' && args[i + 1]) {
      rawSlug = args[i + 1];
      i += 1;
    } else if (token === '--allow-localhost') {
      allowLocalhost = true;
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

  return { help: false, url, outDir, slug: rawSlug ? sanitizeSlug(rawSlug, url) : slugifyUrl(url), allowLocalhost, quiet };
}

function resolveContainedFile(dir, filename) {
  const target = path.resolve(dir, filename);
  const rel = path.relative(dir, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing output path outside target directory: ${filename}`);
  }
  return target;
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

  const report = await auditUrl(opts.url, { allowLocalhost: opts.allowLocalhost });

  fs.mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = resolveContainedFile(opts.outDir, `${opts.slug}-audit.json`);
  const htmlPath = resolveContainedFile(opts.outDir, `${opts.slug}-report.html`);
  const mdPath = resolveContainedFile(opts.outDir, `${opts.slug}-snapshot.md`);

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
  const detail = process.env.VITALSSCOUT_DEBUG === '1' ? (err?.stack || err?.message || err) : (err?.message || 'Unexpected error');
  console.error(`[VitalsScout] Error: ${detail}`);
  process.exitCode = 1;
});
