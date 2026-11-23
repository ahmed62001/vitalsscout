import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const PAYMENT_ASSET = 'USDT';
export const NETWORK_NAME = 'BNB Smart Chain (BEP20)';
export const NETWORK_DISPLAY_NAME = 'BSC';
export const BSC_CHAIN_ID = 56;
export const BSC_CHAIN_ID_HEX = '0x38';

// Official Binance-Peg BSC-USD (USDT BEP20) contract on BNB Smart Chain (18 decimals).
export const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
export const USDT_DECIMALS = 18;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Locked custodial Binance BSC BEP20 deposit address provided by the business owner.
export const RECEIVING_DEPOSIT_ADDRESS = '0x3214fbd3d68c2ab7d6bc32963ed011cc541ee6f2';

export const DEFAULT_MIN_CONFIRMATIONS = 15;
export const DEFAULT_INVOICE_TTL_SECONDS = 1800; // 30 minutes
export const DEFAULT_RECV_WINDOW_MS = 5000;
export const DEFAULT_BLOCK_SCAN_LOOKBACK = 400; // ~20 minutes on ~0.75-3s BSC blocks, <= 2000 chunk cap
export const MAX_ETH_GET_LOGS_BLOCK_SPAN = 1500;
export const MIN_CLOCK_SKEW_TOLERANCE_MS = 120_000; // 2 minutes tolerance around invoice creation
export const MAX_CONCURRENT_DISCOUNT_STEPS = 99; // -0.0001 to -0.0099 USDT micro-discount slots
export const BASE_UNITS_PER_TENTH_MILLI_USDT = 10n ** 14n; // 0.0001 USDT in 18-decimal base units

export const BINANCE_API_BASE_URL = 'https://api.binance.com';
export const ETHERSCAN_V2_API_BASE_URL = 'https://api.etherscan.io/v2/api';

// PublicNode supports up to 2,000-block eth_getLogs free on BSC; other official seeds provide receipt quorum.
export const DEFAULT_LOG_SCAN_RPC = 'https://bsc-rpc.publicnode.com';
export const DEFAULT_BSC_RPCS = Object.freeze([
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
]);

export const DEFAULT_ALLOWED_CORS_ORIGINS = Object.freeze([
  'https://ahmed62001.github.io',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

export const SERVICES = Object.freeze({
  'diagnostic-audit': Object.freeze({
    id: 'diagnostic-audit',
    name: 'Website Diagnostic Audit',
    advertisedPriceUsd: '20.86',
    advertisedPriceUsdt: '20.86',
    baseUnits: 20_860_000_000_000_000_000n,
  }),
  'audit-and-fix': Object.freeze({
    id: 'audit-and-fix',
    name: 'Website Audit + Fix',
    advertisedPriceUsd: '48.86',
    advertisedPriceUsdt: '48.86',
    baseUnits: 48_860_000_000_000_000_000n,
  }),
});

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(num) && num > 0 ? num : fallback;
}

function parseOriginList(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    return [...DEFAULT_ALLOWED_CORS_ORIGINS];
  }
  return String(rawValue)
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
}

function parseRpcList(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    return [...DEFAULT_BSC_RPCS];
  }
  const parsed = String(rawValue)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^https:\/\//i.test(entry));
  return parsed.length > 0 ? parsed : [...DEFAULT_BSC_RPCS];
}

/**
 * Loads sanitized runtime configuration from environment variables.
 * Binance integration and automatic fulfillment fail closed (remain disabled)
 * unless read-only Binance credentials and explicit activation flags are present.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadRuntimeConfig(env = process.env) {
  const binanceApiKey = String(env.BINANCE_API_KEY || '').trim();
  const binanceApiSecret = String(env.BINANCE_API_SECRET || '').trim();
  const bscscanApiKey = String(env.BSCSCAN_API_KEY || env.ETHERSCAN_API_KEY || '').trim();
  const adminToken = String(env.VITALS_ADMIN_TOKEN || '').trim();

  const binanceEnabled = Boolean(binanceApiKey && binanceApiSecret);
  const bscscanEnabled = Boolean(bscscanApiKey);
  const requestedAutoFulfillment = isTruthyEnv(env.VITALS_AUTO_FULFILLMENT_ENABLED);
  const autoFulfillmentEnabled = Boolean(requestedAutoFulfillment && binanceEnabled);

  const receivingAddress = String(env.VITALS_RECEIVING_ADDRESS || RECEIVING_DEPOSIT_ADDRESS).trim().toLowerCase();
  if (receivingAddress !== RECEIVING_DEPOSIT_ADDRESS.toLowerCase()) {
    throw new Error(
      `Refusing non-matching receiving address override; expected locked Binance BSC deposit address ${RECEIVING_DEPOSIT_ADDRESS}.`,
    );
  }

  return {
    paymentAsset: PAYMENT_ASSET,
    network: NETWORK_NAME,
    networkDisplayName: NETWORK_DISPLAY_NAME,
    chainId: BSC_CHAIN_ID,
    chainIdHex: BSC_CHAIN_ID_HEX,
    usdtContract: USDT_BEP20_CONTRACT,
    receivingAddress: RECEIVING_DEPOSIT_ADDRESS,
    binanceApiBaseUrl: String(env.BINANCE_API_BASE_URL || BINANCE_API_BASE_URL).replace(/\/+$/, ''),
    binanceApiKey,
    binanceApiSecret,
    binanceEnabled,
    bscscanApiBaseUrl: String(env.BSCSCAN_V2_API_BASE_URL || ETHERSCAN_V2_API_BASE_URL).replace(/\/+$/, ''),
    bscscanApiKey,
    bscscanEnabled,
    logScanRpcUrl: String(env.VITALS_BSC_LOG_RPC || DEFAULT_LOG_SCAN_RPC).trim(),
    bscRpcUrls: parseRpcList(env.VITALS_BSC_RPCS),
    minConfirmations: parsePositiveInt(env.VITALS_MIN_CONFIRMATIONS, DEFAULT_MIN_CONFIRMATIONS),
    invoiceTtlSeconds: parsePositiveInt(env.VITALS_INVOICE_TTL_SECONDS, DEFAULT_INVOICE_TTL_SECONDS),
    recvWindowMs: parsePositiveInt(env.BINANCE_RECV_WINDOW_MS, DEFAULT_RECV_WINDOW_MS),
    autoFulfillmentEnabled,
    autoFulfillmentRequestedWithoutBinance: Boolean(requestedAutoFulfillment && !binanceEnabled),
    adminToken,
    host: String(env.VITALS_PAYMENT_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: parsePositiveInt(env.PORT || env.VITALS_PAYMENT_PORT, 8787),
    storeFilePath: path.resolve(
      String(
        env.VITALS_ORDER_STORE_PATH ||
          path.join(PROJECT_ROOT, '.local-state', 'payment-orders.json'),
      ),
    ),
    allowedCorsOrigins: parseOriginList(env.VITALS_CORS_ORIGINS),
    secretValues: [binanceApiKey, binanceApiSecret, bscscanApiKey, adminToken].filter(Boolean),
  };
}

/**
 * Scrubs runtime secrets (API keys, HMAC secrets, admin bearer tokens) from log/error strings.
 * @param {unknown} input
 * @param {string[]} [secrets]
 */
export function redactSecrets(input, secrets = []) {
  let text = String(input ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  text = text.replace(/(signature=)[0-9a-f]{32,}/gi, '$1[REDACTED]');
  return text;
}
