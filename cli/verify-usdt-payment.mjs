#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER_TX_UNVERIFIED_LABEL,
  DEFAULT_MAX_TX_AGE_SECONDS,
  PAYMENT_STATES,
  normalizeTxHash,
  verifyUsdtBep20Payment,
} from './usdt-verifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, '../docs');

function printHelp() {
  console.log(`VitalsScout USDT (BEP20) On-Chain Verifier (Operator Use Only)

NOTE: Passing this on-chain check does NOT mark an order Paid.
Every customer-submitted hash remains "${CUSTOMER_TX_UNVERIFIED_LABEL}"
until you verify uniqueness, confirm Completed/Credited status in Binance Deposit History,
and confirm consistency via "npm run orders -- verify-payment".

Usage:
  node ./cli/verify-usdt-payment.mjs <txHash> --service <audit|audit-fix> [options]

Options:
  --service <key>     Required: "audit" ($20.86) or "audit-fix" ($48.86)
  --record <path>     JSON array registry for replay protection (must end with .json, outside docs/)
  --order-id <id>     Optional unique order identifier bound to this payment
  --created-at <iso>  Optional ISO-8601 payment window creation timestamp
  --expires-at <iso>  Optional ISO-8601 payment window expiration timestamp
  --max-age <secs>    Max tx age in seconds (default: ${DEFAULT_MAX_TX_AGE_SECONDS})
  --allow-any-age     Disable max-age expiration check for manual delayed review
  -h, --help          Show this help message
`);
}

function isInsideDir(targetPath, parentDir) {
  const rel = path.relative(parentDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ensurePrivateParentDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const resolvedDir = path.resolve(dirPath);
  const sharedRoots = new Set([
    path.resolve('/'),
    path.resolve(os.tmpdir()),
    path.resolve(os.homedir()),
    path.resolve(__dirname, '..'),
  ]);
  if (!sharedRoots.has(resolvedDir)) {
    try {
      fs.chmodSync(resolvedDir, 0o700);
    } catch {
      // Ignore if directory is owned by another entity
    }
  }
}

export function validateRecordPath(rawPath) {
  const resolved = path.resolve(process.cwd(), rawPath);
  if (!resolved.toLowerCase().endsWith('.json')) {
    throw new Error('Registry path (--record) must end with .json');
  }
  const realDocs = fs.existsSync(DOCS_DIR) ? fs.realpathSync(DOCS_DIR) : DOCS_DIR;
  if (isInsideDir(resolved, DOCS_DIR) || isInsideDir(resolved, realDocs)) {
    throw new Error('Refusing to store payment records inside public docs/ directory.');
  }
  if (fs.existsSync(resolved)) {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error(`Registry path must be a regular non-symlink .json file: ${resolved}`);
    }
    const realResolved = fs.realpathSync(resolved);
    if (isInsideDir(realResolved, realDocs)) {
      throw new Error('Refusing symlink/target resolving inside public docs/ directory.');
    }
  }
  return resolved;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }

  let txHash = null;
  let serviceKey = null;
  let recordPath = null;
  let orderId = null;
  let orderCreatedAt = null;
  let orderExpiresAt = null;
  let maxAgeSeconds = DEFAULT_MAX_TX_AGE_SECONDS;
  let allowAnyAge = false;

  const takeValue = (flag, idx) => {
    const val = args[idx + 1];
    if (val === undefined || val === '') {
      throw new Error(`Missing value for ${flag}`);
    }
    return val;
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--service') {
      serviceKey = takeValue('--service', i);
      i += 1;
    } else if (token === '--record') {
      recordPath = validateRecordPath(takeValue('--record', i));
      i += 1;
    } else if (token === '--order-id') {
      orderId = takeValue('--order-id', i).trim();
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(orderId)) {
        throw new Error('Invalid --order-id (allowed: 1-80 chars of a-z, A-Z, 0-9, ., _, -)');
      }
      i += 1;
    } else if (token === '--created-at') {
      orderCreatedAt = takeValue('--created-at', i);
      i += 1;
    } else if (token === '--expires-at') {
      orderExpiresAt = takeValue('--expires-at', i);
      i += 1;
    } else if (token === '--max-age') {
      const parsed = Number.parseInt(takeValue('--max-age', i), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--max-age must be a positive integer (seconds)');
      }
      maxAgeSeconds = parsed;
      i += 1;
    } else if (token === '--allow-any-age') {
      allowAnyAge = true;
    } else if (!token.startsWith('-') && !txHash) {
      txHash = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }

  if (!txHash || !serviceKey) {
    throw new Error('Both <txHash> and --service <audit|audit-fix> are required.');
  }

  return {
    help: false,
    txHash,
    serviceKey,
    recordPath,
    orderId,
    orderCreatedAt,
    orderExpiresAt,
    maxAgeSeconds: allowAnyAge ? null : maxAgeSeconds,
  };
}

function readRegistry(recordPath) {
  if (!fs.existsSync(recordPath)) {
    return [];
  }
  const lst = fs.lstatSync(recordPath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error(`Refusing non-regular registry file: ${recordPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Registry file must contain a JSON array: ${recordPath}`);
  }
  return parsed;
}

function findDuplicateInRegistry(registry, txHash, orderId) {
  if (txHash && registry.some((e) => String(e?.txHash || '').toLowerCase() === txHash)) {
    return {
      verified: false,
      onChainVerified: false,
      binanceDepositVerified: false,
      paid: false,
      txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'DUPLICATE_TX_ALREADY_REDEEMED',
      txHash,
      message: `Transaction ${txHash} has already been recorded/redeemed.`,
    };
  }
  if (orderId && registry.some((e) => e?.orderId && String(e.orderId) === orderId)) {
    return {
      verified: false,
      onChainVerified: false,
      binanceDepositVerified: false,
      paid: false,
      txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'DUPLICATE_ORDER_ID',
      orderId,
      message: `Order ID "${orderId}" already has a recorded payment entry.`,
    };
  }
  return null;
}

/**
 * Execute fn while holding an exclusive atomic lockfile for recordPath.
 * Eliminates TOCTOU duplicate-claim races across concurrent processes.
 */
export async function withRegistryLock(recordPath, fn, timeoutMs = 5000) {
  ensurePrivateParentDir(path.dirname(recordPath));
  const lockPath = `${recordPath}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${recordPath}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore if already removed
    }
  }
}

export async function recordVerifiedTransactionAtomically(recordPath, entry) {
  const safePath = validateRecordPath(recordPath);
  return await withRegistryLock(safePath, async () => {
    const registry = readRegistry(safePath);
    const dupe = findDuplicateInRegistry(registry, normalizeTxHash(entry.txHash), entry.orderId || null);
    if (dupe) {
      return dupe;
    }
    const nextRegistry = [...registry, entry];
    const tmpPath = `${safePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(nextRegistry, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, safePath);
    fs.chmodSync(safePath, 0o600);
    return entry;
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(JSON.stringify({
      verified: false,
      onChainVerified: false,
      paid: false,
      txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INVALID_ARGS',
      message: err.message,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  const normalized = normalizeTxHash(opts.txHash);
  if (opts.recordPath && fs.existsSync(opts.recordPath)) {
    const initialRegistry = readRegistry(opts.recordPath);
    const preDupe = findDuplicateInRegistry(initialRegistry, normalized, opts.orderId);
    if (preDupe) {
      console.log(JSON.stringify(preDupe, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  const result = await verifyUsdtBep20Payment({
    txHash: opts.txHash,
    serviceKey: opts.serviceKey,
    orderCreatedAt: opts.orderCreatedAt,
    orderExpiresAt: opts.orderExpiresAt,
    maxAgeSeconds: opts.maxAgeSeconds,
  });

  let finalOutput = {
    ...result,
    paid: false,
    txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
  };
  if (result.verified) {
    finalOutput.nextStep =
      'On-chain BSC checks passed (>= 15 confirmations). Do NOT mark Paid yet: confirm Completed/Credited deposit consistency in Binance Deposit History and run "npm run orders -- verify-payment".';
  }

  if (result.verified && opts.recordPath) {
    const entry = {
      ...finalOutput,
      ...(opts.orderId ? { orderId: opts.orderId } : {}),
    };
    finalOutput = await recordVerifiedTransactionAtomically(opts.recordPath, entry);
  }

  console.log(JSON.stringify(finalOutput, null, 2));
  if (!finalOutput.verified) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    const msg = process.env.VITALSSCOUT_DEBUG === '1' ? (err?.stack || err?.message || String(err)) : (err?.message || 'Unexpected error');
    console.error(JSON.stringify({
      verified: false,
      onChainVerified: false,
      paid: false,
      txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'ERROR',
      message: msg,
    }, null, 2));
    process.exitCode = 1;
  });
}
