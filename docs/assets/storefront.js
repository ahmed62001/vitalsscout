const FREE_ISSUE_TEMPLATE_URL = 'https://github.com/ahmed62001/vitalsscout/issues/new?template=audit-request.md';
const OFFICIAL_INTAKE_EMAIL = 'vitalsscout@proton.me';
const OFFICIAL_INTAKE_MAILTO = `mailto:${OFFICIAL_INTAKE_EMAIL}`;

const TIER_MAP = {
  free: {
    label: 'Free 1-Page Snapshot',
    price: '$0 USD',
    usdt: null,
    sla: 'One-time free diagnostic, within 24 hours, 1 public URL',
  },
  audit: {
    label: 'Website Diagnostic Audit',
    price: '$20.86 USD',
    usdt: '20.86',
    sla: 'One-time manual USDT (BSC — BEP20) payment after acceptance, 48 hours after payment verification, up to 5 templates',
  },
  'audit-fix': {
    label: 'Website Audit + Fix',
    price: '$48.86 USD',
    usdt: '48.86',
    sla: 'One-time manual USDT (BSC — BEP20) payment after acceptance, 3–5 business days after payment verification, up to 5 templates + code fixes & verification re-audit',
  },
};

const urlInput = document.getElementById('site-url');
const platformSelect = document.getElementById('platform');
const tierSelect = document.getElementById('package-tier');
const notesInput = document.getElementById('notes');
const summaryEl = document.getElementById('estimate-summary');
const outputEl = document.getElementById('brief-output');
const ghLink = document.getElementById('github-issue-link');
const ghDiscussionLink = document.getElementById('github-discussion-link');
const emailIntakeLink = document.getElementById('email-intake-link');
const copyBtn = document.getElementById('copy-brief-btn');
const copyEmailBtn = document.getElementById('copy-email-btn');
const copyStatus = document.getElementById('copy-status');

const freeWorkflowNote = document.getElementById('free-workflow-note');
const paidWorkflowNote = document.getElementById('paid-workflow-note');
const selectedAmountDue = document.getElementById('selected-amount-due');

let copyResetTimer = null;
let copyEmailResetTimer = null;

function defaultCopyLabel(tier) {
  return tier && tier.usdt ? 'Copy Private Request Brief' : 'Copy Free Snapshot Brief';
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
    document.createTextNode(` (${tier.sla}).`),
  );
}

function syncTierVisibility(tier) {
  const isPaid = Boolean(tier.usdt);
  if (freeWorkflowNote) freeWorkflowNote.hidden = isPaid;
  if (paidWorkflowNote) paidWorkflowNote.hidden = !isPaid;
  if (selectedAmountDue && tier.usdt) {
    selectedAmountDue.textContent = `${tier.usdt} USDT`;
  }
  if (emailIntakeLink) {
    emailIntakeLink.href = OFFICIAL_INTAKE_MAILTO;
  }
  if (ghLink) {
    ghLink.href = FREE_ISSUE_TEMPLATE_URL;
    ghLink.hidden = isPaid;
  }
  if (ghDiscussionLink) {
    ghDiscussionLink.hidden = isPaid;
  }
  if (copyBtn && !copyResetTimer) {
    copyBtn.textContent = defaultCopyLabel(tier);
  }
}

function updateBrief() {
  const tier = TIER_MAP[tierSelect.value] || TIER_MAP['audit-fix'];
  syncTierVisibility(tier);
  renderSummary(tier);

  const url = (urlInput.value || '').trim().slice(0, 300) || 'https://yourstore.com';
  const platform = platformSelect.value;
  const focuses = Array.from(document.querySelectorAll('input[name="focus"]:checked')).map((c) => c.value);
  const notes = (notesInput.value || '').trim().slice(0, 1000) || 'None provided.';

  const lines = tier.usdt
    ? [
        '## VitalsScout Private Service Request (DO NOT POST PUBLICLY)',
        `- Official Private Contact Email: ${OFFICIAL_INTAKE_EMAIL}`,
        `- Website URL: ${url}`,
        `- Platform: ${platform}`,
        `- Requested Service: ${tier.label} (${tier.price} / ${tier.usdt} USDT one-time)`,
        `- Payment Method: USDT on BNB Smart Chain (BEP20, Chain ID 56) ONLY`,
        `- Terms & SLA: ${tier.sla}`,
        `- Focus Areas: ${focuses.length ? focuses.join('; ') : 'General diagnostic'}`,
        `- Notes: ${notes}`,
        `- Payment Status: Awaiting manual operator review, acceptance, and private payment instructions via ${OFFICIAL_INTAKE_EMAIL} (do not send funds yet).`,
      ]
    : [
        '## VitalsScout Free 1-Page Snapshot Request ($0)',
        `- Private Email Option: ${OFFICIAL_INTAKE_EMAIL} (or submit public URL via GitHub template)`,
        `- Public Website URL: ${url}`,
        `- Platform: ${platform}`,
        `- Requested Service: ${tier.label} ($0)`,
        `- Focus Areas: ${focuses.length ? focuses.join('; ') : 'General diagnostic'}`,
        `- Public Notes (do not include private emails, credentials, or wallet data): ${notes}`,
      ];

  outputEl.textContent = lines.join('\n');
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
  const tier = TIER_MAP[tierSelect.value] || TIER_MAP['audit-fix'];
  copyWithFallback(
    outputEl.textContent,
    () => {
      copyBtn.textContent = 'Brief Copied!';
      copyStatus.textContent = tier.usdt
        ? 'Private request brief copied — email it privately to vitalsscout@proton.me and wait for manual acceptance before sending any payment.'
        : 'Free snapshot brief copied — email it privately to vitalsscout@proton.me or paste only non-sensitive public URLs into the free GitHub snapshot template.';
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyResetTimer = null;
        const currentTier = TIER_MAP[tierSelect.value] || TIER_MAP['audit-fix'];
        copyBtn.textContent = defaultCopyLabel(currentTier);
      }, 2500);
    },
    () => {
      copyStatus.textContent = 'Copy blocked by browser; select the brief box above manually and email it to vitalsscout@proton.me.';
    },
  );
});

if (copyEmailBtn) {
  copyEmailBtn.addEventListener('click', () => {
    copyWithFallback(
      OFFICIAL_INTAKE_EMAIL,
      () => {
        copyEmailBtn.textContent = 'Email Copied!';
        copyStatus.textContent = 'Copied vitalsscout@proton.me — paste your private request brief into an email to vitalsscout@proton.me.';
        if (copyEmailResetTimer) clearTimeout(copyEmailResetTimer);
        copyEmailResetTimer = setTimeout(() => {
          copyEmailResetTimer = null;
          copyEmailBtn.textContent = 'Copy Email (vitalsscout@proton.me)';
        }, 2500);
      },
      () => {
        copyStatus.textContent = 'Copy blocked by browser; copy vitalsscout@proton.me from the text above.';
      },
    );
  });
}

document.querySelectorAll('[data-select-tier]').forEach((el) => {
  el.addEventListener('click', () => {
    tierSelect.value = el.getAttribute('data-select-tier');
    updateBrief();
  });
});

[urlInput, platformSelect, tierSelect, notesInput].forEach((el) => {
  el.addEventListener('input', updateBrief);
  el.addEventListener('change', updateBrief);
});

document.querySelectorAll('input[name="focus"]').forEach((el) => {
  el.addEventListener('change', updateBrief);
});

updateBrief();
