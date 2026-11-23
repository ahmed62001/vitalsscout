import dns from 'node:dns/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
import lighthouse from 'lighthouse';
import { launchHeadlessBrowser } from './browser-utils.mjs';

const require = createRequire(import.meta.url);
const axe = require('axe-core');

const USER_AGENT = 'VitalsScout/1.0 (+https://github.com/ahmed62001/vitalsscout)';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 256 * 1024;
const MAX_SITEMAP_BYTES = 512 * 1024;
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

/**
 * Race a promise against a strict timeout so external sites never hang the CLI.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function expandIpv6(raw) {
  let ip = raw.toLowerCase();
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const v4 = ip.slice(lastColon + 1);
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = [...left, ...Array(missing).fill('0'), ...right].map((g) => g.padStart(4, '0'));
  return full.map((g) => Number.parseInt(g, 16));
}

function isBlockedIpv4Tuple(parts, allowLoopback) {
  const [a, b, c] = parts;
  if (allowLoopback && a === 127) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local & cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

/**
 * Determine whether an IPv4 or IPv6 address belongs to loopback, link-local/metadata, or private ranges.
 * @param {string} rawIp
 * @param {{ allowLoopback?: boolean }} [options]
 * @returns {boolean}
 */
export function isBlockedIp(rawIp, { allowLoopback = false } = {}) {
  const ip = String(rawIp || '').replace(/^\[|\]$/g, '').split('%')[0].trim().toLowerCase();
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    return isBlockedIpv4Tuple(ip.split('.').map(Number), allowLoopback);
  }

  if (net.isIPv6(ip)) {
    const words = expandIpv6(ip);
    if (!words) return true;
    const isAllZero = words.every((w) => w === 0);
    if (isAllZero) return true; // :: unspecified
    const isLoopbackV6 = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
    if (isLoopbackV6) return !allowLoopback;
    // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::0:0/96) or NAT64 (64:ff9b::/96)
    const isV4Mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
    const isV4Compat = words.slice(0, 6).every((w) => w === 0);
    const isNat64 = words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0;
    if (isV4Mapped || isV4Compat || isNat64) {
      const tuple = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
      return isBlockedIpv4Tuple(tuple, allowLoopback);
    }
    if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true; // Discard-Only
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // Documentation
    return false;
  }

  return true;
}

/**
 * Validate and normalize an audit target URL syntax & protocol.
 * @param {string} rawUrl
 * @returns {URL}
 */
export function validateTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${parsed.protocol}". Only http: and https: are supported.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Embedded URL credentials (username/password) are not permitted.');
  }
  return parsed;
}

/**
 * Validate target URL against SSRF (blocks private, link-local, metadata, and non-public DNS resolutions).
 * @param {string} rawUrl
 * @param {{ allowLocalhost?: boolean }} [options]
 * @returns {Promise<URL>}
 */
export async function assertSafeTargetUrl(rawUrl, { allowLocalhost = false } = {}) {
  const parsed = validateTargetUrl(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new Error('Target URL missing hostname.');
  }

  const isLoopbackHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!allowLocalhost) {
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new Error(`Blocked non-public hostname: "${host}"`);
    }
  } else if (!isLoopbackHost && (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal'))) {
    throw new Error(`Blocked internal/metadata hostname: "${host}"`);
  }

  if (net.isIP(host)) {
    if (isBlockedIp(host, { allowLoopback: allowLocalhost })) {
      throw new Error(`Blocked non-public target IP address: ${host}`);
    }
    return parsed;
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`DNS lookup returned no addresses for "${host}"`);
  }
  for (const rec of records) {
    if (isBlockedIp(rec.address, { allowLoopback: allowLocalhost })) {
      throw new Error(`Target host "${host}" resolves to blocked non-public IP: ${rec.address}`);
    }
  }
  return parsed;
}

async function readBoundedText(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const fallback = await res.text();
    return fallback.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      const remaining = maxBytes - total;
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        total += remaining;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function safeFetchWithRedirects(rawUrl, init, { allowLocalhost = false, maxRedirects = 5 } = {}) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safeUrl = await assertSafeTargetUrl(currentUrl, { allowLocalhost });
    const res = await fetch(safeUrl.href, {
      ...init,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { res, finalUrl: safeUrl.href };
      }
      if (hop === maxRedirects) {
        throw new Error(`Exceeded maximum redirect hops (${maxRedirects})`);
      }
      await res.body?.cancel().catch(() => {});
      currentUrl = new URL(loc, safeUrl.href).href;
      continue;
    }
    return { res, finalUrl: safeUrl.href };
  }
  throw new Error('Unexpected redirect termination');
}

/**
 * Derive a filesystem-safe slug from a URL.
 * @param {string} rawUrl
 * @returns {string}
 */
export function slugifyUrl(rawUrl) {
  const parsed = validateTargetUrl(rawUrl);
  const pathPart = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.hostname}${pathPart}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'site';
}

/**
 * Fetch target URL and crawlability files to inspect HTTP, security headers, and platform signals.
 * @param {URL} parsedUrl
 * @param {{ allowLocalhost?: boolean }} [options]
 */
async function inspectHttpAndCrawlability(parsedUrl, { allowLocalhost = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const start = Date.now();

  let statusCode = null;
  let finalUrl = parsedUrl.href;
  let ttfbMs = null;
  let headersObj = {};
  let htmlSnippet = '';
  let fetchError = null;

  try {
    const fetched = await safeFetchWithRedirects(
      parsedUrl.href,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      { allowLocalhost, maxRedirects: 5 }
    );
    const res = fetched.res;
    ttfbMs = Date.now() - start;
    statusCode = res.status;
    finalUrl = fetched.finalUrl;
    for (const [k, v] of res.headers.entries()) {
      headersObj[k.toLowerCase()] = v;
    }
    const boundedHtml = await readBoundedText(res, MAX_HTML_BYTES);
    htmlSnippet = boundedHtml.slice(0, 60000);
  } catch (err) {
    fetchError = err?.message || String(err);
  } finally {
    clearTimeout(timeout);
  }

  const csp = headersObj['content-security-policy'] || '';
  const hasFrameAncestors = /frame-ancestors\s+/i.test(csp);
  const isHttps = finalUrl.startsWith('https://');

  const securityHeaders = {
    https: isHttps,
    strictTransportSecurity: Boolean(headersObj['strict-transport-security']),
    contentSecurityPolicy: Boolean(csp),
    xContentTypeOptions: (headersObj['x-content-type-options'] || '').toLowerCase().includes('nosniff'),
    frameProtection: Boolean(headersObj['x-frame-options']) || hasFrameAncestors,
    referrerPolicy: Boolean(headersObj['referrer-policy']),
    compression: /gzip|br|deflate|zstd/i.test(headersObj['content-encoding'] || ''),
    cacheControl: headersObj['cache-control'] || null,
  };

  const platformSignals = [];
  if (headersObj['x-shopid'] || /cdn\.shopify\.com|Shopify\.theme/i.test(htmlSnippet)) {
    platformSignals.push('Shopify');
  }
  if (/woocommerce/i.test(htmlSnippet)) {
    platformSignals.push('WooCommerce');
  } else if (/wp-content|wp-includes/i.test(htmlSnippet)) {
    platformSignals.push('WordPress');
  }
  if (headersObj['x-powered-by']?.includes('Next.js') || /__NEXT_DATA__|\/_next\/static/i.test(htmlSnippet)) {
    platformSignals.push('Next.js');
  }
  if (/webflow\.com|data-wf-domain/i.test(htmlSnippet)) {
    platformSignals.push('Webflow');
  }
  if (platformSignals.length === 0 && statusCode) {
    platformSignals.push('Custom / Unidentified');
  }

  const origin = new URL(finalUrl).origin;
  const probeTextEndpoint = async (subPath, maxBytes) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const fetched = await safeFetchWithRedirects(
        `${origin}${subPath}`,
        {
          method: 'GET',
          signal: ac.signal,
          headers: { 'User-Agent': USER_AGENT },
        },
        { allowLocalhost, maxRedirects: 5 }
      );
      const r = fetched.res;
      const body = await readBoundedText(r, maxBytes);
      return {
        url: `${origin}${subPath}`,
        status: r.status,
        present: r.status >= 200 && r.status < 300 && body.trim().length > 0,
        byteLength: Buffer.byteLength(body, 'utf8'),
      };
    } catch (err) {
      return {
        url: `${origin}${subPath}`,
        status: null,
        present: false,
        error: err?.message || String(err),
      };
    } finally {
      clearTimeout(t);
    }
  };

  const [robotsTxt, sitemapXml] = await Promise.all([
    probeTextEndpoint('/robots.txt', MAX_ROBOTS_BYTES),
    probeTextEndpoint('/sitemap.xml', MAX_SITEMAP_BYTES),
  ]);

  return {
    statusCode,
    finalUrl,
    ttfbMs,
    fetchError,
    platformSignals,
    securityHeaders,
    crawlability: {
      robotsTxt,
      sitemapXml,
    },
  };
}

/**
 * Execute a real mobile Google Lighthouse audit against an existing headless Chrome port.
 * @param {string} url
 * @param {number} port
 */
async function runLighthouseAudit(url, port) {
  const runnerResult = await withTimeout(
    lighthouse(url, {
      port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: 'mobile',
      screenEmulation: {
        mobile: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        disabled: false,
      },
      maxWaitForLoad: 25000,
    }),
    70000,
    'Lighthouse mobile audit'
  );

  const lhr = runnerResult?.lhr;
  if (!lhr) {
    throw new Error('Lighthouse returned empty report (lhr is undefined).');
  }

  const getScore = (key) => {
    const raw = lhr.categories?.[key]?.score;
    return typeof raw === 'number' ? Math.round(raw * 100) : null;
  };

  const audits = lhr.audits || {};
  const numVal = (id) => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;
  };

  const opportunities = Object.values(audits)
    .filter((a) => {
      if (!a || typeof a.score !== 'number' || a.score >= 0.9) return false;
      const ms = a.details?.overallSavingsMs || 0;
      const bytes = a.details?.overallSavingsBytes || 0;
      return ms >= 50 || bytes >= 10240;
    })
    .map((a) => ({
      id: a.id,
      title: a.title,
      score: Math.round(a.score * 100),
      displayValue: a.displayValue || null,
      savingsMs: Math.round(a.details?.overallSavingsMs || 0),
      savingsBytes: Math.round(a.details?.overallSavingsBytes || 0),
    }))
    .sort((a, b) => (b.savingsMs + b.savingsBytes / 1024) - (a.savingsMs + a.savingsBytes / 1024))
    .slice(0, 8);

  return {
    lighthouseVersion: lhr.lighthouseVersion || null,
    runtimeError: lhr.runtimeError ? lhr.runtimeError.message : null,
    scores: {
      performance: getScore('performance'),
      accessibility: getScore('accessibility'),
      bestPractices: getScore('best-practices'),
      seo: getScore('seo'),
    },
    metrics: {
      lcpMs: numVal('largest-contentful-paint'),
      fcpMs: numVal('first-contentful-paint'),
      cls: numVal('cumulative-layout-shift'),
      tbtMs: numVal('total-blocking-time'),
      speedIndexMs: numVal('speed-index'),
      ttfbMs: numVal('server-response-time'),
      totalBytes: numVal('total-byte-weight'),
    },
    opportunities,
  };
}

/**
 * Run axe-core WCAG 2.0/2.1/2.2 A & AA scan and inspect technical SEO & DOM hygiene.
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} url
 */
async function runDomAndAxeScan(browser, url, { allowLocalhost = false } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
    if (!allowLocalhost) {
      await page.setRequestInterception(true);
      page.on('request', async (req) => {
        const reqUrl = req.url();
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:') || reqUrl === 'about:blank') {
          req.continue().catch(() => {});
          return;
        }
        try {
          await assertSafeTargetUrl(reqUrl, { allowLocalhost: false });
          req.continue().catch(() => {});
        } catch {
          req.abort('blockedbyclient').catch(() => {});
        }
      });
    } else {
      await page.setRequestInterception(false);
    }

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (err) {
      // If networkidle2 times out on long-polling third-party beacons, continue if DOM loaded
      const hasBody = await page.evaluate(() => Boolean(document.body && document.body.innerHTML.length > 0)).catch(() => false);
      if (!hasBody) {
        throw err;
      }
    }

    // Small settle delay for post-load web fonts / layout
    await new Promise((r) => setTimeout(r, 400));

    // Inject axe-core via CDP evaluate so strict page CSP doesn't block our diagnostic runner
    await page.evaluate(axe.source);
    const axeLoaded = await page.evaluate(() => Boolean(window.axe && typeof window.axe.run === 'function'));
    if (!axeLoaded) {
      await page.addScriptTag({ content: axe.source });
    }

    const axeResults = await withTimeout(
      page.evaluate(async (tags) => {
        return await window.axe.run(document, {
          runOnly: { type: 'tag', values: tags },
        });
      }, WCAG_TAGS),
      30000,
      'axe-core WCAG scan'
    );

    const violations = (axeResults.violations || []).map((v) => ({
      id: v.id,
      impact: v.impact || 'moderate',
      help: v.help,
      description: v.description,
      helpUrl: v.helpUrl,
      tags: (v.tags || []).filter((t) => t.startsWith('wcag') || t === 'best-practice'),
      nodeCount: (v.nodes || []).length,
      sampleNodes: (v.nodes || []).slice(0, 3).map((n) => ({
        target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target || ''),
        html: String(n.html || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        failureSummary: String(n.failureSummary || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      })),
    }));

    const domHygiene = await page.evaluate(() => {
      const q = (sel) => document.querySelector(sel);
      const qAll = (sel) => Array.from(document.querySelectorAll(sel));

      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const title = (document.title || '').trim();
      const metaDesc = (q('meta[name="description"]')?.getAttribute('content') || '').trim();
      const canonical = (q('link[rel="canonical"]')?.getAttribute('href') || '').trim();
      const viewport = (q('meta[name="viewport"]')?.getAttribute('content') || '').trim();
      const htmlLang = (document.documentElement?.getAttribute('lang') || '').trim();
      const ogTitle = (q('meta[property="og:title"]')?.getAttribute('content') || '').trim();
      const ogDescription = (q('meta[property="og:description"]')?.getAttribute('content') || '').trim();
      const ogImage = (q('meta[property="og:image"]')?.getAttribute('content') || '').trim();
      const jsonLdCount = qAll('script[type="application/ld+json"]').length;

      const h1s = qAll('h1').map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);

      const imgs = qAll('img');
      let imagesMissingAlt = 0;
      let imagesMissingDimensions = 0;
      for (const img of imgs) {
        if (!img.hasAttribute('alt')) {
          imagesMissingAlt += 1;
        }
        const hasW = img.hasAttribute('width');
        const hasH = img.hasAttribute('height');
        if ((!hasW || !hasH) && isVisible(img)) {
          imagesMissingDimensions += 1;
        }
      }

      const genericLinkWords = new Set(['click here', 'here', 'read more', 'learn more', 'more', 'link', 'details']);
      let nonDescriptiveLinks = 0;
      for (const a of qAll('a')) {
        if (!isVisible(a)) continue;
        const aria = (a.getAttribute('aria-label') || a.getAttribute('title') || '').trim();
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!aria && genericLinkWords.has(text)) {
          nonDescriptiveLinks += 1;
        }
      }

      let unlabelledInputs = 0;
      for (const field of qAll('input, select, textarea')) {
        const type = (field.getAttribute('type') || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        if (!isVisible(field)) continue;
        const id = field.getAttribute('id');
        const hasForLabel = id ? Boolean(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : false;
        const wrappedInLabel = Boolean(field.closest('label'));
        const hasAria = Boolean(
          (field.getAttribute('aria-label') || '').trim() ||
          (field.getAttribute('aria-labelledby') || '').trim() ||
          (field.getAttribute('title') || '').trim()
        );
        if (!hasForLabel && !wrappedInLabel && !hasAria) {
          unlabelledInputs += 1;
        }
      }

      let smallTapTargets = 0;
      const smallTapTargetSamples = [];
      for (const el of qAll('a, button, input[type="submit"], input[type="button"]')) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) {
          smallTapTargets += 1;
          if (smallTapTargetSamples.length < 3) {
            smallTapTargetSamples.push({
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }
      }

      const hasMainLandmark = Boolean(q('main, [role="main"]'));
      const hasSkipLink = qAll('a[href^="#"]').some((a) => /skip/i.test(a.textContent || ''));

      return {
        title,
        titleLength: title.length,
        metaDescription: metaDesc,
        metaDescriptionLength: metaDesc.length,
        canonical,
        viewport,
        htmlLang,
        openGraph: {
          title: Boolean(ogTitle),
          description: Boolean(ogDescription),
          image: Boolean(ogImage),
        },
        jsonLdCount,
        h1Count: h1s.length,
        h1Samples: h1s.slice(0, 3),
        totalImages: imgs.length,
        imagesMissingAlt,
        imagesMissingDimensions,
        nonDescriptiveLinks,
        unlabelledInputs,
        smallTapTargets,
        smallTapTargetSamples,
        hasMainLandmark,
        hasSkipLink,
      };
    });

    return {
      axeVersion: axe.version,
      wcagTagsTested: WCAG_TAGS,
      violationCount: violations.length,
      totalViolationNodes: violations.reduce((sum, v) => sum + v.nodeCount, 0),
      passesCount: (axeResults.passes || []).length,
      incompleteCount: (axeResults.incomplete || []).length,
      violations,
      domHygiene,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Map raw findings into prioritized engineering remediation recommendations.
 * @param {object} report
 */
function buildPrioritizedFixes(report) {
  const fixes = [];
  const impactToPriority = {
    critical: 'Critical',
    serious: 'Serious',
    moderate: 'Moderate',
    minor: 'Moderate',
  };

  for (const v of report.accessibility?.violations || []) {
    fixes.push({
      priority: impactToPriority[v.impact] || 'Moderate',
      category: 'WCAG 2.2 AA',
      title: `${v.help} (${v.id})`,
      evidence: `${v.nodeCount} DOM element(s) affected${v.sampleNodes?.[0]?.target ? ` — e.g. ${v.sampleNodes[0].target}` : ''}`,
      remediation: `Inspect failing selector(s) and resolve rule "${v.id}" per WCAG tags (${v.tags.join(', ')}). Reference: ${v.helpUrl}`,
    });
  }

  const m = report.lighthouse?.metrics || {};
  if (typeof m.lcpMs === 'number' && m.lcpMs > 2500) {
    fixes.push({
      priority: m.lcpMs > 4000 ? 'Critical' : 'Serious',
      category: 'Core Web Vitals',
      title: `Reduce mobile Largest Contentful Paint (LCP: ${(m.lcpMs / 1000).toFixed(2)}s)`,
      evidence: `LCP is ${(m.lcpMs / 1000).toFixed(2)}s (Google Good threshold <= 2.50s).`,
      remediation: 'Preload the hero LCP image with fetchpriority="high", inline critical above-the-fold CSS, eliminate render-blocking scripts, and serve AVIF/WebP.',
    });
  }

  if (typeof m.cls === 'number' && m.cls > 0.1) {
    fixes.push({
      priority: m.cls > 0.25 ? 'Critical' : 'Serious',
      category: 'Core Web Vitals',
      title: `Fix Cumulative Layout Shift (CLS: ${m.cls.toFixed(3)})`,
      evidence: `CLS is ${m.cls.toFixed(3)} (Google Good threshold <= 0.100).`,
      remediation: 'Set explicit width/height or CSS aspect-ratio on images/embeds, reserve banner/announcement bar height, and use font-display: swap with fallback metrics.',
    });
  }

  if (typeof m.tbtMs === 'number' && m.tbtMs > 200) {
    fixes.push({
      priority: m.tbtMs > 600 ? 'Critical' : 'Serious',
      category: 'Core Web Vitals',
      title: `Reduce mobile main-thread blocking (TBT: ${Math.round(m.tbtMs)}ms)`,
      evidence: `Total Blocking Time is ${Math.round(m.tbtMs)}ms (target <= 200ms; indicates INP responsiveness risk).`,
      remediation: 'Defer non-critical third-party scripts, code-split large JS bundles, and remove unused marketing tags/apps.',
    });
  }

  for (const opp of report.lighthouse?.opportunities || []) {
    if (opp.savingsMs >= 250 || opp.savingsBytes >= 51200) {
      fixes.push({
        priority: opp.savingsMs >= 750 || opp.savingsBytes >= 250000 ? 'Serious' : 'Moderate',
        category: 'Performance Opportunity',
        title: opp.title,
        evidence: `${opp.displayValue || 'Detected optimization opportunity'} (est. savings: ${opp.savingsMs}ms / ${Math.round(opp.savingsBytes / 1024)} KiB)`,
        remediation: `Address Lighthouse opportunity "${opp.id}" in theme templates/asset pipeline.`,
      });
    }
  }

  const dom = report.domHygiene || {};
  if (!dom.htmlLang) {
    fixes.push({
      priority: 'Critical',
      category: 'WCAG 2.2 AA & SEO',
      title: 'Missing language attribute on <html>',
      evidence: '<html lang="..."> attribute is empty or missing.',
      remediation: 'Add a valid BCP 47 language code such as <html lang="en"> so screen readers select the correct pronunciation engine.',
    });
  }
  if (!dom.metaDescription) {
    fixes.push({
      priority: 'Serious',
      category: 'Technical SEO',
      title: 'Missing meta description',
      evidence: 'No <meta name="description"> tag found.',
      remediation: 'Add a concise 120–155 character unique meta description describing the page offer.',
    });
  }
  if (!dom.canonical) {
    fixes.push({
      priority: 'Moderate',
      category: 'Technical SEO',
      title: 'Missing canonical link tag',
      evidence: 'No <link rel="canonical"> tag found.',
      remediation: 'Add a self-referencing <link rel="canonical" href="..."> to avoid duplicate-URL indexing splits.',
    });
  }
  if (dom.h1Count !== 1) {
    fixes.push({
      priority: dom.h1Count === 0 ? 'Serious' : 'Moderate',
      category: 'Technical SEO & Accessibility',
      title: dom.h1Count === 0 ? 'Missing <h1> primary heading' : `Multiple <h1> headings (${dom.h1Count} found)`,
      evidence: `Page contains ${dom.h1Count} <h1> element(s).`,
      remediation: 'Use exactly one descriptive <h1> heading per page template and nest subsequent headings sequentially (<h2>, <h3>).',
    });
  }
  if (dom.imagesMissingDimensions > 0) {
    fixes.push({
      priority: 'Moderate',
      category: 'Core Web Vitals',
      title: `${dom.imagesMissingDimensions} visible image(s) missing explicit width/height attributes`,
      evidence: `${dom.imagesMissingDimensions} of ${dom.totalImages} <img> tags lack explicit width or height HTML attributes.`,
      remediation: 'Add explicit width and height attributes (or CSS aspect-ratio) to prevent image-induced layout shifts (CLS).',
    });
  }
  if (dom.smallTapTargets > 0) {
    fixes.push({
      priority: 'Serious',
      category: 'WCAG 2.2 AA (2.5.8)',
      title: `${dom.smallTapTargets} interactive element(s) smaller than 24x24 CSS px`,
      evidence: `Examples: ${dom.smallTapTargetSamples.map((s) => `${s.tag} "${s.text || '(no text)'}" (${s.width}x${s.height}px)`).join('; ')}`,
      remediation: 'Increase padding/min-size to at least 24x24px (ideally 44x44px for mobile ergonomics) to satisfy WCAG 2.2 Target Size (Minimum).',
    });
  }
  if (dom.jsonLdCount === 0) {
    fixes.push({
      priority: 'Moderate',
      category: 'Technical SEO',
      title: 'No JSON-LD structured data detected',
      evidence: '0 <script type="application/ld+json"> blocks present.',
      remediation: 'Add schema.org JSON-LD (Product, Organization, or SoftwareApplication) for rich search snippets.',
    });
  }

  const hdr = report.http?.securityHeaders || {};
  if (!hdr.contentSecurityPolicy || !hdr.strictTransportSecurity || !hdr.xContentTypeOptions) {
    const missing = [
      !hdr.strictTransportSecurity && 'Strict-Transport-Security',
      !hdr.contentSecurityPolicy && 'Content-Security-Policy',
      !hdr.xContentTypeOptions && 'X-Content-Type-Options: nosniff',
      !hdr.frameProtection && 'X-Frame-Options / frame-ancestors',
      !hdr.referrerPolicy && 'Referrer-Policy',
    ].filter(Boolean);
    if (missing.length > 0) {
      fixes.push({
        priority: 'Moderate',
        category: 'Security Hygiene',
        title: `Missing ${missing.length} recommended HTTP security header(s)`,
        evidence: `Absent headers: ${missing.join(', ')}`,
        remediation: 'Configure recommended security headers at your CDN/reverse proxy (Cloudflare, Netlify, Vercel, or origin server).',
      });
    }
  }

  const rank = { Critical: 0, Serious: 1, Moderate: 2 };
  fixes.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));
  return fixes;
}

/**
 * Run a complete, real diagnostic audit for a single URL.
 * @param {string} rawUrl
 * @param {{ allowLocalhost?: boolean, displayUrl?: string|null }} [options]
 * @returns {Promise<object>}
 */
export async function auditUrl(rawUrl, options = {}) {
  const { allowLocalhost = false, displayUrl = null } = options;
  const parsedUrl = await assertSafeTargetUrl(rawUrl, { allowLocalhost });
  const startedAt = new Date().toISOString();

  const http = await inspectHttpAndCrawlability(parsedUrl, { allowLocalhost });
  if (http.fetchError && /^(Blocked |Target host |Unsupported protocol|Embedded URL credentials|Exceeded maximum redirect)/.test(http.fetchError)) {
    throw new Error(http.fetchError);
  }
  const effectiveUrl = http.finalUrl || parsedUrl.href;
  await assertSafeTargetUrl(effectiveUrl, { allowLocalhost });

  const { browser, port } = await launchHeadlessBrowser();
  try {
    // Run sequentially on the shared Chrome instance so Lighthouse performance timings are uncontended
    let lighthouseData;
    try {
      lighthouseData = await runLighthouseAudit(effectiveUrl, port);
    } catch (err) {
      lighthouseData = {
        lighthouseVersion: null,
        runtimeError: err?.message || String(err),
        scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
        metrics: { lcpMs: null, fcpMs: null, cls: null, tbtMs: null, speedIndexMs: null, ttfbMs: null, totalBytes: null },
        opportunities: [],
      };
    }
    const domAndAxe = await runDomAndAxeScan(browser, effectiveUrl, { allowLocalhost });

    const { domHygiene, ...accessibility } = domAndAxe;

    const reportedUrl = displayUrl || effectiveUrl;
    if (displayUrl && http) {
      http.finalUrl = displayUrl;
    }

    const report = {
      tool: 'VitalsScout',
      version: '1.0.0',
      auditedAt: startedAt,
      requestedUrl: displayUrl || parsedUrl.href,
      finalUrl: reportedUrl,
      http,
      lighthouse: lighthouseData,
      accessibility,
      domHygiene,
      prioritizedFixes: [],
    };
    report.prioritizedFixes = buildPrioritizedFixes(report);
    return report;
  } finally {
    await browser.close().catch(() => {});
  }
}
