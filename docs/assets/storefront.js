import { PAYMENT_STATES, RECEIVING_WALLET, normalizeTxHash, verifyUsdtBep20Payment } from './usdt-verifier.js';

const CLAIMED_TXS_KEY = 'vitalsscout_claimed_txs_v1';
const VERIFY_COOLDOWN_MS = 2500;
const RATE_WINDOW_MS = 60000;
const MAX_CHECKS_PER_WINDOW = 10;

const TIER_MAP = {
  free: {
    label: 'Free 1-Page Snapshot',
    price: '$0 USD',
    usdt: null,
    sla: 'One-time free diagnostic, within 24 hours, 1 URL',
  },
  audit: {
    label: 'Website Diagnostic Audit',
    price: '$20.86 USD',
    usdt: '20.86',
    sla: 'One-time payment via USDT (BEP20), 48 hours, up to 5 templates',
  },
  'audit-fix': {
    label: 'Website Audit + Fix',
    price: '$48.86 USD',
    usdt: '48.86',
    sla: 'One-time payment via USDT (BEP20), 3–5 business days, up to 5 templates + code fixes & verification re-audit',
  },
};

const urlInput = document.getElementById('site-url');
const platformSelect = document.getElementById('platform');
const tierSelect = document.getElementById('package-tier');
const notesInput = document.getElementById('notes');
const summaryEl = document.getElementById('estimate-summary');
const outputEl = document.getElementById('brief-output');
const ghLink = document.getElementById('github-issue-link');
const copyBtn = document.getElementById('copy-brief-btn');
const copyStatus = document.getElementById('copy-status');

const usdtFreeNote = document.getElementById('usdt-free-note');
const usdtPaidDetails = document.getElementById('usdt-paid-details');
const usdtAmountDue = document.getElementById('usdt-amount-due');
const copyWalletBtn = document.getElementById('copy-wallet-btn');
const copyWalletStatus = document.getElementById('copy-wallet-status');
const txHashInput = document.getElementById('usdt-tx-hash');
const verifyUsdtBtn = document.getElementById('verify-usdt-btn');
const verifyStatusEl = document.getElementById('usdt-verify-status');

let copyResetTimer = null;
let walletResetTimer = null;
let verifiedPayment = null;
let lastVerifyAtMs = 0;
const recentRpcAttempts = [];

function loadClaimedTxs() {
  try {
    const raw = window.localStorage.getItem(CLAIMED_TXS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveClaimedTx(txHash, targetUrl, serviceKey) {
  try {
    const map = loadClaimedTxs();
    map[txHash] = { targetUrl, serviceKey, claimedAt: new Date().toISOString() };
    window.localStorage.setItem(CLAIMED_TXS_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota/privacy-mode failures cleanly
  }
}

function renderSummary(tier) {
  summaryEl.textContent = '';
  const lead = document.createElement('strong');
  lead.textContent = 'Selected Service: ';
  const priceBold = document.createElement('strong');
  priceBold.textContent = tier.price;
  summaryEl.append(
    lead,
    document.createTextNode(`${tier.label} — `),
    priceBold,
    document.createTextNode(` (${tier.sla}).`)
  );
}

function renderVerifyState(paymentState, cssClass, messageText, bscscanUrl = null, extraLinkText = 'Check BscScan') {
  verifyStatusEl.className = `verify-box${cssClass ? ` ${cssClass}` : ''}`;
  verifyStatusEl.textContent = '';

  const stateBadge = document.createElement('strong');
  stateBadge.textContent = `Payment State: ${paymentState} — `;
  verifyStatusEl.appendChild(stateBadge);
  verifyStatusEl.appendChild(document.createTextNode(messageText));

  if (bscscanUrl && /^https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}$/.test(bscscanUrl)) {
    verifyStatusEl.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.href = bscscanUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = extraLinkText;
    verifyStatusEl.appendChild(link);
  }
}

function syncUsdtPanel(tier) {
  if (!tier.usdt) {
    usdtFreeNote.hidden = false;
    usdtPaidDetails.hidden = true;
  } else {
    usdtFreeNote.hidden = true;
    usdtPaidDetails.hidden = false;
    usdtAmountDue.textContent = `${tier.usdt} USDT`;
  }
  if (verifiedPayment && verifiedPayment.serviceKey !== tierSelect.value) {
    verifiedPayment = null;
    renderVerifyState(
      PAYMENT_STATES.PENDING,
      'is-pending',
      'Service changed — re-verify your BNB Smart Chain transaction hash for the selected amount before submitting.'
    );
  }
}

function updateBrief() {
  const tier = TIER_MAP[tierSelect.value] || TIER_MAP['audit-fix'];
  syncUsdtPanel(tier);

  const url = (urlInput.value || '').trim().slice(0, 300) || 'https://yourstore.com';
  const platform = platformSelect.value;
  const focuses = Array.from(document.querySelectorAll('input[name="focus"]:checked')).map((c) => c.value);
  const notes = (notesInput.value || '').trim().slice(0, 1000) || 'None provided.';

  renderSummary(tier);

  const lines = [
    '## VitalsScout Audit Request',
    `- Website URL: ${url}`,
    `- Platform: ${platform}`,
    `- Service: ${tier.label} (${tier.price})`,
    `- Payment Method: ${tier.usdt ? 'USDT (BEP20 on BNB Smart Chain ONLY)' : 'Free ($0)'}`,
    `- Terms & SLA: ${tier.sla}`,
    `- Focus Areas: ${focuses.length ? focuses.join('; ') : 'General diagnostic'}`,
    `- Notes: ${notes}`,
  ];

  if (verifiedPayment && verifiedPayment.verified && verifiedPayment.paymentState === PAYMENT_STATES.CONFIRMED) {
    lines.push(
      `- Verified Payment [${verifiedPayment.paymentState}]: ${verifiedPayment.receivedUsdt} USDT (BEP20) | Block #${verifiedPayment.blockNumber} (${verifiedPayment.confirmations} confirmations) | Tx: ${verifiedPayment.txHash} | BscScan: ${verifiedPayment.bscscanUrl}`
    );
  } else if (tier.usdt) {
    const rawPendingHash = normalizeTxHash(txHashInput.value || '');
    if (rawPendingHash) {
      lines.push(`- Payment Status: Pending Independent Verification (Submitted Tx: ${rawPendingHash})`);
    } else {
      lines.push(`- Payment Status: Pending (${tier.usdt} USDT BEP20 due to ${RECEIVING_WALLET})`);
    }
  }

  const brief = lines.join('\n');
  outputEl.textContent = brief;
  const issueTitle = encodeURIComponent(`[Audit Request] ${url} (${tier.price})`);
  const issueBody = encodeURIComponent(`${brief}\n\n(Please remove or withhold any sensitive credentials before submitting.)`);
  ghLink.href = `https://github.com/ahmed62001/vitalsscout/issues/new?title=${issueTitle}&body=${issueBody}`;
}

function copyWithFallback(text, onSuccess, onFail) {
  const doFallback = () => {
    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.position = 'absolute';
    tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    tmp.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(tmp);
    if (ok) onSuccess();
    else onFail();
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess, doFallback);
  } else {
    doFallback();
  }
}

copyBtn.addEventListener('click', () => {
  copyWithFallback(
    outputEl.textContent,
    () => {
      copyBtn.textContent = 'Brief Copied!';
      copyStatus.textContent = 'Request brief copied to clipboard — paste it in a LinkedIn message to Ahmed or a GitHub Issue.';
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyBtn.textContent = 'Copy Request Brief';
      }, 2500);
    },
    () => {
      copyStatus.textContent = 'Copy blocked by browser; select the brief box above manually.';
    }
  );
});

copyWalletBtn.addEventListener('click', () => {
  copyWithFallback(
    RECEIVING_WALLET,
    () => {
      copyWalletBtn.textContent = 'Address Copied!';
      copyWalletStatus.textContent = 'USDT (BEP20) wallet address copied.';
      if (walletResetTimer) clearTimeout(walletResetTimer);
      walletResetTimer = setTimeout(() => {
        copyWalletBtn.textContent = 'Copy Wallet Address';
      }, 2500);
    },
    () => {
      copyWalletStatus.textContent = 'Copy blocked; select the wallet address above manually.';
    }
  );
});

verifyUsdtBtn.addEventListener('click', async () => {
  const serviceKey = tierSelect.value;
  if (serviceKey !== 'audit' && serviceKey !== 'audit-fix') {
    renderVerifyState(
      PAYMENT_STATES.FAILED,
      'is-error',
      'Select Website Diagnostic Audit ($20.86) or Website Audit + Fix ($48.86) to verify payment.'
    );
    return;
  }

  const rawHash = (txHashInput.value || '').trim();
  const normalized = normalizeTxHash(rawHash);
  verifiedPayment = null;
  updateBrief();

  if (!normalized) {
    renderVerifyState(
      PAYMENT_STATES.FAILED,
      'is-error',
      'Invalid transaction hash. Enter a 66-character 0x... BNB Smart Chain txHash.'
    );
    return;
  }

  const targetUrl = (urlInput.value || '').trim() || 'https://yourstore.com';
  const claimed = loadClaimedTxs();
  if (claimed[normalized] && claimed[normalized].targetUrl && claimed[normalized].targetUrl !== targetUrl) {
    renderVerifyState(
      PAYMENT_STATES.FAILED,
      'is-error',
      `Duplicate transaction claim blocked: this txHash was already submitted in this browser for "${claimed[normalized].targetUrl}". Each txHash can pay for one order only.`,
      `https://bscscan.com/tx/${normalized}`,
      'View on BscScan'
    );
    return;
  }

  const now = Date.now();
  while (recentRpcAttempts.length > 0 && now - recentRpcAttempts[0] > RATE_WINDOW_MS) {
    recentRpcAttempts.shift();
  }
  if (now - lastVerifyAtMs < VERIFY_COOLDOWN_MS || recentRpcAttempts.length >= MAX_CHECKS_PER_WINDOW) {
    renderVerifyState(
      PAYMENT_STATES.PENDING,
      'is-pending',
      'Please wait a few seconds before re-checking BNB Smart Chain (rate-limit cooldown active).'
    );
    return;
  }

  lastVerifyAtMs = now;
  recentRpcAttempts.push(now);
  verifyUsdtBtn.disabled = true;
  verifyUsdtBtn.textContent = 'Verifying on BSC...';
  renderVerifyState(PAYMENT_STATES.PENDING, 'is-pending', 'Querying BNB Smart Chain Mainnet RPC quorum...');

  try {
    const result = await verifyUsdtBep20Payment({ txHash: normalized, serviceKey });
    if (result.verified && result.paymentState === PAYMENT_STATES.CONFIRMED) {
      verifiedPayment = result;
      saveClaimedTx(normalized, targetUrl, serviceKey);
      renderVerifyState(
        PAYMENT_STATES.CONFIRMED,
        'is-verified',
        `Received ${result.receivedUsdt} USDT (BEP20) at block #${result.blockNumber} (${result.confirmations} confirmations, 2-RPC quorum). Attached to your brief below.`,
        result.bscscanUrl,
        'View on BscScan'
      );
      updateBrief();
    } else if (result.paymentState === PAYMENT_STATES.EXPIRED) {
      renderVerifyState(PAYMENT_STATES.EXPIRED, 'is-expired', result.message, result.bscscanUrl, 'View on BscScan');
    } else if (result.paymentState === PAYMENT_STATES.PENDING) {
      renderVerifyState(PAYMENT_STATES.PENDING, 'is-pending', result.message, result.bscscanUrl, 'Check BscScan');
    } else {
      renderVerifyState(PAYMENT_STATES.FAILED, 'is-error', result.message, result.bscscanUrl, 'Check BscScan');
    }
  } catch (err) {
    renderVerifyState(
      PAYMENT_STATES.FAILED,
      'is-error',
      `Verification failed: ${err && err.message ? err.message : String(err)}`
    );
  } finally {
    verifyUsdtBtn.disabled = false;
    verifyUsdtBtn.textContent = 'Verify Payment on BNB Smart Chain';
  }
});

document.querySelectorAll('[data-select-tier]').forEach((el) => {
  el.addEventListener('click', () => {
    tierSelect.value = el.getAttribute('data-select-tier');
    updateBrief();
  });
});

[urlInput, platformSelect, tierSelect, notesInput, txHashInput].forEach((el) => {
  el.addEventListener('input', updateBrief);
  el.addEventListener('change', updateBrief);
});

document.querySelectorAll('input[name="focus"]').forEach((el) => {
  el.addEventListener('change', updateBrief);
});

updateBrief();
