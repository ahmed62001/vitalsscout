import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSafeTargetUrl, auditUrl, isBlockedIp } from '../cli/audit-engine.mjs';
import { renderHtmlReport } from '../cli/report-generator.mjs';
import { recordVerifiedTransactionAtomically } from '../cli/verify-usdt-payment.mjs';
import { resolveStaticPath } from '../scripts/build-samples.mjs';
import {
  BSC_CHAIN_ID_HEX,
  PAYMENT_STATES,
  RECEIVING_WALLET,
  TRANSFER_TOPIC,
  USDT_BEP20_CONTRACT,
  isAllowedRpcUrl,
  verifyUsdtBep20Payment,
} from '../docs/assets/usdt-verifier.js';

const execFileAsync = promisify(execFile);

function padAddress(addr) {
  return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
}

function encodeUint256(val) {
  return '0x' + val.toString(16).padStart(64, '0');
}

async function runSecurityTests() {
  // =========================================================================
  // 1. HTML Report XSS & CSP Hardening
  // =========================================================================
  const xssReport = renderHtmlReport({
    tool: 'VitalsScout',
    version: '1.0.0',
    auditedAt: '2026-11-23T00:00:00Z',
    finalUrl: 'https://example.com/"<script>alert(1)</script>',
    http: { statusCode: 200, platformSignals: ['<img src=x onerror=alert(2)>'], securityHeaders: {}, crawlability: {} },
    lighthouse: { lighthouseVersion: '13.6.0', scores: { performance: 50, accessibility: 50, bestPractices: 50, seo: 50 }, metrics: {} },
    accessibility: {
      axeVersion: '4.14.1',
      violationCount: 1,
      totalViolationNodes: 1,
      violations: [{
        id: 'html-has-lang',
        impact: 'serious',
        help: 'Test',
        description: 'Desc',
        tags: ['wcag2a'],
        nodeCount: 1,
        sampleNodes: [{ target: "a[href='x\" onerror=\"alert(3)']", html: '<img src=x onerror=alert(4)>' }],
      }],
    },
    domHygiene: {
      title: 'Title<script>alert(5)</script>',
      titleLength: 29,
      metaDescription: "Desc'\"<b>",
      metaDescriptionLength: 8,
      canonical: 'https://example.com/',
      htmlLang: "en'><script>alert(6)</script>",
      h1Count: 1,
      imagesMissingAlt: 0,
      imagesMissingDimensions: 0,
      totalImages: 0,
      unlabelledInputs: 0,
      smallTapTargets: 0,
      jsonLdCount: 0,
    },
    prioritizedFixes: [{
      priority: 'Critical',
      category: 'XSS',
      title: 'Fix<script>alert(7)</script>',
      evidence: "'\"<script>alert(8)</script>",
      remediation: 'Escape cleanly',
    }],
  });

  assert.ok(!xssReport.includes('<script>alert('), 'Unescaped <script> tag in HTML report');
  assert.ok(!xssReport.includes('<img src=x'), 'Unescaped <img> tag in HTML report');
  assert.ok(!/<[^>]*\bonerror\s*=/i.test(xssReport), 'Unescaped event-handler attribute inside an HTML element');
  assert.ok(xssReport.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'URL payload must be HTML-entity encoded');
  assert.ok(xssReport.includes('&lt;img src=x onerror=alert(2)&gt;'), 'Platform payload must be HTML-entity encoded');
  assert.ok(xssReport.includes("default-src 'none'"), 'Report HTML must include strict CSP meta');
  assert.ok(xssReport.includes('<meta name="referrer" content="no-referrer"'), 'Report HTML must include no-referrer meta');
  assert.ok(xssReport.includes('en&#39;&gt;&lt;script&gt;'), 'htmlLang in boolBadge must be HTML-escaped');

  // =========================================================================
  // 2. SSRF & Redirect Protections
  // =========================================================================
  for (const badIp of ['127.0.0.1', '10.0.0.1', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', 'fe80::1', 'fc00::1']) {
    assert.equal(isBlockedIp(badIp, { allowLoopback: false }), true, `Expected blocked IP: ${badIp}`);
  }
  assert.equal(isBlockedIp('8.8.8.8', { allowLoopback: false }), false, 'Public IPv4 should be allowed');
  assert.equal(isBlockedIp('169.254.169.254', { allowLoopback: true }), true, 'Cloud metadata IP must NEVER be allowed even with allowLoopback=true');

  const blockedUrls = [
    'http://127.0.0.1:8080/',
    'http://localhost/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://10.0.0.1/',
    'http://192.168.1.10/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'file:///etc/passwd',
    'https://admin:secret@example.com/',
  ];
  for (const u of blockedUrls) {
    await assert.rejects(() => assertSafeTargetUrl(u, { allowLocalhost: false }), /Blocked|Unsupported protocol|credentials/, `Expected SSRF reject for ${u}`);
  }
  // Metadata URL must still fail even when allowLocalhost=true
  await assert.rejects(() => assertSafeTargetUrl('http://169.254.169.254/latest/meta-data/', { allowLocalhost: true }), /Blocked/);

  // Redirect SSRF test: local 302 redirecting to AWS metadata IP must abort BEFORE launching Chrome
  const redirServer = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise((r) => redirServer.listen(0, '127.0.0.1', r));
  try {
    const port = redirServer.address().port;
    await assert.rejects(
      () => auditUrl(`http://127.0.0.1:${port}/`, { allowLocalhost: true }),
      /Blocked non-public target IP address: 169\.254\.169\.254/
    );
  } finally {
    redirServer.close();
  }

  // =========================================================================
  // 3. Path Traversal & CLI Slug Containment
  // =========================================================================
  const tmpSecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitalsscout-sec-'));
  try {
    const publicDir = path.join(tmpSecDir, 'docs');
    const outsideSecret = path.join(tmpSecDir, 'secret.txt');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>OK</h1>', 'utf8');
    fs.writeFileSync(outsideSecret, 'TOP_SECRET', 'utf8');
    fs.symlinkSync(outsideSecret, path.join(publicDir, 'escape-link.txt'));

    const realPublic = fs.realpathSync(publicDir);
    assert.equal(resolveStaticPath('/index.html', realPublic).status, 200);
    assert.equal(resolveStaticPath('/../secret.txt', realPublic).status, 403);
    assert.equal(resolveStaticPath('/%2e%2e/secret.txt', realPublic).status, 403);
    assert.equal(resolveStaticPath('/%00index.html', realPublic).status, 400);
    assert.equal(resolveStaticPath('/%ZZinvalid', realPublic).status, 400);
    assert.equal(resolveStaticPath('/escape-link.txt', realPublic).status, 403, 'Symlink outside root must be 403');
  } finally {
    fs.rmSync(tmpSecDir, { recursive: true, force: true });
  }

  // =========================================================================
  // 4. Payment Security, Quorum, Time Window & Atomic Replay Lock
  // =========================================================================
  const TX = '0x' + 'b2'.repeat(32);
  const SENDER = '0x1111111111111111111111111111111111111111';
  const nowMs = Date.UTC(2026, 10, 23, 3, 0, 0);
  const recentBlockSec = Math.floor((nowMs - 120 * 1000) / 1000);
  const oldBlockSec = Math.floor((nowMs - 90000 * 1000) / 1000); // > 24h ago

  // Reject http:// RPC endpoint
  const rHttpRpc = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['http://insecure.rpc.example/'],
  });
  assert.equal(rHttpRpc.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rHttpRpc.status, 'INVALID_RPC_URL');
  assert.equal(isAllowedRpcUrl('http://localhost:8545/'), false);
  assert.equal(isAllowedRpcUrl('https://user:pass@bsc-dataseed.binance.org/'), false);

  // Reject reorged (removed=true) transfer log & malformed topic padding & receiptHash mismatch
  const makeLog = (overrides = {}) => ({
    address: USDT_BEP20_CONTRACT,
    topics: [TRANSFER_TOPIC, padAddress(SENDER), padAddress(RECEIVING_WALLET)],
    data: encodeUint256(20860000000000000000n),
    removed: false,
    ...overrides,
  });

  const makeRpcFetch = (handler) => async (url, init) => {
    const body = JSON.parse(init.body);
    const result = handler(url, body.method, body.params);
    return { ok: true, status: 200, async json() { return { jsonrpc: '2.0', id: body.id, result }; } };
  };

  // 4a. Receipt hash mismatch
  const rMismatch = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    nowMs,
    fetchImpl: makeRpcFetch((_u, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getTransactionReceipt') return { transactionHash: '0x' + 'f'.repeat(64), status: '0x1', blockNumber: '0x3e0', logs: [makeLog()] };
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + recentBlockSec.toString(16) };
      return null;
    }),
  });
  assert.equal(rMismatch.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rMismatch.status, 'RECEIPT_HASH_MISMATCH');

  // 4b. Reorg log removed=true
  const rReorg = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    nowMs,
    fetchImpl: makeRpcFetch((_u, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getTransactionReceipt') return { transactionHash: TX, status: '0x1', blockNumber: '0x3e0', logs: [makeLog({ removed: true })] };
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + recentBlockSec.toString(16) };
      return null;
    }),
  });
  assert.equal(rReorg.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rReorg.status, 'NO_MATCHING_USDT_TRANSFER');

  // 4c. Dirty topic upper 12 bytes
  const rDirtyTopic = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    nowMs,
    fetchImpl: makeRpcFetch((_u, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getTransactionReceipt') {
        return {
          transactionHash: TX,
          status: '0x1',
          blockNumber: '0x3e0',
          logs: [makeLog({ topics: [TRANSFER_TOPIC, padAddress(SENDER), '0xdeadbeef' + '0'.repeat(16) + RECEIVING_WALLET.slice(2).toLowerCase()] })],
        };
      }
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + recentBlockSec.toString(16) };
      return null;
    }),
  });
  assert.equal(rDirtyTopic.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rDirtyTopic.status, 'NO_MATCHING_USDT_TRANSFER');

  // 4d. Pre-order tx rejection (old replay before orderCreatedAt)
  const rPreOrder = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    orderCreatedAt: nowMs - 10 * 1000,
    nowMs,
    fetchImpl: makeRpcFetch((_u, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getTransactionReceipt') return { transactionHash: TX, status: '0x1', blockNumber: '0x3e0', logs: [makeLog()] };
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + recentBlockSec.toString(16) };
      return null;
    }),
  });
  assert.equal(rPreOrder.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rPreOrder.status, 'TX_PRE_ORDER');

  // 4e. Expired payment state
  const rExpired = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    nowMs,
    maxAgeSeconds: 86400,
    fetchImpl: makeRpcFetch((_u, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getTransactionReceipt') return { transactionHash: TX, status: '0x1', blockNumber: '0x3e0', logs: [makeLog()] };
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + oldBlockSec.toString(16) };
      return null;
    }),
  });
  assert.equal(rExpired.verified, false);
  assert.equal(rExpired.paymentState, PAYMENT_STATES.EXPIRED);
  assert.equal(rExpired.status, 'PAYMENT_EXPIRED');

  // 4f. 2-of-N RPC Quorum disagreement detection
  const rQuorumMismatch = await verifyUsdtBep20Payment({
    txHash: TX,
    serviceKey: 'audit',
    rpcEndpoints: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
    nowMs,
    fetchImpl: makeRpcFetch((url, m) => {
      if (m === 'eth_chainId') return BSC_CHAIN_ID_HEX;
      if (m === 'eth_blockNumber') return '0x3e8';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + recentBlockSec.toString(16) };
      if (m === 'eth_getTransactionReceipt') {
        const logs = url.includes('rpc2') ? [makeLog({ data: encodeUint256(1000000000000000000n) })] : [makeLog()];
        return { transactionHash: TX, status: '0x1', blockNumber: '0x3e0', logs };
      }
      return null;
    }),
  });
  assert.equal(rQuorumMismatch.verified, false);
  assert.equal(rQuorumMismatch.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(rQuorumMismatch.status, 'RPC_CONSENSUS_MISMATCH');

  // 4g. Concurrent TOCTOU atomic registry lock check (5 parallel claims -> 1 succeeds, 4 fail)
  const tmpLockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitalsscout-lock-'));
  try {
    const regPath = path.join(tmpLockDir, 'verified.json');
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        recordVerifiedTransactionAtomically(regPath, {
          txHash: TX,
          orderId: `ORDER-${idx}`,
          verified: true,
          paymentState: PAYMENT_STATES.CONFIRMED,
        })
      )
    );
    const okCount = claims.filter((c) => c.verified === true).length;
    const dupeCount = claims.filter((c) => c.status === 'DUPLICATE_TX_ALREADY_REDEEMED').length;
    assert.equal(okCount, 1, `Exactly 1 concurrent claim may succeed, got ${okCount}`);
    assert.equal(dupeCount, 4, `Exactly 4 concurrent claims must reject as duplicates, got ${dupeCount}`);

    // Duplicate --order-id across distinct txHash rejected too
    const dupOrder = await recordVerifiedTransactionAtomically(regPath, {
      txHash: '0x' + 'c3'.repeat(32),
      orderId: claims.find((c) => c.verified).orderId,
      verified: true,
    });
    assert.equal(dupOrder.status, 'DUPLICATE_ORDER_ID');

    // Non-.json --record rejected by CLI
    await assert.rejects(
      () => execFileAsync('node', ['./cli/verify-usdt-payment.mjs', TX, '--service', 'audit', '--record', path.join(tmpLockDir, 'bad.txt')], { cwd: path.resolve('.') }),
      /must end with \.json/
    );
  } finally {
    fs.rmSync(tmpLockDir, { recursive: true, force: true });
  }

  // =========================================================================
  // 5. Static Security, USDT-Only Policy & Secret Hygiene Across Repo
  // =========================================================================
  const root = path.resolve('.');
  const textTargets = [
    'README.md',
    '.github/ISSUE_TEMPLATE/audit-request.md',
    'docs/index.html',
    'docs/terms.html',
    'docs/privacy.html',
    'docs/assets/storefront.js',
    'docs/assets/usdt-verifier.js',
    'cli/verify-usdt-payment.mjs',
  ];
  const forbiddenPaymentRe = /(payoneer|nsave|elevate pay|paypal|stripe|wise|paddle|polar\.sh|fiverr|bank transfer|credit card|debit card|\bvisa\b|\bmastercard\b|\bach\b|\bsepa\b|gumroad|payhip|lemon squeezy|paymob|fawry|instapay|escrow|invoice)/i;
  for (const rel of textTargets) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    const match = content.match(forbiddenPaymentRe);
    assert.equal(match, null, `Forbidden non-USDT payment reference "${match?.[0]}" found in ${rel}`);
  }

  const storefrontJs = fs.readFileSync(path.join(root, 'docs/assets/storefront.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(storefrontJs), 'storefront.js must not assign innerHTML');

  const htmlPages = ['docs/index.html', 'docs/terms.html', 'docs/privacy.html', 'docs/demo-before.html', 'docs/demo-after.html'];
  for (const rel of htmlPages) {
    const html = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'), `Missing CSP meta tag in ${rel}`);
    assert.ok(!html.includes('frame-ancestors'), `meta CSP must not contain frame-ancestors (ignored by browsers) in ${rel}`);
    assert.ok(html.includes('name="referrer" content="no-referrer"'), `Missing no-referrer meta tag in ${rel}`);

    // No inline executable <script> (only type="application/ld+json" allowed)
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scriptTags) {
      const isJsonLd = /type\s*=\s*["']application\/ld\+json["']/i.test(attrs);
      const hasSrc = /\bsrc\s*=/i.test(attrs);
      assert.ok(isJsonLd || (hasSrc && body.trim() === ''), `Disallowed inline <script> found in ${rel}`);
    }

    // Every target="_blank" must have rel="noopener noreferrer"
    const blankLinks = [...html.matchAll(/<a\b[^>]*target\s*=\s*["']_blank["'][^>]*>/gi)];
    for (const [tag] of blankLinks) {
      assert.ok(/rel\s*=\s*["'][^"']*noopener[^"']*noreferrer[^"']*["']|rel\s*=\s*["'][^"']*noreferrer[^"']*noopener[^"']*["']/i.test(tag), `target=_blank missing noopener noreferrer in ${rel}: ${tag}`);
    }
  }

  const browserUtils = fs.readFileSync(path.join(root, 'cli/browser-utils.mjs'), 'utf8');
  assert.ok(browserUtils.includes("VITALSSCOUT_NO_SANDBOX === '1'"), 'Chrome sandbox must only disable on explicit env opt-in');

  for (const rel of [
    ...textTargets,
    'docs/sample-before-report.html',
    'docs/sample-after-report.html',
    'docs/self-audit-report.html',
  ]) {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!/(ghp_[a-zA-Z0-9]{20}|github_pat_|BEGIN (RSA|EC|PRIVATE) KEY|96ahmedmohamed96|\/home\/kali|127\.0\.0\.1:\d+)/.test(content), `Sensitive pattern leaked in ${rel}`);
  }

  console.log('PASS: All comprehensive security regression checks succeeded (XSS, SSRF, traversal, TOCTOU lock, CSP, USDT-only policy, secret hygiene).');
}

runSecurityTests().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exitCode = 1;
});
