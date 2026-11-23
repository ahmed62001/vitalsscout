import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BSC_CHAIN_ID,
  CUSTOMER_TX_UNVERIFIED_LABEL,
  MIN_CONFIRMATIONS,
  RECEIVING_WALLET,
  USDT_BEP20_CONTRACT,
  USDT_DECIMALS,
  USDT_SERVICES,
  isValidTxHash,
  normalizeTxHash,
  verifyUsdtBep20Payment,
} from './usdt-verifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_REGISTRY_PATH = path.join(PROJECT_ROOT, '.local-state', 'manual-orders.json');
const DOCS_DIR = path.resolve(PROJECT_ROOT, 'docs');

const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 15;
const DEFAULT_PAYMENT_WINDOW_MINUTES = 60;

export { CUSTOMER_TX_UNVERIFIED_LABEL };

export const MANUAL_ORDER_STATES = Object.freeze({
  ACCEPTED: 'Accepted',
  PAYMENT_INSTRUCTIONS_ISSUED: 'Payment Instructions Issued',
  TX_SUBMITTED_UNVERIFIED: 'Tx Submitted (Unverified)',
  MANUAL_REVIEW: 'Manual Review',
  PAID: 'Paid',
  FULFILLMENT_IN_PROGRESS: 'Fulfillment In Progress',
  FULFILLED: 'Fulfilled',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
});

export const UNRESOLVED_PAYMENT_WINDOW_STATES = Object.freeze(
  new Set([
    MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED,
    MANUAL_ORDER_STATES.TX_SUBMITTED_UNVERIFIED,
    MANUAL_ORDER_STATES.MANUAL_REVIEW,
  ]),
);

export const TERMINAL_CLOSED_STATES = Object.freeze([
  MANUAL_ORDER_STATES.EXPIRED,
  MANUAL_ORDER_STATES.FAILED,
  MANUAL_ORDER_STATES.CANCELLED,
  MANUAL_ORDER_STATES.FULFILLED,
]);

export const REQUIRED_VERIFICATION_CHECKS = Object.freeze([
  'chainId56',
  'usdtTokenContract',
  'depositRecipientAddress',
  'exactRequiredNetAmount',
  'receiptStatusSuccess',
  'min15Confirmations',
  'uniqueInReplayRegistry',
  'binanceDepositHistoryCompleted',
  'onChainAndBinanceConsistent',
]);

const ALLOWED_BINANCE_STATUSES = new Set(['completed', 'credited']);
const PENDING_BINANCE_STATUSES = new Set(['pending', 'processing', 'confirming', 'credited_locked']);
const ALLOWED_BINANCE_NETWORKS = new Set(['BSC', 'BEP20', 'BNB SMART CHAIN (BEP20)', 'BNB SMART CHAIN']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(parentDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseUsdtDecimalToBaseUnits(rawAmount) {
  const str = String(rawAmount ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    return null;
  }
  const whole = BigInt(match[1]);
  const fracRaw = match[2] || '';
  if (fracRaw.length > USDT_DECIMALS) {
    return null;
  }
  const fracPadded = fracRaw.padEnd(USDT_DECIMALS, '0');
  const scale = 10n ** BigInt(USDT_DECIMALS);
  return whole * scale + BigInt(fracPadded || '0');
}

function sanitizeText(value, maxLen, fieldName, { required = false } = {}) {
  const clean = String(value ?? '').trim();
  if (required && !clean) {
    const err = new Error(`${fieldName} is required.`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (clean.length > maxLen) {
    const err = new Error(`${fieldName} exceeds maximum length of ${maxLen} characters.`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return clean;
}

/**
 * Validates that registryPath is a safe .json regular file path outside public docs/.
 * @param {string} rawPath
 * @param {string} [projectRoot]
 */
export function validateRegistryPath(rawPath, projectRoot = PROJECT_ROOT) {
  const clean = String(rawPath ?? '').trim();
  if (!clean) {
    const err = new Error('Registry path is required.');
    err.code = 'INVALID_REGISTRY_PATH';
    throw err;
  }
  const resolved = path.resolve(clean);
  if (!resolved.toLowerCase().endsWith('.json')) {
    const err = new Error('Registry path must end with .json');
    err.code = 'INVALID_REGISTRY_PATH';
    throw err;
  }
  const docsDir = path.resolve(projectRoot, 'docs');
  const realDocs = fs.existsSync(docsDir) ? fs.realpathSync(docsDir) : docsDir;
  if (isInsideDir(resolved, docsDir) || isInsideDir(resolved, realDocs) || isInsideDir(resolved, DOCS_DIR)) {
    const err = new Error('Refusing to store private order registry inside public docs/ directory.');
    err.code = 'UNSAFE_REGISTRY_PATH';
    throw err;
  }

  for (const checkPath of [resolved, `${resolved}.lock`]) {
    if (fs.existsSync(checkPath)) {
      const lst = fs.lstatSync(checkPath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        const err = new Error(`Refusing non-regular or symlink registry path: ${checkPath}`);
        err.code = 'UNSAFE_REGISTRY_PATH';
        throw err;
      }
      const realTarget = fs.realpathSync(checkPath);
      if (isInsideDir(realTarget, realDocs) || isInsideDir(realTarget, DOCS_DIR)) {
        const err = new Error('Refusing registry target resolving inside public docs/ directory.');
        err.code = 'UNSAFE_REGISTRY_PATH';
        throw err;
      }
    }
  }

  return resolved;
}

async function ensurePrivateDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const resolvedDir = path.resolve(dirPath);
  const sharedRoots = new Set([
    path.resolve('/'),
    path.resolve(os.tmpdir()),
    path.resolve(os.homedir()),
    PROJECT_ROOT,
  ]);
  if (!sharedRoots.has(resolvedDir)) {
    await fsp.chmod(resolvedDir, 0o700).catch(() => {});
  }
}

function defaultRegistryData() {
  return {
    version: 1,
    orders: {},
    claimedTxHashes: {},
    claimedBinanceDepositRefs: {},
  };
}

function normalizeRegistryData(parsed) {
  const base = defaultRegistryData();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return base;
  }
  return {
    version: Number(parsed.version || 1),
    orders: parsed.orders && typeof parsed.orders === 'object' && !Array.isArray(parsed.orders) ? parsed.orders : {},
    claimedTxHashes:
      parsed.claimedTxHashes && typeof parsed.claimedTxHashes === 'object' && !Array.isArray(parsed.claimedTxHashes)
        ? parsed.claimedTxHashes
        : {},
    claimedBinanceDepositRefs:
      parsed.claimedBinanceDepositRefs &&
      typeof parsed.claimedBinanceDepositRefs === 'object' &&
      !Array.isArray(parsed.claimedBinanceDepositRefs)
        ? parsed.claimedBinanceDepositRefs
        : {},
  };
}

function generateAuthoritativeOrderId(ordersMap, nowMs) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  for (let i = 0; i < 32; i += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const candidate = `VS-${y}${m}${day}-${suffix}`;
    if (!ordersMap[candidate]) {
      return candidate;
    }
  }
  throw new Error('Failed to generate unique operator Order ID.');
}

function formatPaymentInstructionsMessage(order) {
  return [
    `Order ID: ${order.orderId}`,
    `Service: ${order.serviceName}`,
    `Required Net Amount: ${order.requiredAmountUsdt} USDT`,
    `Asset: USDT (Tether USD — BEP20)`,
    `Network: BNB Smart Chain (BEP20, Chain ID 56)`,
    `Binance BSC Deposit Address: ${RECEIVING_WALLET}`,
    `Official USDT BEP20 Token Contract: ${USDT_BEP20_CONTRACT}`,
    `Payment Window Expires: ${order.paymentWindowExpiresAt}`,
    `Official Private Contact Email: vitalsscout@proton.me`,
    ``,
    `Important:`,
    `- Send ONLY USDT on BNB Smart Chain (BEP20, Chain ID 56). Do not use ERC20, TRC20, or any other network.`,
    `- Ensure the net amount credited after withdrawal/network fees is exactly ${order.requiredAmountUsdt} USDT.`,
    `- Your Order ID is for our private communication only and is NOT embedded on-chain or proof of payment.`,
    `- After sending, reply privately via the same email thread at vitalsscout@proton.me with your 66-character 0x... BSC transaction hash and sending wallet address (or exchange withdrawal confirmation).`,
  ].join('\n');
}

function validateVerificationRecord(order, registrySnapshot = null) {
  const reasons = [];
  if (!order || typeof order !== 'object') {
    return { valid: false, reasons: ['ORDER_MISSING'] };
  }
  if (order.autoFulfillment !== false) {
    reasons.push('AUTO_FULFILLMENT_NOT_DISABLED');
  }
  if (order.manualReviewReason) {
    reasons.push(`UNRESOLVED_MANUAL_REVIEW: ${order.manualReviewReason}`);
  }
  if (order.ambiguityFlag) {
    reasons.push('UNRESOLVED_AMBIGUITY_FLAG');
  }
  if (!order.paymentInstructionsIssued || !order.paymentInstructionsIssuedAt) {
    reasons.push('PAYMENT_INSTRUCTIONS_NOT_ISSUED');
  }
  const normalizedTx = normalizeTxHash(order.paymentTxHash);
  if (!normalizedTx || !isValidTxHash(normalizedTx)) {
    reasons.push('MISSING_OR_INVALID_TX_HASH');
  }
  const verification = order.verification;
  if (!verification || typeof verification !== 'object') {
    reasons.push('MISSING_VERIFICATION_RECORD');
  } else {
    if (verification.outcome !== 'VERIFIED_PAID') {
      reasons.push(`VERIFICATION_OUTCOME_NOT_VERIFIED_PAID (${verification.outcome || 'none'})`);
    }
    if (!verification.verifiedAt || !Number.isFinite(Date.parse(String(verification.verifiedAt)))) {
      reasons.push('MISSING_VERIFIED_AT_TIMESTAMP');
    }
    const checks = verification.checks && typeof verification.checks === 'object' ? verification.checks : {};
    for (const checkKey of REQUIRED_VERIFICATION_CHECKS) {
      if (checks[checkKey] !== true) {
        reasons.push(`FAILED_CHECK_${checkKey}`);
      }
    }
  }
  if (registrySnapshot && normalizedTx) {
    const claim = registrySnapshot.claimedTxHashes?.[normalizedTx];
    if (!claim || claim.orderId !== order.orderId || claim.status !== 'VERIFIED_PAID') {
      reasons.push('TX_NOT_BOUND_AS_VERIFIED_IN_REPLAY_REGISTRY');
    }
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Pure policy gate returning whether manual fulfillment may begin for an order.
 * @param {object} order
 * @param {object|null} [registrySnapshot]
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function canStartFulfillment(order, registrySnapshot = null) {
  const reasons = [];
  if (!order || typeof order !== 'object') {
    return { allowed: false, reasons: ['ORDER_MISSING'] };
  }
  if (order.status !== MANUAL_ORDER_STATES.PAID) {
    reasons.push(`ORDER_STATUS_NOT_PAID (${order.status || 'unknown'})`);
  }
  const verificationCheck = validateVerificationRecord(order, registrySnapshot);
  reasons.push(...verificationCheck.reasons);
  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

function evaluateBinanceWebRecord(binanceRecord, expectedTxHash, order, storeData) {
  if (!binanceRecord || typeof binanceRecord !== 'object' || Array.isArray(binanceRecord)) {
    return {
      completed: false,
      consistent: false,
      pending: false,
      reason: 'BINANCE_DEPOSIT_RECORD_MISSING',
      summary: null,
    };
  }

  const rawStatus = String(binanceRecord.status || '').trim();
  const statusLower = rawStatus.toLowerCase();
  const coin = String(binanceRecord.coin || '').trim().toUpperCase();
  const network = String(binanceRecord.network || '').trim().toUpperCase();
  const address = String(binanceRecord.address || '').trim().toLowerCase();
  const txIdNormalized = normalizeTxHash(binanceRecord.txId);
  const creditedAmountStr = String(binanceRecord.creditedAmountUsdt ?? '').trim();
  const creditedBaseUnits = parseUsdtDecimalToBaseUnits(creditedAmountStr);
  const depositRef = String(binanceRecord.depositRef || '').trim();
  const checkedAt = String(binanceRecord.checkedAt || '').trim() || null;

  const summary = {
    status: rawStatus,
    txId: txIdNormalized || String(binanceRecord.txId || ''),
    coin,
    network,
    address,
    creditedAmountUsdt: creditedAmountStr,
    depositRef: depositRef || null,
    checkedAt,
  };

  if (depositRef && storeData?.claimedBinanceDepositRefs?.[depositRef]) {
    const existingDepClaim = storeData.claimedBinanceDepositRefs[depositRef];
    if (existingDepClaim.orderId !== order.orderId) {
      return {
        completed: false,
        consistent: false,
        pending: false,
        reason: 'BINANCE_DEPOSIT_REF_ALREADY_CLAIMED',
        summary,
      };
    }
  }

  if (PENDING_BINANCE_STATUSES.has(statusLower)) {
    return {
      completed: false,
      consistent: false,
      pending: true,
      reason: 'BINANCE_DEPOSIT_PENDING',
      summary,
    };
  }

  const statusOk = ALLOWED_BINANCE_STATUSES.has(statusLower);
  const coinOk = coin === 'USDT';
  const networkOk = ALLOWED_BINANCE_NETWORKS.has(network);
  const addressOk = address === RECEIVING_WALLET.toLowerCase();
  const amountValid = creditedBaseUnits !== null && creditedBaseUnits > 0n;
  const txIdValid = Boolean(txIdNormalized);

  const completed = statusOk && coinOk && networkOk && addressOk && amountValid && txIdValid;
  if (!completed) {
    return {
      completed: false,
      consistent: false,
      pending: false,
      reason: !statusOk
        ? 'BINANCE_STATUS_NOT_COMPLETED_OR_CREDITED'
        : !coinOk
          ? 'BINANCE_WRONG_COIN'
          : !networkOk
            ? 'BINANCE_WRONG_NETWORK'
            : !addressOk
              ? 'BINANCE_ADDRESS_MISMATCH'
              : !txIdValid
                ? 'BINANCE_INVALID_TXID'
                : 'BINANCE_INVALID_AMOUNT',
      summary,
      creditedBaseUnits,
    };
  }

  const expectedBaseUnits = BigInt(order.requiredAmountBaseUnits);
  const consistent =
    txIdNormalized === expectedTxHash &&
    creditedBaseUnits === expectedBaseUnits;

  return {
    completed: true,
    consistent,
    pending: false,
    reason: consistent
      ? 'BINANCE_DEPOSIT_CONFIRMED'
      : txIdNormalized !== expectedTxHash
        ? 'BINANCE_ONCHAIN_TXID_MISMATCH'
        : 'BINANCE_ONCHAIN_AMOUNT_MISMATCH',
    summary,
    creditedBaseUnits,
  };
}

/**
 * Operator-controlled local manual order and payment registry with atomic writes,
 * exclusive file locking, restrictive permissions (0700/0600), and single active payment window enforcement.
 *
 * @param {string} [registryPath]
 * @param {object} [options]
 */
export function createManualOrderRegistry(registryPath = DEFAULT_REGISTRY_PATH, options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const resolvedPath = validateRegistryPath(registryPath, projectRoot);
  const lockPath = `${resolvedPath}.lock`;
  const dirPath = path.dirname(resolvedPath);
  const nowFn = options.nowFn || (() => Date.now());
  let queue = Promise.resolve();

  async function acquireFileLock() {
    validateRegistryPath(resolvedPath, projectRoot);
    await ensurePrivateDir(dirPath);
    const deadline = Date.now() + STALE_LOCK_MS;

    while (true) {
      try {
        const handle = await fsp.open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        return handle;
      } catch (err) {
        if (err?.code !== 'EEXIST') {
          throw err;
        }
        try {
          const stat = await fsp.lstat(lockPath);
          if (stat.isSymbolicLink()) {
            const symErr = new Error(`Refusing symlink lockfile: ${lockPath}`);
            symErr.code = 'UNSAFE_REGISTRY_PATH';
            throw symErr;
          }
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fsp.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch (statErr) {
          if (statErr?.code === 'UNSAFE_REGISTRY_PATH') throw statErr;
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for manual order registry lock: ${lockPath}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  async function releaseFileLock(handle) {
    try {
      await handle?.close();
    } finally {
      await fsp.unlink(lockPath).catch(() => {});
    }
  }

  async function readRaw() {
    validateRegistryPath(resolvedPath, projectRoot);
    try {
      const content = await fsp.readFile(resolvedPath, 'utf8');
      return normalizeRegistryData(JSON.parse(content));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return defaultRegistryData();
      }
      throw err;
    }
  }

  async function writeAtomic(data) {
    validateRegistryPath(resolvedPath, projectRoot);
    await ensurePrivateDir(dirPath);
    const tmpPath = `${resolvedPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify(data, null, 2);
    await fsp.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(tmpPath, 0o600);
    await fsp.rename(tmpPath, resolvedPath);
    await fsp.chmod(resolvedPath, 0o600);
  }

  function runExclusive(task) {
    const run = queue.then(async () => {
      const handle = await acquireFileLock();
      try {
        return await task();
      } finally {
        await releaseFileLock(handle);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    getRegistryPath() {
      return resolvedPath;
    },

    async readSnapshot() {
      return runExclusive(() => readRaw());
    },

    async getOrder(orderId) {
      const snap = await this.readSnapshot();
      return snap.orders[orderId] ? structuredClone(snap.orders[orderId]) : null;
    },

    async listOrders() {
      const snap = await this.readSnapshot();
      return Object.values(snap.orders).map((o) => structuredClone(o));
    },

    async getActivePaymentWindow() {
      const snap = await this.readSnapshot();
      const active = Object.values(snap.orders).filter(
        (o) => o && UNRESOLVED_PAYMENT_WINDOW_STATES.has(o.status),
      );
      return active.map((o) => structuredClone(o));
    },

    /**
     * Step 2 & 3: Operator reviews and accepts a private request, creating an authoritative local order.
     * Does NOT issue payment instructions or expose the Binance deposit address.
     */
    async createOrder({ serviceKey, targetUrl, contactChannel, contactHandle, operator, notes = '' }) {
      const service = USDT_SERVICES[serviceKey];
      if (!service) {
        const err = new Error(`Invalid serviceKey "${String(serviceKey || '')}". Expected "audit" or "audit-fix".`);
        err.code = 'INVALID_SERVICE';
        throw err;
      }

      const cleanUrl = sanitizeText(targetUrl, 500, 'targetUrl', { required: true });
      if (!/^https?:\/\/[^\s]{3,}/i.test(cleanUrl)) {
        const err = new Error('targetUrl must start with http:// or https://.');
        err.code = 'INVALID_TARGET_URL';
        throw err;
      }
      const cleanChannel = sanitizeText(contactChannel, 80, 'contactChannel', { required: true });
      const cleanHandle = sanitizeText(contactHandle, 200, 'contactHandle', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });
      const cleanNotes = sanitizeText(notes, 1000, 'notes');

      return runExclusive(async () => {
        const data = await readRaw();
        const nowMs = nowFn();
        const nowIso = new Date(nowMs).toISOString();
        const orderId = generateAuthoritativeOrderId(data.orders, nowMs);

        const order = {
          orderId,
          orderIdAuthority: 'operator-local-registry',
          serviceKey: service.key,
          serviceName: service.name,
          requiredAmountUsdt: service.expectedUsdt,
          requiredAmountBaseUnits: service.expectedBaseUnits.toString(),
          paymentAsset: 'USDT',
          network: 'BNB Smart Chain (BEP20)',
          chainId: BSC_CHAIN_ID,
          usdtContract: USDT_BEP20_CONTRACT,
          targetUrl: cleanUrl,
          contactChannel: cleanChannel,
          contactHandle: cleanHandle,
          notes: cleanNotes,
          status: MANUAL_ORDER_STATES.ACCEPTED,
          autoFulfillment: false,
          paymentInstructionsIssued: false,
          paymentInstructionsIssuedAt: null,
          paymentWindowExpiresAt: null,
          paymentWindowExpiresAtMs: null,
          paymentTxHash: null,
          txSubmissionLabel: null,
          txSubmittedAt: null,
          txSubmissionChannel: null,
          verification: null,
          manualReviewReason: null,
          ambiguityFlag: false,
          fulfillmentStartedAt: null,
          fulfilledAt: null,
          createdAt: nowIso,
          createdAtMs: nowMs,
          updatedAt: nowIso,
          auditTrail: [
            {
              timestamp: nowIso,
              action: 'ORDER_CREATED_ACCEPTED',
              fromStatus: null,
              toStatus: MANUAL_ORDER_STATES.ACCEPTED,
              operator: cleanOperator,
              notes: cleanNotes || 'Private request reviewed and accepted by operator.',
            },
          ],
        };

        data.orders[orderId] = order;
        await writeAtomic(data);
        return structuredClone(order);
      });
    },

    /**
     * Step 4: Operator manually issues payment instructions for one accepted order at a time.
     * Blocks issuance whenever any other order is in an unresolved payment window.
     */
    async issuePaymentInstructions({ orderId, operator, ttlMinutes = DEFAULT_PAYMENT_WINDOW_MINUTES }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });
      const parsedTtl = Number(ttlMinutes);
      if (!Number.isFinite(parsedTtl) || parsedTtl <= 0 || parsedTtl > 1440) {
        return {
          ok: false,
          code: 'INVALID_TTL_MINUTES',
          error: 'ttlMinutes must be between 1 and 1440.',
        };
      }

      return runExclusive(async () => {
        const data = await readRaw();
        const blocking = Object.values(data.orders).filter(
          (o) => o && o.orderId !== cleanOrderId && UNRESOLVED_PAYMENT_WINDOW_STATES.has(o.status),
        );
        if (blocking.length > 0) {
          return {
            ok: false,
            code: 'ACTIVE_PAYMENT_WINDOW_LOCKED',
            blockingOrderIds: blocking.map((o) => o.orderId),
            error: `Cannot issue payment instructions while unresolved payment window exists for order(s): ${blocking.map((o) => `${o.orderId} (${o.status})`).join(', ')}.`,
          };
        }

        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }
        if (ord.status !== MANUAL_ORDER_STATES.ACCEPTED) {
          return {
            ok: false,
            code: 'INVALID_ORDER_STATE',
            status: ord.status,
            error: `Order ${cleanOrderId} must be in Accepted state to issue payment instructions (current: ${ord.status}).`,
          };
        }

        const nowMs = nowFn();
        const nowIso = new Date(nowMs).toISOString();
        const expiresAtMs = nowMs + parsedTtl * 60 * 1000;
        const expiresAtIso = new Date(expiresAtMs).toISOString();

        const prevStatus = ord.status;
        ord.status = MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED;
        ord.paymentInstructionsIssued = true;
        ord.paymentInstructionsIssuedAt = nowIso;
        ord.paymentInstructionsIssuedAtMs = nowMs;
        ord.paymentWindowExpiresAt = expiresAtIso;
        ord.paymentWindowExpiresAtMs = expiresAtMs;
        ord.updatedAt = nowIso;
        ord.auditTrail.push({
          timestamp: nowIso,
          action: 'PAYMENT_INSTRUCTIONS_ISSUED',
          fromStatus: prevStatus,
          toStatus: ord.status,
          operator: cleanOperator,
          ttlMinutes: parsedTtl,
          paymentWindowExpiresAt: expiresAtIso,
        });

        await writeAtomic(data);
        const snapshot = structuredClone(ord);
        return {
          ok: true,
          order: snapshot,
          paymentInstructionsText: formatPaymentInstructionsMessage(snapshot),
        };
      });
    },

    /**
     * Step 5: Record customer-submitted txHash strictly labeled UNVERIFIED.
     */
    async recordCustomerTxHash({ orderId, txHash, channel, operator, notes = '' }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanChannel = sanitizeText(channel, 80, 'channel', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });
      const cleanNotes = sanitizeText(notes, 500, 'notes');
      const normalizedHash = normalizeTxHash(txHash);
      if (!normalizedHash) {
        return {
          ok: false,
          code: 'INVALID_TX_HASH',
          error: 'Transaction hash must be a valid 66-character 0x-prefixed hex string.',
        };
      }

      return runExclusive(async () => {
        const data = await readRaw();
        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }
        if (
          ![
            MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED,
            MANUAL_ORDER_STATES.TX_SUBMITTED_UNVERIFIED,
            MANUAL_ORDER_STATES.MANUAL_REVIEW,
          ].includes(ord.status)
        ) {
          return {
            ok: false,
            code: 'INVALID_ORDER_STATE',
            error: `Order ${cleanOrderId} cannot accept txHash in state ${ord.status}.`,
          };
        }

        const existingClaim = data.claimedTxHashes[normalizedHash];
        if (existingClaim && existingClaim.orderId !== cleanOrderId) {
          return {
            ok: false,
            rejected: true,
            code: 'TX_HASH_ALREADY_CLAIMED',
            claimedByOrderId: existingClaim.orderId,
            error: `Transaction ${normalizedHash} is already recorded for order ${existingClaim.orderId}.`,
          };
        }

        const nowIso = new Date(nowFn()).toISOString();
        if (ord.paymentTxHash && ord.paymentTxHash !== normalizedHash) {
          const prevStatus = ord.status;
          ord.status = MANUAL_ORDER_STATES.MANUAL_REVIEW;
          ord.ambiguityFlag = true;
          ord.manualReviewReason = `Conflicting customer transaction hash submitted (${normalizedHash} vs existing ${ord.paymentTxHash}).`;
          ord.updatedAt = nowIso;
          ord.auditTrail.push({
            timestamp: nowIso,
            action: 'CONFLICTING_TX_HASH_FLAGGED',
            fromStatus: prevStatus,
            toStatus: ord.status,
            operator: cleanOperator,
            submittedTxHash: normalizedHash,
            label: CUSTOMER_TX_UNVERIFIED_LABEL,
          });
          await writeAtomic(data);
          return {
            ok: false,
            code: 'CONFLICTING_TX_HASH',
            order: structuredClone(ord),
            error: ord.manualReviewReason,
          };
        }

        const prevStatus = ord.status;
        data.claimedTxHashes[normalizedHash] = {
          orderId: cleanOrderId,
          recordedAt: existingClaim?.recordedAt || nowIso,
          status: 'UNVERIFIED',
        };
        ord.paymentTxHash = normalizedHash;
        ord.txSubmissionLabel = CUSTOMER_TX_UNVERIFIED_LABEL;
        ord.txSubmittedAt = nowIso;
        ord.txSubmissionChannel = cleanChannel;
        ord.status = MANUAL_ORDER_STATES.TX_SUBMITTED_UNVERIFIED;
        ord.updatedAt = nowIso;
        ord.auditTrail.push({
          timestamp: nowIso,
          action: 'CUSTOMER_TX_RECORDED',
          fromStatus: prevStatus,
          toStatus: ord.status,
          operator: cleanOperator,
          channel: cleanChannel,
          txHash: normalizedHash,
          label: CUSTOMER_TX_UNVERIFIED_LABEL,
          ...(cleanNotes ? { notes: cleanNotes } : {}),
        });

        await writeAtomic(data);
        return {
          ok: true,
          label: CUSTOMER_TX_UNVERIFIED_LABEL,
          order: structuredClone(ord),
        };
      });
    },

    /**
     * Step 6 & 7: Independent verification across all 9 required checks before setting Paid.
     * Uses BSC RPC quorum + replay registry + Binance web Deposit History attestation (no Binance API required).
     */
    async verifyManualPayment({
      orderId,
      txHash,
      binanceRecord,
      operator,
      notes = '',
      clearManualReviewReason = '',
      verifyOnChainImpl = verifyUsdtBep20Payment,
      rpcEndpoints,
      fetchImpl,
    }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });
      const cleanNotes = sanitizeText(notes, 1000, 'notes');
      const cleanClearReason = sanitizeText(clearManualReviewReason, 500, 'clearManualReviewReason');

      const snapBefore = await this.readSnapshot();
      const existingOrder = snapBefore.orders[cleanOrderId];
      if (!existingOrder) {
        return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
      }

      const candidateTx = txHash || existingOrder.paymentTxHash;
      const normalizedHash = normalizeTxHash(candidateTx);
      if (!normalizedHash) {
        return {
          ok: false,
          code: 'INVALID_TX_HASH',
          error: 'A valid 66-character 0x... BNB Smart Chain txHash is required.',
        };
      }

      if (
        existingOrder.status === MANUAL_ORDER_STATES.PAID ||
        existingOrder.status === MANUAL_ORDER_STATES.FULFILLMENT_IN_PROGRESS ||
        existingOrder.status === MANUAL_ORDER_STATES.FULFILLED
      ) {
        if (existingOrder.paymentTxHash && existingOrder.paymentTxHash !== normalizedHash) {
          return {
            ok: false,
            rejected: true,
            code: 'ORDER_ALREADY_PAID_DIFFERENT_TX',
            error: `Order ${cleanOrderId} is already Paid with txHash ${existingOrder.paymentTxHash}.`,
          };
        }
        return { ok: true, idempotent: true, order: existingOrder };
      }

      if (!existingOrder.paymentInstructionsIssued || !existingOrder.paymentInstructionsIssuedAt) {
        return {
          ok: false,
          code: 'PAYMENT_INSTRUCTIONS_NOT_ISSUED',
          error: `Order ${cleanOrderId} has not had payment instructions issued.`,
        };
      }

      if (existingOrder.status === MANUAL_ORDER_STATES.CANCELLED || existingOrder.status === MANUAL_ORDER_STATES.FAILED) {
        return {
          ok: false,
          code: 'ORDER_CLOSED',
          error: `Order ${cleanOrderId} is closed in status ${existingOrder.status}.`,
        };
      }

      const preClaim = snapBefore.claimedTxHashes[normalizedHash];
      if (preClaim && preClaim.orderId !== cleanOrderId) {
        return {
          ok: false,
          rejected: true,
          code: 'TX_HASH_ALREADY_CLAIMED',
          claimedByOrderId: preClaim.orderId,
          error: `Transaction ${normalizedHash} has already been claimed by order ${preClaim.orderId}.`,
        };
      }

      if (existingOrder.paymentTxHash && existingOrder.paymentTxHash !== normalizedHash) {
        return runExclusive(async () => {
          const data = await readRaw();
          const ord = data.orders[cleanOrderId];
          if (!ord) return { ok: false, code: 'ORDER_NOT_FOUND' };
          const nowIso = new Date(nowFn()).toISOString();
          const prevStatus = ord.status;
          ord.status = MANUAL_ORDER_STATES.MANUAL_REVIEW;
          ord.ambiguityFlag = true;
          ord.manualReviewReason = `Conflicting transaction hash (${normalizedHash} vs ${ord.paymentTxHash}).`;
          ord.updatedAt = nowIso;
          ord.auditTrail.push({
            timestamp: nowIso,
            action: 'VERIFY_PAYMENT_CONFLICT_MANUAL_REVIEW',
            fromStatus: prevStatus,
            toStatus: ord.status,
            operator: cleanOperator,
            txHash: normalizedHash,
          });
          await writeAtomic(data);
          return {
            ok: false,
            code: 'CONFLICTING_TX_HASH',
            order: structuredClone(ord),
            error: ord.manualReviewReason,
          };
        });
      }

      const onChainRes = await verifyOnChainImpl({
        txHash: normalizedHash,
        serviceKey: existingOrder.serviceKey,
        minConfirmations: MIN_CONFIRMATIONS,
        orderCreatedAt: existingOrder.paymentInstructionsIssuedAt,
        orderExpiresAt: existingOrder.paymentWindowExpiresAt,
        maxAgeSeconds: null,
        nowMs: nowFn(),
        ...(rpcEndpoints ? { rpcEndpoints } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      const binanceEval = evaluateBinanceWebRecord(binanceRecord, normalizedHash, existingOrder, snapBefore);

      return runExclusive(async () => {
        const data = await readRaw();
        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }
        if (ord.status === MANUAL_ORDER_STATES.PAID) {
          return { ok: true, idempotent: true, order: structuredClone(ord) };
        }

        const lockClaim = data.claimedTxHashes[normalizedHash];
        const uniqueInReplayRegistry =
          (!lockClaim || lockClaim.orderId === cleanOrderId) &&
          binanceEval.reason !== 'BINANCE_DEPOSIT_REF_ALREADY_CLAIMED';

        if (!uniqueInReplayRegistry) {
          return {
            ok: false,
            rejected: true,
            code: 'TX_HASH_ALREADY_CLAIMED',
            claimedByOrderId: lockClaim?.orderId || null,
            error: `Transaction ${normalizedHash} or Binance deposit reference is already claimed by another order.`,
          };
        }

        const onChainStatus = String(onChainRes?.status || '');
        const isConfirmedOnChain = Boolean(onChainRes?.onChainVerified === true && onChainRes?.verified === true);
        const chainId56 =
          isConfirmedOnChain
            ? onChainRes.chainId === BSC_CHAIN_ID
            : [
                'PENDING_CONFIRMATIONS',
                'INSUFFICIENT_AMOUNT',
                'OVERPAID_AMOUNT',
                'NO_MATCHING_USDT_TRANSFER',
                'TX_REVERTED',
                'TX_PRE_ORDER',
                'PAYMENT_EXPIRED',
              ].includes(onChainStatus);

        const usdtTokenContract = isConfirmedOnChain
          ? String(onChainRes.contract || '').toLowerCase() === USDT_BEP20_CONTRACT.toLowerCase()
          : ['PENDING_CONFIRMATIONS', 'INSUFFICIENT_AMOUNT', 'OVERPAID_AMOUNT', 'TX_PRE_ORDER', 'PAYMENT_EXPIRED'].includes(
              onChainStatus,
            );

        const depositRecipientAddress = isConfirmedOnChain
          ? String(onChainRes.recipient || '').toLowerCase() === RECEIVING_WALLET.toLowerCase()
          : ['PENDING_CONFIRMATIONS', 'INSUFFICIENT_AMOUNT', 'OVERPAID_AMOUNT', 'TX_PRE_ORDER', 'PAYMENT_EXPIRED'].includes(
              onChainStatus,
            );

        const exactRequiredNetAmount =
          onChainRes?.receivedBaseUnits !== undefined &&
          String(onChainRes.receivedBaseUnits) === String(ord.requiredAmountBaseUnits) &&
          !['INSUFFICIENT_AMOUNT', 'OVERPAID_AMOUNT'].includes(onChainStatus);

        const receiptStatusSuccess = isConfirmedOnChain
          ? onChainRes?.checks?.receiptStatusSuccess === true
          : [
              'PENDING_CONFIRMATIONS',
              'INSUFFICIENT_AMOUNT',
              'OVERPAID_AMOUNT',
              'NO_MATCHING_USDT_TRANSFER',
              'TX_PRE_ORDER',
              'PAYMENT_EXPIRED',
            ].includes(onChainStatus);

        const min15Confirmations =
          Number(onChainRes?.confirmations || 0) >= MIN_CONFIRMATIONS &&
          receiptStatusSuccess &&
          onChainStatus !== 'PENDING_CONFIRMATIONS' &&
          onChainStatus !== 'PENDING_MEMPOOL' &&
          onChainStatus !== 'RPC_QUORUM_UNAVAILABLE' &&
          onChainStatus !== 'RPC_CONSENSUS_MISMATCH';

        const binanceDepositHistoryCompleted = Boolean(binanceEval.completed);
        const noUnresolvedAmbiguity = !ord.ambiguityFlag || Boolean(cleanClearReason);
        const onChainWindowValid =
          isConfirmedOnChain &&
          onChainStatus === 'ON_CHAIN_CONFIRMED_AWAITING_BINANCE' &&
          ord.status !== MANUAL_ORDER_STATES.EXPIRED;

        const onChainAndBinanceConsistent =
          chainId56 &&
          usdtTokenContract &&
          depositRecipientAddress &&
          exactRequiredNetAmount &&
          receiptStatusSuccess &&
          min15Confirmations &&
          uniqueInReplayRegistry &&
          binanceDepositHistoryCompleted &&
          binanceEval.consistent &&
          onChainWindowValid &&
          noUnresolvedAmbiguity &&
          String(onChainRes.receivedBaseUnits || '') === String(binanceEval.creditedBaseUnits ?? '');

        const checks = {
          chainId56,
          usdtTokenContract,
          depositRecipientAddress,
          exactRequiredNetAmount,
          receiptStatusSuccess,
          min15Confirmations,
          uniqueInReplayRegistry,
          binanceDepositHistoryCompleted,
          onChainAndBinanceConsistent,
        };

        const failedChecks = REQUIRED_VERIFICATION_CHECKS.filter((k) => checks[k] !== true);
        const allChecksPassed = failedChecks.length === 0;
        const nowIso = new Date(nowFn()).toISOString();
        const prevStatus = ord.status;

        const shouldClaimTxInRegistry =
          allChecksPassed ||
          [
            'ON_CHAIN_CONFIRMED_AWAITING_BINANCE',
            'INSUFFICIENT_AMOUNT',
            'OVERPAID_AMOUNT',
            'PENDING_CONFIRMATIONS',
            'TX_PRE_ORDER',
            'PAYMENT_EXPIRED',
            'RPC_CONSENSUS_MISMATCH',
          ].includes(onChainStatus);

        if (shouldClaimTxInRegistry) {
          data.claimedTxHashes[normalizedHash] = {
            orderId: cleanOrderId,
            recordedAt: lockClaim?.recordedAt || nowIso,
            verifiedAt: allChecksPassed ? nowIso : lockClaim?.verifiedAt || null,
            status: allChecksPassed ? 'VERIFIED_PAID' : 'UNVERIFIED',
          };
          ord.paymentTxHash = normalizedHash;
          ord.txSubmissionLabel = ord.txSubmissionLabel || CUSTOMER_TX_UNVERIFIED_LABEL;
        }

        let nextStatus = ord.status;
        let outcome;
        let manualReviewReason = ord.manualReviewReason;

        if (allChecksPassed) {
          if (binanceEval.summary?.depositRef) {
            data.claimedBinanceDepositRefs[binanceEval.summary.depositRef] = {
              orderId: cleanOrderId,
              txHash: normalizedHash,
              verifiedAt: nowIso,
            };
          }
          nextStatus = MANUAL_ORDER_STATES.PAID;
          outcome = 'VERIFIED_PAID';
          manualReviewReason = null;
          ord.ambiguityFlag = false;
        } else {
          const isPending =
            ['PENDING_MEMPOOL', 'PENDING_CONFIRMATIONS', 'RPC_UNAVAILABLE', 'RPC_QUORUM_UNAVAILABLE', 'FETCH_UNAVAILABLE'].includes(
              onChainStatus,
            ) || binanceEval.pending;

          const isHardFail =
            ['WRONG_NETWORK', 'TX_REVERTED', 'NO_MATCHING_USDT_TRANSFER', 'TX_NOT_FOUND', 'RECEIPT_HASH_MISMATCH'].includes(
              onChainStatus,
            ) && !ord.ambiguityFlag;

          const requiresManualReview =
            ord.ambiguityFlag ||
            ['OVERPAID_AMOUNT', 'INSUFFICIENT_AMOUNT', 'PAYMENT_EXPIRED', 'TX_PRE_ORDER', 'RPC_CONSENSUS_MISMATCH'].includes(
              onChainStatus,
            ) ||
            ord.status === MANUAL_ORDER_STATES.EXPIRED ||
            (isConfirmedOnChain && !binanceEval.pending);

          if (requiresManualReview) {
            nextStatus = MANUAL_ORDER_STATES.MANUAL_REVIEW;
            outcome = 'MANUAL_REVIEW_REQUIRED';
            manualReviewReason =
              cleanNotes ||
              onChainRes?.message ||
              binanceEval.reason ||
              `Failed checks: ${failedChecks.join(', ')}`;
          } else if (isPending) {
            nextStatus = MANUAL_ORDER_STATES.TX_SUBMITTED_UNVERIFIED;
            outcome = 'PENDING_VERIFICATION';
          } else if (isHardFail) {
            nextStatus = MANUAL_ORDER_STATES.FAILED;
            outcome = 'VERIFICATION_FAILED';
          } else {
            nextStatus = MANUAL_ORDER_STATES.MANUAL_REVIEW;
            outcome = 'MANUAL_REVIEW_REQUIRED';
            manualReviewReason = `Failed checks: ${failedChecks.join(', ')}`;
          }
        }

        ord.status = nextStatus;
        ord.manualReviewReason = manualReviewReason;
        ord.updatedAt = nowIso;
        ord.verification = {
          verifiedAt: nowIso,
          operator: cleanOperator,
          outcome,
          failedChecks,
          checks,
          onChainSummary: {
            status: onChainRes?.status || null,
            paymentState: onChainRes?.paymentState || null,
            chainId: onChainRes?.chainId || null,
            contract: onChainRes?.contract || null,
            recipient: onChainRes?.recipient || null,
            blockNumber: onChainRes?.blockNumber ?? null,
            blockTimestamp: onChainRes?.blockTimestamp || null,
            confirmations: Number(onChainRes?.confirmations || 0),
            receivedUsdt: onChainRes?.receivedUsdt || null,
            receivedBaseUnits: onChainRes?.receivedBaseUnits || null,
            quorumVerified: Boolean(onChainRes?.quorumVerified),
            quorumRpcs: onChainRes?.quorumRpcs || [],
          },
          binanceSummary: binanceEval.summary,
          binanceReason: binanceEval.reason,
          notes: cleanNotes || null,
          ...(cleanClearReason ? { clearedManualReviewReason: cleanClearReason } : {}),
        };

        ord.auditTrail.push({
          timestamp: nowIso,
          action: allChecksPassed ? 'VERIFY_PAYMENT_PAID' : 'VERIFY_PAYMENT_REJECTED',
          fromStatus: prevStatus,
          toStatus: nextStatus,
          operator: cleanOperator,
          txHash: normalizedHash,
          outcome,
          failedChecks,
          ...(cleanClearReason ? { clearedManualReviewReason: cleanClearReason } : {}),
          ...(cleanNotes ? { notes: cleanNotes } : {}),
        });

        await writeAtomic(data);
        return {
          ok: allChecksPassed,
          code: allChecksPassed ? 'VERIFIED_PAID' : outcome,
          failedChecks,
          checks,
          order: structuredClone(ord),
          ...(allChecksPassed ? {} : { error: `Verification did not pass all checks (${failedChecks.join(', ')}). Order is ${nextStatus}.` }),
        };
      });
    },

    /**
     * Explicitly flag any order for Manual Review (e.g., ambiguous/duplicate/unrelated deposit).
     */
    async flagManualReview({ orderId, reason, operator }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanReason = sanitizeText(reason, 500, 'reason', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });

      return runExclusive(async () => {
        const data = await readRaw();
        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }
        if (ord.status === MANUAL_ORDER_STATES.FULFILLED) {
          return { ok: false, code: 'ORDER_ALREADY_FULFILLED', error: `Order ${cleanOrderId} is already Fulfilled.` };
        }

        const nowIso = new Date(nowFn()).toISOString();
        const prevStatus = ord.status;
        ord.status = MANUAL_ORDER_STATES.MANUAL_REVIEW;
        ord.ambiguityFlag = true;
        ord.manualReviewReason = cleanReason;
        ord.updatedAt = nowIso;
        ord.auditTrail.push({
          timestamp: nowIso,
          action: 'FLAGGED_MANUAL_REVIEW',
          fromStatus: prevStatus,
          toStatus: ord.status,
          operator: cleanOperator,
          reason: cleanReason,
        });

        await writeAtomic(data);
        return { ok: true, order: structuredClone(ord) };
      });
    },

    /**
     * Step 7: Begin manual fulfillment ONLY after Paid status and all 9 checks pass.
     */
    async startFulfillment({ orderId, operator, notes = '' }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });
      const cleanNotes = sanitizeText(notes, 500, 'notes');

      return runExclusive(async () => {
        const data = await readRaw();
        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }

        const gate = canStartFulfillment(ord, data);
        const nowIso = new Date(nowFn()).toISOString();
        if (!gate.allowed) {
          ord.auditTrail.push({
            timestamp: nowIso,
            action: 'FULFILLMENT_BLOCKED',
            fromStatus: ord.status,
            toStatus: ord.status,
            operator: cleanOperator,
            reasons: gate.reasons,
          });
          await writeAtomic(data);
          return {
            ok: false,
            code: 'FULFILLMENT_BLOCKED_UNVERIFIED',
            reasons: gate.reasons,
            order: structuredClone(ord),
            error: `Cannot start fulfillment for ${cleanOrderId}: ${gate.reasons.join('; ')}`,
          };
        }

        const prevStatus = ord.status;
        ord.status = MANUAL_ORDER_STATES.FULFILLMENT_IN_PROGRESS;
        ord.fulfillmentStartedAt = nowIso;
        ord.updatedAt = nowIso;
        ord.auditTrail.push({
          timestamp: nowIso,
          action: 'FULFILLMENT_STARTED',
          fromStatus: prevStatus,
          toStatus: ord.status,
          operator: cleanOperator,
          ...(cleanNotes ? { notes: cleanNotes } : {}),
        });

        await writeAtomic(data);
        return { ok: true, order: structuredClone(ord) };
      });
    },

    /**
     * Close an order as Fulfilled, Expired, Cancelled, or Failed.
     */
    async closeOrder({ orderId, status, reason, operator }) {
      const cleanOrderId = sanitizeText(orderId, 80, 'orderId', { required: true });
      const cleanStatus = sanitizeText(status, 60, 'status', { required: true });
      const cleanReason = sanitizeText(reason, 500, 'reason', { required: true });
      const cleanOperator = sanitizeText(operator, 100, 'operator', { required: true });

      if (!TERMINAL_CLOSED_STATES.includes(cleanStatus)) {
        return {
          ok: false,
          code: 'INVALID_CLOSE_STATUS',
          error: `Close status must be one of: ${TERMINAL_CLOSED_STATES.join(', ')}.`,
        };
      }

      return runExclusive(async () => {
        const data = await readRaw();
        const ord = data.orders[cleanOrderId];
        if (!ord) {
          return { ok: false, code: 'ORDER_NOT_FOUND', error: `Order ${cleanOrderId} not found.` };
        }

        const nowIso = new Date(nowFn()).toISOString();
        if (cleanStatus === MANUAL_ORDER_STATES.FULFILLED) {
          if (ord.status !== MANUAL_ORDER_STATES.FULFILLMENT_IN_PROGRESS) {
            return {
              ok: false,
              code: 'INVALID_STATE_FOR_FULFILLED',
              error: `Order ${cleanOrderId} must be in Fulfillment In Progress before marking Fulfilled (current: ${ord.status}).`,
            };
          }
          const verificationCheck = validateVerificationRecord(ord, data);
          if (!verificationCheck.valid) {
            return {
              ok: false,
              code: 'FULFILLMENT_BLOCKED_UNVERIFIED',
              reasons: verificationCheck.reasons,
              error: `Cannot mark ${cleanOrderId} Fulfilled: ${verificationCheck.reasons.join('; ')}`,
            };
          }
          ord.fulfilledAt = nowIso;
        } else if (
          [
            MANUAL_ORDER_STATES.PAID,
            MANUAL_ORDER_STATES.FULFILLMENT_IN_PROGRESS,
            MANUAL_ORDER_STATES.FULFILLED,
          ].includes(ord.status)
        ) {
          return {
            ok: false,
            code: 'CANNOT_CLOSE_PAID_ORDER_AS_UNPAID',
            error: `Paid/fulfilled order ${cleanOrderId} cannot be closed as ${cleanStatus}.`,
          };
        }

        const prevStatus = ord.status;
        ord.status = cleanStatus;
        ord.updatedAt = nowIso;
        ord.auditTrail.push({
          timestamp: nowIso,
          action: `ORDER_CLOSED_${cleanStatus.toUpperCase()}`,
          fromStatus: prevStatus,
          toStatus: cleanStatus,
          operator: cleanOperator,
          reason: cleanReason,
        });

        await writeAtomic(data);
        return { ok: true, order: structuredClone(ord) };
      });
    },
  };
}
