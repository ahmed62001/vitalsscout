import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { auditUrl } from '../cli/audit-engine.mjs';
import { renderHtmlReport, renderMarkdownSnapshot } from '../cli/report-generator.mjs';

const BAD_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bad Store</title>
  <style>
    body { font-family: sans-serif; background: #ffffff; color: #333333; margin: 20px; }
    .low-contrast { color: #b8c2cc; background: #ffffff; border: 1px solid #e2e8f0; padding: 8px; }
    .tiny-btn { display: inline-block; width: 16px; height: 16px; font-size: 10px; background: #0f172a; color: #fff; text-align: center; }
  </style>
</head>
<body>
  <div class="header">Roast & Craft</div>
  <p class="low-contrast">Low contrast promotional banner text that fails WCAG AA.</p>
  <img src="/hero.svg" />
  <form action="/subscribe">
    <input type="email" placeholder="Email address" />
    <button type="submit">Go</button>
  </form>
  <a href="/promo" class="tiny-btn">x</a>
  <a href="/details">click here</a>
</body>
</html>`;

const GOOD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Roast & Craft Coffee — Single-Origin Specialty Beans</title>
  <meta name="description" content="Small-batch ethically sourced specialty coffee roasted weekly in small lots with fast shipping." />
  <link rel="canonical" href="http://127.0.0.1/good" />
  <meta property="og:title" content="Roast & Craft Coffee" />
  <meta property="og:description" content="Small-batch ethically sourced specialty coffee." />
  <meta property="og:image" content="http://127.0.0.1/hero.svg" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Ethiopia Yirgacheffe Whole Bean"}
  </script>
  <style>
    body { font-family: system-ui, sans-serif; background: #ffffff; color: #0f172a; margin: 0; line-height: 1.5; }
    main { max-width: 720px; margin: 0 auto; padding: 24px; }
    .btn { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; padding: 10px 18px; background: #047857; color: #ffffff; border: 0; border-radius: 6px; font-weight: 600; text-decoration: none; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input { min-height: 44px; padding: 8px 12px; border: 1px solid #334155; border-radius: 6px; }
  </style>
</head>
<body>
  <header><nav aria-label="Primary navigation"><a class="btn" href="#main-content">Skip to main content</a></nav></header>
  <main id="main-content">
    <h1>Ethiopia Yirgacheffe Single-Origin Roast</h1>
    <p>Roasted fresh weekly with clean tasting notes of jasmine, bergamot, and cocoa.</p>
    <img src="/hero.svg" alt="Bag of Ethiopia Yirgacheffe coffee beans" width="600" height="320" />
    <form action="/subscribe">
      <label for="newsletter-email">Email address for roast drops</label>
      <input id="newsletter-email" name="email" type="email" autocomplete="email" />
      <button class="btn" type="submit">Subscribe to weekly drops</button>
    </form>
  </main>
</body>
</html>`;

const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320">
  <rect width="600" height="320" fill="#0f172a"/>
  <text x="40" y="170" fill="#10b981" font-family="sans-serif" font-size="32">Roast &amp; Craft Coffee</text>
</svg>`;

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/bad') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BAD_HTML);
        return;
      }
      if (req.url === '/good') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'Content-Security-Policy': "default-src 'self' 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        });
        res.end(GOOD_HTML);
        return;
      }
      if (req.url === '/hero.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        res.end(HERO_SVG);
        return;
      }
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function runTests() {
  const { server, baseUrl } = await startFixtureServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitalsscout-test-'));

  try {
    console.log(`Fixture server running at ${baseUrl}`);

    console.log('1/2 Auditing intentionally defective /bad fixture...');
    const badReport = await auditUrl(`${baseUrl}/bad`, { allowLocalhost: true });
    assert.ok(badReport.accessibility.violationCount >= 3, `Expected >= 3 WCAG violations on /bad, got ${badReport.accessibility.violationCount}`);
    assert.equal(badReport.domHygiene.htmlLang, '', 'Expected empty htmlLang on /bad');
    assert.equal(badReport.domHygiene.imagesMissingAlt, 1, 'Expected 1 image missing alt on /bad');
    assert.equal(badReport.domHygiene.unlabelledInputs, 1, 'Expected 1 unlabelled input on /bad');
    assert.ok(badReport.domHygiene.smallTapTargets >= 1, 'Expected small tap target detected on /bad');
    assert.ok((badReport.lighthouse.scores.accessibility ?? 100) < 90, `Expected accessibility < 90 on /bad, got ${badReport.lighthouse.scores.accessibility}`);
    assert.ok((badReport.lighthouse.scores.seo ?? 100) < 90, `Expected SEO < 90 on /bad, got ${badReport.lighthouse.scores.seo}`);

    console.log('2/2 Auditing remediated /good fixture...');
    const goodReport = await auditUrl(`${baseUrl}/good`, { allowLocalhost: true });
    assert.equal(goodReport.accessibility.violationCount, 0, `Expected 0 WCAG violations on /good, got ${JSON.stringify(goodReport.accessibility.violations)}`);
    assert.equal(goodReport.domHygiene.htmlLang, 'en', 'Expected htmlLang=en on /good');
    assert.equal(goodReport.domHygiene.imagesMissingAlt, 0, 'Expected 0 missing alt on /good');
    assert.equal(goodReport.domHygiene.unlabelledInputs, 0, 'Expected 0 unlabelled inputs on /good');
    assert.equal(goodReport.domHygiene.smallTapTargets, 0, 'Expected 0 small tap targets on /good');
    assert.ok((goodReport.lighthouse.scores.performance ?? 0) >= 95, `Expected performance >= 95 on /good, got ${goodReport.lighthouse.scores.performance}`);
    assert.ok((goodReport.lighthouse.scores.accessibility ?? 0) >= 95, `Expected accessibility >= 95 on /good, got ${goodReport.lighthouse.scores.accessibility}`);
    assert.ok((goodReport.lighthouse.scores.bestPractices ?? 0) >= 95, `Expected bestPractices >= 95 on /good, got ${goodReport.lighthouse.scores.bestPractices}`);
    assert.ok((goodReport.lighthouse.scores.seo ?? 0) >= 95, `Expected seo >= 95 on /good, got ${goodReport.lighthouse.scores.seo}`);

    // Verify artifact generation
    const htmlOut = renderHtmlReport(goodReport);
    const mdOut = renderMarkdownSnapshot(goodReport);
    const htmlPath = path.join(tmpDir, 'good-report.html');
    const mdPath = path.join(tmpDir, 'good-snapshot.md');
    fs.writeFileSync(htmlPath, htmlOut, 'utf8');
    fs.writeFileSync(mdPath, mdOut, 'utf8');

    assert.ok(fs.statSync(htmlPath).size > 2000, 'Expected substantial HTML report output');
    assert.ok(fs.statSync(mdPath).size > 300, 'Expected substantial Markdown snapshot output');
    assert.ok(htmlOut.includes('VitalsScout Technical Diagnostic Report'));
    assert.ok(mdOut.includes('VitalsScout 1-Page Diagnostic Snapshot'));

    console.log('\nPASS: All VitalsScout automated tests succeeded.');
    console.log('Bad fixture scores :', badReport.lighthouse.scores, 'WCAG violations:', badReport.accessibility.violationCount);
    console.log('Good fixture scores:', goodReport.lighthouse.scores, 'WCAG violations:', goodReport.accessibility.violationCount);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
