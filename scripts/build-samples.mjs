import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditUrl } from '../cli/audit-engine.mjs';
import { renderHtmlReport } from '../cli/report-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, '../docs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function startDocsServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      if (reqPath === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (reqPath === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
        return;
      }
      const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
      const fullPath = path.resolve(docsDir, cleanRel);
      if (!fullPath.startsWith(docsDir) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(fullPath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main() {
  const onlySelf = process.argv.includes('--self-only');
  const { server, baseUrl } = await startDocsServer();

  try {
    if (!onlySelf) {
      console.log('[build-samples] Auditing demo-before.html...');
      const before = await auditUrl(`${baseUrl}/demo-before.html`);
      fs.writeFileSync(path.join(docsDir, 'sample-before-report.html'), renderHtmlReport(before), 'utf8');

      console.log('[build-samples] Auditing demo-after.html...');
      const after = await auditUrl(`${baseUrl}/demo-after.html`);
      fs.writeFileSync(path.join(docsDir, 'sample-after-report.html'), renderHtmlReport(after), 'utf8');

      const summary = {
        before: {
          scores: before.lighthouse.scores,
          metrics: before.lighthouse.metrics,
          wcagViolations: before.accessibility.violationCount,
          wcagNodes: before.accessibility.totalViolationNodes,
          fixes: before.prioritizedFixes.length,
        },
        after: {
          scores: after.lighthouse.scores,
          metrics: after.lighthouse.metrics,
          wcagViolations: after.accessibility.violationCount,
          wcagNodes: after.accessibility.totalViolationNodes,
          fixes: after.prioritizedFixes.length,
        },
      };
      console.log('DEMO_METRICS=' + JSON.stringify(summary, null, 2));
    }

    if (fs.existsSync(path.join(docsDir, 'index.html'))) {
      console.log('[build-samples] Running self-audit on docs/index.html...');
      const selfReport = await auditUrl(`${baseUrl}/index.html`);
      fs.writeFileSync(path.join(docsDir, 'self-audit-report.html'), renderHtmlReport(selfReport), 'utf8');
      console.log('SELF_AUDIT=' + JSON.stringify({
        scores: selfReport.lighthouse.scores,
        metrics: selfReport.lighthouse.metrics,
        wcagViolations: selfReport.accessibility.violationCount,
        wcagNodes: selfReport.accessibility.totalViolationNodes,
        fixes: selfReport.prioritizedFixes.map((f) => f.title),
      }, null, 2));
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
