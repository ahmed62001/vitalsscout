import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_INVOICE_TTL_SECONDS,
  NETWORK_DISPLAY_NAME,
  NETWORK_NAME,
  PAYMENT_ASSET,
  RECEIVING_DEPOSIT_ADDRESS,
  SERVICES,
  USDT_BEP20_CONTRACT,
} from './config.mjs';
import { ORDER_STATES, SLOT_RESERVING_STATES } from './order-states.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.resolve(PROJECT_ROOT, 'docs');

const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(parentDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateStoreFilePath(rawFilePath) {
  const resolved = path.resolve(rawFilePath);
  const realDocs = fsSync.existsSync(DOCS_DIR) ? fsSync.realpathSync(DOCS_DIR) : DOCS_DIR;
  if (isInsideDir(resolved, DOCS_DIR) || isInsideDir(resolved, realDocs)) {
    throw new Error('Refusing to place order store inside public docs/ directory.');
  }
  for (const checkPath of [resolved, `${resolved}.lock`]) {
    if (fsSync.existsSync(checkPath)) {
      const lst = fsSync.lstatSync(checkPath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        throw new Error(`Refusing symlink or non-regular store file: ${checkPath}`);
      }
    }
  }
  return resolved;
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

function assertSingleActivePaymentWindow(ordersMap, nowMs) {
  const blocking = [];
  for (const order of Object.values(ordersMap)) {
    if (!order || !SLOT_RESERVING_STATES.has(order.state)) {
      continue;
    }
    const isExpiredAwaiting =
      order.state === ORDER_STATES.AWAITING_PAYMENT && nowMs > Number(order.expiresAtMs || 0);
    if (!isExpiredAwaiting) {
      blocking.push(order.orderId);
    }
  }
  if (blocking.length > 0) {
    const err = new Error(
      `Only one active unpaid order window is permitted on the shared deposit address (blocked by: ${blocking.join(', ')}).`,
    );
    err.code = 'ACTIVE_PAYMENT_WINDOW_LOCKED';
    err.blockingOrderIds = blocking;
    throw err;
  }
}

/**
 * Atomic file-backed store with in-process mutex + cross-process exclusive lockfile.
 * Enforces single active payment window, exact prices (no sub-cent discounts), and restrictive permissions.
 * @param {string} filePath
 * @param {object} [options]
 */
export function createOrderStore(filePath, options = {}) {
  const resolvedPath = validateStoreFilePath(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const dirPath = path.dirname(resolvedPath);
  const nowFn = options.nowFn || (() => Date.now());
  let queue = Promise.resolve();

  async function ensureDir() {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    const sharedRoots = new Set([
      path.resolve('/'),
      path.resolve(os.tmpdir()),
      path.resolve(os.homedir()),
      PROJECT_ROOT,
    ]);
    if (!sharedRoots.has(path.resolve(dirPath))) {
      await fs.chmod(dirPath, 0o700).catch(() => {});
    }
  }

  async function acquireFileLock() {
    validateStoreFilePath(resolvedPath);
    await ensureDir();
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
          const stat = await fs.lstat(lockPath);
          if (stat.isSymbolicLink()) {
            throw new Error(`Refusing symlink lockfile: ${lockPath}`);
          }
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch (statErr) {
          if (String(statErr?.message || '').includes('symlink')) throw statErr;
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
    validateStoreFilePath(resolvedPath);
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
    validateStoreFilePath(resolvedPath);
    await ensureDir();
    const tmpPath = `${resolvedPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, resolvedPath);
    await fs.chmod(resolvedPath, 0o600);
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
        assertSingleActivePaymentWindow(data.orders, nowMs);
        const orderId = generateOrderId(data.orders, nowMs);
        const paymentReference = generatePaymentReference(data.orders);
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
          advertisedPriceUsdt: service.advertisedPriceUsdt,
          advertisedPriceBaseUnits: service.baseUnits.toString(),
          matchingAdjustmentUsdt: '0.00',
          matchingAdjustmentBaseUnits: '0',
          amountDueUsdt: service.advertisedPriceUsdt,
          amountDueBaseUnits: service.baseUnits.toString(),
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
          statusReason: 'ORDER_CREATED',
          manualReviewReason: null,
          history: [
            {
              timestamp: createdAtIso,
              fromState: null,
              toState: ORDER_STATES.AWAITING_PAYMENT,
              reason: 'ORDER_CREATED',
            },
          ],
        };

        data.orders[orderId] = order;
        return structuredClone(order);
      });
    },
  };
}
