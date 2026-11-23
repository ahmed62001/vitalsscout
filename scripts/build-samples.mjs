import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditUrl } from '../cli/audit-engine.mjs';
import { renderHtmlReport } from '../cli/report-generator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = fs.realpathSync(path.resolve(__dirname, '../docs'));
const PUBLIC_BASE_URL = 'https://ahmed62001.github.io/vitalsscout';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/**
 * Resolve a request URL safely inside realRoot using canonical path containment.
 * Prevents %2e%2e traversal, null bytes, sibling-prefix bypass, and symlink escapes.
 * @param {string} rawReqUrl
 * @param {string} realRoot
 * @returns {{ status: number, filePath?: string }}
 */
export function resolveStaticPath(rawReqUrl, realRoot) {
  const rawPath = String(rawReqUrl || '/').split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return { status: 400 };
  }

  const cleanRel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!cleanRel) {
    return { status: 404 };
  }

  const candidate = path.resolve(realRoot, cleanRel);
  const relCandidate = path.relative(realRoot, candidate);
  if (!relCandidate || relCandidate.startsWith('..') || path.isAbsolute(relCandidate)) {
    return { status: 403 };
  }

  if (!fs.existsSync(candidate)) {
    return { status: 404 };
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    return { status: 404 };
  }

  const relReal = path.relative(realRoot, realTarget);
  if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) {
    return { status: 403 };
  }

  const st = fs.statSync(realTarget);
  if (!st.isFile()) {
    return { status: 404 };
  }

  return { status: 200, filePath: realTarget };
}

export function startDocsServer(rootDir = docsDir) {
  const realRoot = fs.realpathSync(rootDir);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      if (reqPath === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (reqPath === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
        return;
      }

      const resolved = resolveStaticPath(req.url || '/', realRoot);
      if (resolved.status !== 200) {
        res.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end(resolved.status === 400 ? 'Bad Request' : resolved.status === 403 ? 'Forbidden' : 'Not Found');
        return;
      }

      const ext = path.extname(resolved.filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(resolved.filePath).pipe(res);
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
      const before = await auditUrl(`${baseUrl}/demo-before.html`, {
        allowLocalhost: true,
        displayUrl: `${PUBLIC_BASE_URL}/demo-before.html`,
      });
      fs.writeFileSync(path.join(docsDir, 'sample-before-report.html'), renderHtmlReport(before), 'utf8');

      console.log('[build-samples] Auditing demo-after.html...');
      const after = await auditUrl(`${baseUrl}/demo-after.html`, {
        allowLocalhost: true,
        displayUrl: `${PUBLIC_BASE_URL}/demo-after.html`,
      });
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
      const selfReport = await auditUrl(`${baseUrl}/index.html`, {
        allowLocalhost: true,
        displayUrl: `${PUBLIC_BASE_URL}/`,
      });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}
