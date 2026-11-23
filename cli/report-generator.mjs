function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeInt(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? Math.trunc(val) : fallback;
}

function fmtMs(val) {
  if (typeof val !== 'number') return 'N/A';
  return val >= 1000 ? `${(val / 1000).toFixed(2)}s` : `${Math.round(val)}ms`;
}

function fmtBytes(val) {
  if (typeof val !== 'number') return 'N/A';
  if (val >= 1024 * 1024) return `${(val / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(val / 1024)} KiB`;
}

function scoreStatus(score) {
  if (typeof score !== 'number') return 'muted';
  if (score >= 90) return 'good';
  if (score >= 50) return 'warn';
  return 'poor';
}

function metricThresholdStatus(metric, value) {
  if (typeof value !== 'number') return 'muted';
  if (metric === 'lcp') return value <= 2500 ? 'good' : value <= 4000 ? 'warn' : 'poor';
  if (metric === 'fcp') return value <= 1800 ? 'good' : value <= 3000 ? 'warn' : 'poor';
  if (metric === 'cls') return value <= 0.1 ? 'good' : value <= 0.25 ? 'warn' : 'poor';
  if (metric === 'tbt') return value <= 200 ? 'good' : value <= 600 ? 'warn' : 'poor';
  return 'muted';
}

/**
 * Render a standalone, print-to-PDF-ready HTML client report.
 * @param {object} report
 * @returns {string}
 */
export function renderHtmlReport(report) {
  const s = report.lighthouse?.scores || {};
  const m = report.lighthouse?.metrics || {};
  const a = report.accessibility || {};
  const d = report.domHygiene || {};
  const hdr = report.http?.securityHeaders || {};
  const crawl = report.http?.crawlability || {};

  const scoreCards = [
    ['Performance', s.performance],
    ['Accessibility', s.accessibility],
    ['Best Practices', s.bestPractices],
    ['SEO', s.seo],
  ]
    .map(
      ([label, val]) => `
      <div class="score-card status-${scoreStatus(val)}">
        <div class="score-num">${typeof val === 'number' ? val : 'N/A'}</div>
        <div class="score-label">${esc(label)}</div>
      </div>`
    )
    .join('');

  const cwvRows = [
    ['Largest Contentful Paint (LCP)', fmtMs(m.lcpMs), '<= 2.50s', metricThresholdStatus('lcp', m.lcpMs)],
    ['First Contentful Paint (FCP)', fmtMs(m.fcpMs), '<= 1.80s', metricThresholdStatus('fcp', m.fcpMs)],
    ['Cumulative Layout Shift (CLS)', typeof m.cls === 'number' ? m.cls.toFixed(3) : 'N/A', '<= 0.100', metricThresholdStatus('cls', m.cls)],
    ['Total Blocking Time (TBT)', fmtMs(m.tbtMs), '<= 200ms', metricThresholdStatus('tbt', m.tbtMs)],
    ['Speed Index', fmtMs(m.speedIndexMs), '<= 3.40s', 'muted'],
    ['Total Page Weight', fmtBytes(m.totalBytes), 'Lean payload', 'muted'],
  ]
    .map(
      ([name, val, target, st]) => `
      <tr>
        <td>${esc(name)}</td>
        <td><span class="pill pill-${st}">${esc(val)}</span></td>
        <td>${esc(target)}</td>
      </tr>`
    )
    .join('');

  const fixRows = (report.prioritizedFixes || []).length
    ? report.prioritizedFixes
        .map(
          (f) => `
      <tr>
        <td><span class="pill pill-${f.priority === 'Critical' ? 'poor' : f.priority === 'Serious' ? 'warn' : 'muted'}">${esc(f.priority)}</span></td>
        <td>${esc(f.category)}</td>
        <td><strong>${esc(f.title)}</strong><div class="muted small">${esc(f.evidence)}</div></td>
        <td class="small">${esc(f.remediation)}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="4">No automated critical, serious, or moderate issues flagged on this URL.</td></tr>`;

  const wcagRows = (a.violations || []).length
    ? a.violations
        .map(
          (v) => `
      <div class="violation-box">
        <div class="v-head">
          <span class="pill pill-${v.impact === 'critical' ? 'poor' : v.impact === 'serious' ? 'warn' : 'muted'}">${esc(v.impact.toUpperCase())}</span>
          <strong>${esc(v.help)}</strong>
          <code>${esc(v.id)}</code>
          <span class="muted">(${v.nodeCount} node${v.nodeCount === 1 ? '' : 's'})</span>
        </div>
        <p class="small">${esc(v.description)} — Tags: <code>${esc((v.tags || []).join(', '))}</code></p>
        ${(v.sampleNodes || [])
          .map(
            (n) => `
          <div class="node-sample">
            <div><strong>Selector:</strong> <code>${esc(n.target)}</code></div>
            <div><strong>HTML:</strong> <code>${esc(n.html)}</code></div>
          </div>`
          )
          .join('')}
      </div>`
        )
        .join('')
    : `<div class="clean-banner">0 WCAG 2.0 / 2.1 / 2.2 A &amp; AA violations detected by axe-core (${esc(a.passesCount || 0)} rule checks passed).</div>`;

  const boolBadge = (ok, yes = 'Present', no = 'Missing') =>
    `<span class="pill pill-${ok ? 'good' : 'warn'}">${ok ? esc(yes) : esc(no)}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';" />
  <meta name="referrer" content="no-referrer" />
  <title>VitalsScout Audit Report — ${esc(report.finalUrl)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --good: #047857;
      --good-bg: #d1fae5;
      --warn: #b45309;
      --warn-bg: #fef3c7;
      --poor: #b91c1c;
      --poor-bg: #fee2e2;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.55;
      font-size: 15px;
    }
    .wrap { max-width: 1020px; margin: 0 auto; padding: 32px 20px 64px; }
    header {
      background: #0f172a;
      color: #f8fafc;
      padding: 28px;
      border-radius: 12px;
      margin-bottom: 24px;
    }
    header h1 { margin: 0 0 8px; font-size: 24px; }
    header p { margin: 4px 0; color: #cbd5e1; font-size: 14px; }
    .meta-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-size: 13px; color: #e2e8f0; }
    .scores { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .score-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      text-align: center;
    }
    .score-num { font-size: 36px; font-weight: 800; line-height: 1.1; }
    .score-label { margin-top: 6px; font-weight: 600; color: var(--muted); }
    .status-good .score-num { color: var(--good); }
    .status-warn .score-num { color: var(--warn); }
    .status-poor .score-num { color: var(--poor); }
    section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 22px;
      margin-bottom: 20px;
    }
    h2 { margin: 0 0 14px; font-size: 19px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    th { font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .pill-good { background: var(--good-bg); color: var(--good); }
    .pill-warn { background: var(--warn-bg); color: var(--warn); }
    .pill-poor { background: var(--poor-bg); color: var(--poor); }
    .pill-muted { background: #e2e8f0; color: #334155; }
    .small { font-size: 13px; }
    .muted { color: var(--muted); }
    code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; word-break: break-all; }
    .violation-box { border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
    .v-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
    .node-sample { background: #f8fafc; border-left: 3px solid var(--warn); padding: 8px 10px; margin-top: 8px; font-size: 12px; }
    .clean-banner { background: var(--good-bg); color: var(--good); padding: 14px; border-radius: 8px; font-weight: 600; }
    .disclaimer { font-size: 12px; color: var(--muted); background: #f1f5f9; padding: 14px; border-radius: 8px; }
    @media print {
      body { background: #fff; }
      .wrap { padding: 0; }
      section, .score-card { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <h1>VitalsScout Technical Diagnostic Report</h1>
      <p>Target URL: <strong>${esc(report.finalUrl)}</strong></p>
      <div class="meta-grid">
        <span>Audited: ${esc(report.auditedAt)}</span>
        <span>HTTP Status: ${esc(report.http?.statusCode ?? 'Unknown')}</span>
        <span>Detected Stack: ${esc((report.http?.platformSignals || []).join(', '))}</span>
        <span>Lighthouse v${esc(report.lighthouse?.lighthouseVersion || 'N/A')}</span>
        <span>axe-core v${esc(a.axeVersion || 'N/A')}</span>
      </div>
    </header>

    <div class="scores" aria-label="Lighthouse Mobile Category Scores">
      ${scoreCards}
    </div>

    <section>
      <h2>1. Core Web Vitals &amp; Mobile Performance Metrics</h2>
      <table>
        <thead><tr><th>Metric</th><th>Measured (Mobile)</th><th>Target Threshold</th></tr></thead>
        <tbody>${cwvRows}</tbody>
      </table>
    </section>

    <section>
      <h2>2. Prioritized Remediation Roadmap (${(report.prioritizedFixes || []).length} Findings)</h2>
      <table>
        <thead><tr><th>Priority</th><th>Area</th><th>Finding &amp; Evidence</th><th>Recommended Fix</th></tr></thead>
        <tbody>${fixRows}</tbody>
      </table>
    </section>

    <section>
      <h2>3. WCAG 2.0 / 2.1 / 2.2 A &amp; AA Automated Scan (${a.violationCount ?? 0} Rule Violations, ${a.totalViolationNodes ?? 0} Nodes)</h2>
      ${wcagRows}
    </section>

    <section>
      <h2>4. Technical SEO, DOM &amp; HTTP Security Hygiene</h2>
      <table>
        <thead><tr><th>Check</th><th>Observed Status</th></tr></thead>
        <tbody>
          <tr><td>&lt;title&gt; Tag (${safeInt(d.titleLength)} chars)</td><td>${esc(d.title || 'Missing')}</td></tr>
          <tr><td>Meta Description (${safeInt(d.metaDescriptionLength)} chars)</td><td>${esc(d.metaDescription || 'Missing')}</td></tr>
          <tr><td>Canonical URL</td><td>${esc(d.canonical || 'Missing')}</td></tr>
          <tr><td>&lt;html lang&gt; Attribute</td><td>${boolBadge(Boolean(d.htmlLang), d.htmlLang || 'Present', 'Missing')}</td></tr>
          <tr><td>&lt;h1&gt; Count</td><td>${safeInt(d.h1Count)}</td></tr>
          <tr><td>Images Missing Alt / Dimensions</td><td>${safeInt(d.imagesMissingAlt)} missing alt / ${safeInt(d.imagesMissingDimensions)} missing width-height (of ${safeInt(d.totalImages)})</td></tr>
          <tr><td>Unlabelled Visible Form Fields</td><td>${safeInt(d.unlabelledInputs)}</td></tr>
          <tr><td>Small Interactive Targets (&lt;24x24px)</td><td>${safeInt(d.smallTapTargets)}</td></tr>
          <tr><td>JSON-LD Structured Data Blocks</td><td>${safeInt(d.jsonLdCount)}</td></tr>
          <tr><td>robots.txt / sitemap.xml</td><td>${boolBadge(crawl.robotsTxt?.present, 'robots.txt OK', 'robots.txt missing')} ${boolBadge(crawl.sitemapXml?.present, 'sitemap.xml OK', 'sitemap.xml missing')}</td></tr>
          <tr><td>HTTPS / HSTS / CSP / XCTO / Compression</td><td>
            ${boolBadge(hdr.https, 'HTTPS', 'No HTTPS')}
            ${boolBadge(hdr.strictTransportSecurity, 'HSTS', 'No HSTS')}
            ${boolBadge(hdr.contentSecurityPolicy, 'CSP', 'No CSP')}
            ${boolBadge(hdr.xContentTypeOptions, 'XCTO', 'No XCTO')}
            ${boolBadge(hdr.compression, 'Compressed', 'Uncompressed')}
          </td></tr>
        </tbody>
      </table>
    </section>

    <p class="disclaimer">
      <strong>Scope &amp; Legal Notice:</strong> Generated by VitalsScout v${esc(report.version)} using Google Lighthouse (mobile emulation) and axe-core (WCAG 2.0/2.1/2.2 A &amp; AA). Automated checks do not substitute for full assistive-technology keyboard/screen-reader testing. This technical report does not constitute legal advice or a legal compliance warranty under ADA, EAA, or local regulations.
    </p>
  </main>
</body>
</html>`;
}

/**
 * Render a concise 1-page diagnostic snapshot in Markdown.
 * @param {object} report
 * @returns {string}
 */
export function renderMarkdownSnapshot(report) {
  const s = report.lighthouse?.scores || {};
  const m = report.lighthouse?.metrics || {};
  const a = report.accessibility || {};
  const d = report.domHygiene || {};

  const topFixes = (report.prioritizedFixes || [])
    .slice(0, 6)
    .map((f, i) => `${i + 1}. **[${f.priority}] ${f.title}** — ${f.evidence}`)
    .join('\n');

  return `# VitalsScout 1-Page Diagnostic Snapshot

- **Audited URL:** ${report.finalUrl}
- **Audited At:** ${report.auditedAt}
- **Detected Stack:** ${(report.http?.platformSignals || []).join(', ')}
- **HTTP Status:** ${report.http?.statusCode ?? 'N/A'}

## Mobile Lighthouse Scores
| Performance | Accessibility | Best Practices | SEO |
|---:|---:|---:|---:|
| ${s.performance ?? 'N/A'}/100 | ${s.accessibility ?? 'N/A'}/100 | ${s.bestPractices ?? 'N/A'}/100 | ${s.seo ?? 'N/A'}/100 |

## Core Web Vitals & Accessibility Summary
- **LCP:** ${fmtMs(m.lcpMs)} | **FCP:** ${fmtMs(m.fcpMs)} | **CLS:** ${typeof m.cls === 'number' ? m.cls.toFixed(3) : 'N/A'} | **TBT:** ${fmtMs(m.tbtMs)} | **Weight:** ${fmtBytes(m.totalBytes)}
- **WCAG 2.2 AA (axe-core):** ${a.violationCount ?? 0} violation rule(s) across ${a.totalViolationNodes ?? 0} DOM node(s)
- **DOM/SEO Checks:** \`<html lang>\`: ${d.htmlLang || 'Missing'} | Meta description: ${d.metaDescriptionLength ? `${d.metaDescriptionLength} chars` : 'Missing'} | Canonical: ${d.canonical ? 'Present' : 'Missing'} | Images missing alt: ${d.imagesMissingAlt ?? 0} | Unlabelled inputs: ${d.unlabelledInputs ?? 0} | Small targets (<24px): ${d.smallTapTargets ?? 0}

## Top Prioritized Findings
${topFixes || '_No critical, serious, or moderate issues flagged._'}

---
*Automated mobile diagnostic via VitalsScout (Google Lighthouse + axe-core). Not legal advice or an ADA/EAA compliance guarantee.*
`;
}
