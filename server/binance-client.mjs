import crypto from 'node:crypto';
import {
  BINANCE_API_BASE_URL,
  DEFAULT_RECV_WINDOW_MS,
  NETWORK_DISPLAY_NAME,
  PAYMENT_ASSET,
  RECEIVING_DEPOSIT_ADDRESS,
  USDT_DECIMALS,
  redactSecrets,
} from './config.mjs';

export const BINANCE_DEPOSIT_STATUS = Object.freeze({
  PENDING: 0,
  SUCCESS: 1,
  CREDITED_LOCKED: 6,
  WRONG_DEPOSIT: 7,
  WAITING_USER_CONFIRM: 8,
});

/**
 * Parses a positive/zero decimal string (e.g. "48.86" or "20.8599") into exact BigInt base units.
 * Avoids floating-point rounding bugs.
 * @param {string|number} rawAmount
 * @param {number} [decimals]
 */
export function parseDecimalToBaseUnits(rawAmount, decimals = USDT_DECIMALS) {
  const str = String(rawAmount ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    throw new Error(`Invalid decimal amount: "${str}"`);
  }
  const whole = BigInt(match[1]);
  const fracRaw = match[2] || '';
  if (fracRaw.length > decimals) {
    throw new Error(`Amount "${str}" exceeds ${decimals} decimal places.`);
  }
  const fracPadded = fracRaw.padEnd(decimals, '0');
  const scale = 10n ** BigInt(decimals);
  return whole * scale + BigInt(fracPadded || '0');
}

/**
 * Formats base units into a human-readable USDT decimal string with at least 2 decimal places.
 * @param {bigint|string|number} baseUnits
 * @param {number} [decimals]
 */
export function formatBaseUnits(baseUnits, decimals = USDT_DECIMALS) {
  const value = typeof baseUnits === 'bigint' ? baseUnits : BigInt(String(baseUnits));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracTrimmed = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const fracFinal = fracTrimmed.length >= 2 ? fracTrimmed : fracTrimmed.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${fracFinal}`;
}

/**
 * Computes Binance SAPI query string + HMAC-SHA256 hex signature using URLSearchParams.
 * Only for read-only SAPI wallet inspection calls.
 * @param {Record<string, string|number|undefined>} params
 * @param {string} apiSecret
 */
export function signBinanceQuery(params, apiSecret) {
  if (!apiSecret) {
    throw new Error('BINANCE_API_SECRET is required to sign Binance API queries.');
  }
  const searchParams = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      searchParams.set(key, String(val));
    }
  }
  const queryString = searchParams.toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  return {
    queryString,
    signature,
    signedQuery: `${queryString}&signature=${signature}`,
  };
}

function normalizeDepositRecord(record, decimals = USDT_DECIMALS) {
  const rawTx = String(record?.txId ?? '').trim();
  const normalizedTxHash = /^0x[0-9a-f]{64}$/i.test(rawTx)
    ? rawTx.toLowerCase()
    : /^[0-9a-f]{64}$/i.test(rawTx)
      ? `0x${rawTx.toLowerCase()}`
      : rawTx.toLowerCase();

  let amountBaseUnits = 0n;
  let amountValid = false;
  try {
    amountBaseUnits = parseDecimalToBaseUnits(record?.amount, decimals);
    amountValid = amountBaseUnits > 0n;
  } catch {
    amountValid = false;
  }

  return {
    depositId: String(record?.id ?? `${normalizedTxHash}:${record?.insertTime ?? ''}`).trim(),
    amountStr: String(record?.amount ?? ''),
    amountBaseUnits,
    amountValid,
    coin: String(record?.coin ?? '').trim().toUpperCase(),
    network: String(record?.network ?? '').trim().toUpperCase(),
    address: String(record?.address ?? '').trim().toLowerCase(),
    addressTag: String(record?.addressTag ?? '').trim(),
    txId: normalizedTxHash,
    status: Number(record?.status),
    transferType: record?.transferType === undefined ? 0 : Number(record.transferType),
    insertTime: Number(record?.insertTime || 0),
    completeTime: Number(record?.completeTime || 0),
    confirmTimes: String(record?.confirmTimes ?? ''),
    unlockConfirm: Number(record?.unlockConfirm || 0),
    travelRuleStatus: record?.travelRuleStatus === undefined ? 0 : Number(record.travelRuleStatus),
  };
}

/**
 * Creates a strictly read-only Binance Wallet SAPI client for USDT (BSC) deposit reconciliation.
 * Never touches trading, margin, futures, or withdrawal endpoints.
 * @param {object} [options]
 */
export function createBinanceClient(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const apiSecret = String(options.apiSecret || '').trim();
  const baseUrl = String(options.baseUrl || BINANCE_API_BASE_URL).replace(/\/+$/, '');
  const expectedAddress = String(options.receivingAddress || RECEIVING_DEPOSIT_ADDRESS).trim().toLowerCase();
  const recvWindowMs = Number(options.recvWindowMs || DEFAULT_RECV_WINDOW_MS);
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowFn = options.nowFn || (() => Date.now());
  const secrets = [apiKey, apiSecret].filter(Boolean);

  const enabled = Boolean(apiKey && apiSecret);

  async function signedGet(endpointPath, params = {}) {
    if (!enabled) {
      return {
        enabled: false,
        ok: false,
        reason: 'DISABLED_MISSING_CREDENTIALS',
        error: 'Binance read-only API is disabled because BINANCE_API_KEY and BINANCE_API_SECRET are not configured.',
      };
    }
    if (typeof fetchImpl !== 'function') {
      return {
        enabled: true,
        ok: false,
        reason: 'FETCH_UNAVAILABLE',
        error: 'No fetch implementation available.',
      };
    }

    const signed = signBinanceQuery(
      {
        ...params,
        recvWindow: recvWindowMs,
        timestamp: nowFn(),
      },
      apiSecret,
    );

    const url = `${baseUrl}${endpointPath}?${signed.signedQuery}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      const bodyText = await response.text();
      let payload;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        return {
          enabled: true,
          ok: false,
          reason: 'BINANCE_HTTP_ERROR',
          statusCode: response.status,
          error: redactSecrets(
            payload?.msg ? `Binance API error (${payload.code}): ${payload.msg}` : `HTTP ${response.status}`,
            secrets,
          ),
        };
      }

      return {
        enabled: true,
        ok: true,
        statusCode: response.status,
        data: payload,
      };
    } catch (error) {
      return {
        enabled: true,
        ok: false,
        reason: error?.name === 'AbortError' ? 'BINANCE_TIMEOUT' : 'BINANCE_NETWORK_ERROR',
        error: redactSecrets(error?.message || String(error), secrets),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isEnabled() {
      return enabled;
    },

    /**
     * Verifies via GET /sapi/v1/capital/deposit/address that the account's BSC USDT
     * deposit address matches the configured RECEIVING_DEPOSIT_ADDRESS.
     */
    async verifyDepositAddress() {
      const res = await signedGet('/sapi/v1/capital/deposit/address', {
        coin: PAYMENT_ASSET,
        network: NETWORK_DISPLAY_NAME,
      });
      if (!res.ok) {
        return res;
      }
      const returnedAddress = String(res.data?.address || '').trim().toLowerCase();
      const returnedCoin = String(res.data?.coin || '').trim().toUpperCase();
      if (!returnedAddress || returnedAddress !== expectedAddress || returnedCoin !== PAYMENT_ASSET) {
        return {
          enabled: true,
          ok: false,
          reason: 'DEPOSIT_ADDRESS_MISMATCH',
          returnedAddress,
          expectedAddress,
          error: `Binance returned deposit address "${returnedAddress}" (${returnedCoin}) instead of expected "${expectedAddress}" (${PAYMENT_ASSET}).`,
        };
      }
      return {
        enabled: true,
        ok: true,
        coin: returnedCoin,
        network: NETWORK_DISPLAY_NAME,
        address: returnedAddress,
        tag: String(res.data?.tag || ''),
      };
    },

    /**
     * Queries Binance read-only deposit history (GET /sapi/v1/capital/deposit/hisrec).
     * Filters strictly to USDT deposits on BSC when matching, while retaining all parsed items
     * so wrong-network or travel-rule holds can be surfaced accurately for diagnostics.
     * @param {object} [opts]
     */
    async fetchDeposits(opts = {}) {
      const params = {
        coin: PAYMENT_ASSET,
        includeSource: true,
        limit: Math.min(Math.max(Number(opts.limit || 200), 1), 1000),
      };
      if (opts.status !== undefined) {
        params.status = Number(opts.status);
      }
      if (opts.startTime !== undefined) {
        params.startTime = Number(opts.startTime);
      }
      if (opts.endTime !== undefined) {
        params.endTime = Number(opts.endTime);
      }

      const res = await signedGet('/sapi/v1/capital/deposit/hisrec', params);
      if (!res.ok) {
        return {
          ...res,
          deposits: [],
        };
      }

      if (!Array.isArray(res.data)) {
        return {
          enabled: true,
          ok: false,
          reason: 'BINANCE_INVALID_RESPONSE',
          error: 'Binance deposit history did not return a JSON array.',
          deposits: [],
        };
      }

      const deposits = res.data.map((entry) => normalizeDepositRecord(entry));
      return {
        enabled: true,
        ok: true,
        deposits,
      };
    },
  };
}
