# VitalsScout

**Open-source WCAG 2.2 AA, Core Web Vitals (Google Lighthouse), Technical SEO, and HTTP Security Headers diagnostic CLI — plus strictly one-time remediation sprints paid manually in USDT (BEP20).**

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

# Run full test suite (USDT verifier + manual order workflow + security regression + audit engine)
npm test

# Operator CLI: manage local manual orders & payment verification (stored in .local-state/manual-orders.json, excluded from Git)
npm run orders -- --help

# Operator CLI: independently verify an on-chain USDT (BEP20) transaction (>= 15 confirmations, 2-RPC quorum)
npm run verify-usdt -- <txHash> --service audit-fix --record .local-state/verified-txs.json --order-id VS-20261123-EXAMPLE
```

---

## One-Time Audit or Code Repair Services (Manual USDT BEP20 Workflow Only)

If you run a Shopify, WooCommerce, Webflow, or SaaS site and want manual keyboard/screen-reader testing plus hands-on frontend fixes (**strictly one-time payment — zero subscriptions; payable exclusively via USDT on BNB Smart Chain BEP20**):

- **Payment Asset:** `USDT`
- **Network:** `BNB Smart Chain (BEP20)` (`Chain ID 56`)
- **Official USDT BEP20 Token Contract:** `0x55d398326f99059fF775485246999027B3197955` (`18` decimals)
- **Official Private Customer Contact Email:** `vitalsscout@proton.me`
- **Free 1-Page Diagnostic Snapshot ($0):** Email `vitalsscout@proton.me`, [Open a Public Snapshot Request Issue](https://github.com/ahmed62001/vitalsscout/issues/new?template=audit-request.md) (public URLs only; never post private contact details or paid requests), or use the [VitalsScout Storefront](https://ahmed62001.github.io/vitalsscout/)
- **Website Diagnostic Audit ($20.86 USD / 20.86 USDT one-time, 48h after payment verification):** Performance analysis, Core Web Vitals assessment, technical SEO inspection, WCAG 2.2 AA checks, and actionable recommendations across up to 5 templates
- **Website Audit + Fix ($48.86 USD / 48.86 USDT one-time, 3–5 business days after payment verification):** Complete audit plus actual code-level fixes within agreed scope, before-and-after comparisons, and verification through a new re-audit

### Manual Order & Payment Sequence (Privacy & Shared-Address Protection)

1. **Private Request First:** Paid orders are **never** submitted via public GitHub Issues. Use the brief builder on [the VitalsScout Storefront](https://ahmed62001.github.io/vitalsscout/#request), copy your generated Private Request Brief, and email it privately to `vitalsscout@proton.me`.
2. **Manual Acceptance & Local Order ID:** The operator reviews the request, accepts it manually, and records an authoritative Order ID in the private local registry (`npm run orders`).
3. **Single Active Payment Window:** Because the deposit address is shared, payment instructions are **not** shown publicly on the storefront and are issued privately via `vitalsscout@proton.me` for at most one unresolved paid order at a time.
4. **Private TxHash & Manual Verification:** After sending exact `20.86 USDT` or `48.86 USDT` on BSC (BEP20), reply privately in the same email thread at `vitalsscout@proton.me` with your `0x...` transaction hash and sending wallet address (or exchange withdrawal confirmation). Customer-submitted hashes remain labeled *"Customer-submitted transaction hash — UNVERIFIED."* until the operator independently verifies Chain ID 56, official USDT contract, exact recipient, exact net amount, successful receipt, `>= 15` block confirmations, local replay uniqueness, and a matching *Completed/Credited* record in Binance Deposit History before marking the order `Paid` and starting manual fulfillment. Automatic fulfillment is disabled.

*Disclaimer: VitalsScout provides technical diagnostics and frontend engineering remediation aligned with WCAG 2.2 AA and Core Web Vitals. It is not a law firm and does not provide legal advice or formal ADA/EAA compliance guarantees.*

## License

MIT
