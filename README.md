# VitalsScout

**Open-source WCAG 2.2 AA, Core Web Vitals (Google Lighthouse), Technical SEO, and HTTP Security Headers diagnostic CLI — plus strictly one-time remediation sprints paid exclusively in USDT (BEP20).**

- **Live Storefront & Interactive Demos:** https://ahmed62001.github.io/vitalsscout/
- **Before vs. After Demo Store:** [Unoptimized Demo](https://ahmed62001.github.io/vitalsscout/demo-before.html) → [Remediated Demo](https://ahmed62001.github.io/vitalsscout/demo-after.html)
- **Real Sample Reports:** [Before Report](https://ahmed62001.github.io/vitalsscout/sample-before-report.html) | [After Report](https://ahmed62001.github.io/vitalsscout/sample-after-report.html) | [Storefront Self-Audit](https://ahmed62001.github.io/vitalsscout/self-audit-report.html)

---

## What the CLI Checks

For any public HTTP/HTTPS URL (SSRF-protected against private/loopback/metadata IPs unless `--allow-localhost` is explicitly supplied), `vitalsscout` runs four local browser & protocol diagnostics (zero external API keys required):

1. **Google Lighthouse (Mobile Emulation):** Performance, Accessibility, Best Practices, and SEO category scores plus LCP, FCP, CLS, TBT, Speed Index, TTFB, total byte weight, and top actionable savings.
2. **axe-core WCAG 2.0 / 2.1 / 2.2 A & AA Scan:** Captures rule IDs, impact levels (`critical`, `serious`, `moderate`, `minor`), WCAG tags, node counts, and concrete CSS selectors / HTML snippets.
3. **Technical SEO & DOM Hygiene:** Evaluates `<html lang>`, `<title>`, `<meta name="description">`, `<link rel="canonical">`, Open Graph tags, JSON-LD blocks, `<h1>` structure, missing image `alt` & `width`/`height`, unlabelled visible form fields, non-descriptive links, and small interactive targets (`<24x24px`, aligned with WCAG 2.2 `2.5.8`).
4. **HTTP Security Headers & Crawlability:** Checks HTTPS, HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`, response compression, `/robots.txt`, and `/sitemap.xml`.

Outputs three files per audit:
- `<slug>-audit.json` (structured raw data)
- `<slug>-report.html` (standalone, CSP-protected, print-to-PDF-ready executive & developer report)
- `<slug>-snapshot.md` (concise 1-page Markdown diagnostic summary)

---

## Quickstart

### Prerequisites
- Node.js `>= 20`
- Local Google Chrome or Chromium installed (override path via `CHROME_PATH=/path/to/chrome` if needed; Chrome sandbox stays enabled by default unless `VITALSSCOUT_NO_SANDBOX=1` is set intentionally for container environments)

### Install & Run

```bash
git clone https://github.com/ahmed62001/vitalsscout.git
cd vitalsscout
npm install

# Audit a public URL and write reports to ./vitalsscout-reports
node ./cli/vitalsscout.mjs https://example.com

# Custom output folder and filename prefix
node ./cli/vitalsscout.mjs https://example.com --out ./reports --slug example-home

# Run full test suite (USDT verifier + security regression suite + audit engine)
npm test

# Independently verify a one-time USDT (BEP20) payment on BNB Smart Chain
npm run verify-usdt -- <txHash> --service audit-fix --record verified-txs.json --order-id ORDER-001
```

---

## One-Time Audit or Code Repair Services (USDT BEP20 Only)

If you run a Shopify, WooCommerce, Webflow, or SaaS site and want manual keyboard/screen-reader testing plus hands-on frontend fixes (**strictly one-time payment — zero subscriptions; payable exclusively via USDT on BNB Smart Chain BEP20**):

- **Only Accepted Asset & Network:** `USDT (BEP20)` on **BNB Smart Chain** (`Chain ID 56`)
- **Official USDT BEP20 Token Contract:** `0x55d398326f99059fF775485246999027B3197955` (`18` decimals)
- **Receiving Wallet Address:** `0x78b865760a7154A8EeC758aC1B9d4a9661Bb8De9`
- **Free 1-Page Diagnostic Snapshot ($0):** [Open an Audit Request Issue](https://github.com/ahmed62001/vitalsscout/issues/new?template=audit-request.md) or visit the [VitalsScout Storefront](https://ahmed62001.github.io/vitalsscout/)
- **Website Diagnostic Audit ($20.86 USD / 20.86 USDT one-time, 48h):** Performance analysis, Core Web Vitals assessment, technical SEO inspection, WCAG 2.2 AA checks, and actionable recommendations across up to 5 templates
- **Website Audit + Fix ($48.86 USD / 48.86 USDT one-time, 3–5 business days):** Complete audit plus actual code-level fixes within agreed scope, before-and-after comparisons, and verification through a new re-audit

*Disclaimer: VitalsScout provides technical diagnostics and frontend engineering remediation aligned with WCAG 2.2 AA and Core Web Vitals. It is not a law firm and does not provide legal advice or formal ADA/EAA compliance guarantees.*

## License

MIT
