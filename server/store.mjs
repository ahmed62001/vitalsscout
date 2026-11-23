import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BASE_UNITS_PER_TENTH_MILLI_USDT,
  DEFAULT_INVOICE_TTL_SECONDS,
  MAX_CONCURRENT_DISCOUNT_STEPS,
  NETWORK_DISPLAY_NAME,
  NETWORK_NAME,
  PAYMENT_ASSET,
  RECEIVING_DEPOSIT_ADDRESS,
  SERVICES,
  USDT_BEP20_CONTRACT,
} from './config.mjs';
import { formatBaseUnits } from './binance-client.mjs';
import { ORDER_STATES, SLOT_RESERVING_STATES } from './order-states.mjs';

const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 15;
const RECENT_EXPIRED_COLLISION_GUARD_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultState() {
  return {
    version: 1,
    lastScannedBlock: null,
    orders: {},
    claimedTxHashes: {},
    claimedBinanceDeposits: {},
  };
}

function normalizeStoreData(parsed) {
  const base = defaultState();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return base;
  }
  return {
    version: Number(parsed.version || 1),
    lastScannedBlock:
      Number.isSafeInteger(parsed.lastScannedBlock) && parsed.lastScannedBlock >= 0
        ? parsed.lastScannedBlock
        : null,
    orders:
      parsed.orders && typeof parsed.orders === 'object' && !Array.isArray(parsed.orders)
        ? parsed.orders
        : {},
    claimedTxHashes:
      parsed.claimedTxHashes &&
      typeof parsed.claimedTxHashes === 'object' &&
      !Array.isArray(parsed.claimedTxHashes)
        ? parsed.claimedTxHashes
        : {},
    claimedBinanceDeposits:
      parsed.claimedBinanceDeposits &&
      typeof parsed.claimedBinanceDeposits === 'object' &&
      !Array.isArray(parsed.claimedBinanceDeposits)
        ? parsed.claimedBinanceDeposits
        : {},
  };
}

function generateOrderId(ordersMap, nowMs) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  for (let i = 0; i < 16; i += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const candidate = `VS-${y}${m}${day}-${suffix}`;
    if (!ordersMap[candidate]) {
      return candidate;
    }
  }
  throw new Error('Failed to generate unique Order ID.');
}

function generatePaymentReference(ordersMap) {
  const existingRefs = new Set(
    Object.values(ordersMap).map((o) => String(o?.paymentReference || '')),
  );
  for (let i = 0; i < 16; i += 1) {
    const candidate = `VS-PAY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    if (!existingRefs.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Failed to generate unique Payment Reference.');
}

function allocateUniqueAmountSlot(service, ordersMap, nowMs) {
  const reservedAmounts = new Set();
  for (const order of Object.values(ordersMap)) {
    if (!order || order.serviceId !== service.id) {
      continue;
    }
    const isExpiredAwaiting =
      order.state === ORDER_STATES.AWAITING_PAYMENT && nowMs > Number(order.expiresAtMs || 0);
    const recentlyExpired =
      (order.state === ORDER_STATES.EXPIRED || isExpiredAwaiting) &&
      Number(order.expiresAtMs || 0) + RECENT_EXPIRED_COLLISION_GUARD_MS > nowMs;
    const isReservingState = !isExpiredAwaiting && SLOT_RESERVING_STATES.has(order.state);
    if (isReservingState || recentlyExpired) {
      reservedAmounts.add(String(order.amountDueBaseUnits));
    }
  }

  for (let step = 0; step <= MAX_CONCURRENT_DISCOUNT_STEPS; step += 1) {
    const adjustment = BigInt(step) * BASE_UNITS_PER_TENTH_MILLI_USDT;
    const candidate = service.baseUnits - adjustment;
    const candidateStr = candidate.toString();
    if (!reservedAmounts.has(candidateStr)) {
      return {
        step,
        advertisedPriceBaseUnits: service.baseUnits.toString(),
        matchingAdjustmentBaseUnits: (-adjustment).toString(),
        amountDueBaseUnits: candidateStr,
        advertisedPriceUsdt: service.advertisedPriceUsdt,
        matchingAdjustmentUsdt: adjustment === 0n ? '0.00' : `-${formatBaseUnits(adjustment)}`,
        amountDueUsdt: formatBaseUnits(candidate),
      };
    }
  }

  const err = new Error(
    `Concurrent unpaid invoice slot limit reached for ${service.name}; cannot issue unique matching amount.`,
  );
  err.code = 'CONCURRENT_INVOICE_LIMIT';
  throw err;
}

/**
 * Atomic file-backed store with in-process mutex + cross-process exclusive lockfile.
 * Stores all USDT amounts in exact 18-decimal string base units and enforces global TXID / deposit uniqueness.
 * @param {string} filePath
 * @param {object} [options]
 */
export function createOrderStore(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const dirPath = path.dirname(resolvedPath);
  const nowFn = options.nowFn || (() => Date.now());
  let queue = Promise.resolve();

  async function acquireFileLock() {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + STALE_LOCK_MS;

    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          'utf8',
        );
        return handle;
      } catch (err) {
        if (err?.code !== 'EEXIST') {
          throw err;
        }
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for order store lock: ${lockPath}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  async function releaseFileLock(handle) {
    try {
      await handle?.close();
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async function readRaw() {
    try {
      const content = await fs.readFile(resolvedPath, 'utf8');
      return normalizeStoreData(JSON.parse(content));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return defaultState();
      }
      throw err;
    }
  }

  async function writeAtomic(data) {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    const tmpPath = `${resolvedPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, resolvedPath);
  }

  function runExclusive(task) {
    const run = queue.then(async () => {
      const lockHandle = await acquireFileLock();
      try {
        return await task();
      } finally {
        await releaseFileLock(lockHandle);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    getFilePath() {
      return resolvedPath;
    },

    async readSnapshot() {
      return runExclusive(() => readRaw());
    },

    async mutate(mutator) {
      return runExclusive(async () => {
        const data = await readRaw();
        const result = await mutator(data);
        await writeAtomic(data);
        return result;
      });
    },

    async getOrder(orderId) {
      const snap = await this.readSnapshot();
      return snap.orders[orderId] ? structuredClone(snap.orders[orderId]) : null;
    },

    async listOrders() {
      const snap = await this.readSnapshot();
      return Object.values(snap.orders).map((o) => structuredClone(o));
    },

    async createOrder(input) {
      const service = SERVICES[input?.serviceId];
      if (!service) {
        const err = new Error(`Unknown serviceId: ${String(input?.serviceId || '')}`);
        err.code = 'INVALID_SERVICE';
        throw err;
      }

      const targetUrl = String(input?.targetUrl || '').trim();
      const customerContact = String(input?.customerContact || '').trim();
      const notes = String(input?.notes || '').trim();
      const ttlSeconds = Number(input?.ttlSeconds || DEFAULT_INVOICE_TTL_SECONDS);

      if (!/^https?:\/\/[^\s]{3,}/i.test(targetUrl) || targetUrl.length > 500) {
        const err = new Error('A valid http(s) targetUrl is required.');
        err.code = 'INVALID_TARGET_URL';
        throw err;
      }
      if (!customerContact || customerContact.length > 200) {
        const err = new Error('customerContact is required (max 200 characters).');
        err.code = 'INVALID_CONTACT';
        throw err;
      }
      if (notes.length > 1000) {
        const err = new Error('notes must be 1000 characters or fewer.');
        err.code = 'INVALID_NOTES';
        throw err;
      }

      return this.mutate((data) => {
        const nowMs = nowFn();
        const orderId = generateOrderId(data.orders, nowMs);
        const paymentReference = generatePaymentReference(data.orders);
        const slot = allocateUniqueAmountSlot(service, data.orders, nowMs);
        const createdAtIso = new Date(nowMs).toISOString();
        const expiresAtMs = nowMs + ttlSeconds * 1000;

        const order = {
          orderId,
          paymentReference,
          serviceId: service.id,
          serviceName: service.name,
          asset: PAYMENT_ASSET,
          network: NETWORK_NAME,
          networkDisplayName: NETWORK_DISPLAY_NAME,
          usdtContract: USDT_BEP20_CONTRACT,
          receivingAddress: RECEIVING_DEPOSIT_ADDRESS,
          advertisedPriceUsdt: slot.advertisedPriceUsdt,
          advertisedPriceBaseUnits: slot.advertisedPriceBaseUnits,
          matchingAdjustmentUsdt: slot.matchingAdjustmentUsdt,
          matchingAdjustmentBaseUnits: slot.matchingAdjustmentBaseUnits,
          amountDueUsdt: slot.amountDueUsdt,
          amountDueBaseUnits: slot.amountDueBaseUnits,
          targetUrl,
          customerContact,
          notes,
          state: ORDER_STATES.AWAITING_PAYMENT,
          createdAt: createdAtIso,
          createdAtMs: nowMs,
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
          updatedAt: createdAtIso,
          txHash: null,
          binanceDepositId: null,
          confirmations: 0,
          receivedBaseUnits: null,
          receivedUsdt: null,
          blockchainVerified: false,
          binanceVerified: false,
          deliveryTriggered: false,
          deliveryTriggeredAt: null,
          statusReason: 'INVOICE_CREATED',
          manualReviewReason: null,
          history: [
            {
              timestamp: createdAtIso,
              fromState: null,
              toState: ORDER_STATES.AWAITING_PAYMENT,
              reason: 'INVOICE_CREATED',
            },
          ],
        };

        data.orders[orderId] = order;
        return structuredClone(order);
      });
    },
  };
}
