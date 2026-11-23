import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBinanceClient } from './binance-client.mjs';
import { createBscClient } from './bsc-client.mjs';
import { loadRuntimeConfig, redactSecrets } from './config.mjs';
import { createOrderStore } from './store.mjs';
import { createPaymentVerificationEngine } from './verification-engine.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function isAdminAuthorized(req, config) {
  const configuredToken = String(config?.adminToken || '').trim();
  if (!configuredToken) {
    return { configured: false, authorized: false };
  }
  const authHeader = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return { configured: true, authorized: false };
  }
  return {
    configured: true,
    authorized: timingSafeEqualString(match[1].trim(), configuredToken),
  };
}

function applySecurityHeaders(req, res, config) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  const origin = String(req.headers.origin || '').trim().replace(/\/+$/, '');
  const allowedOrigins = Array.isArray(config?.allowedCorsOrigins) ? config.allowedCorsOrigins : [];
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

function sendJson(req, res, statusCode, payload, config, onFlushed = null) {
  applySecurityHeaders(req, res, config);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (statusCode === 413) {
    res.setHeader('Connection', 'close');
  }
  res.end(JSON.stringify(payload), onFlushed || undefined);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      req.pause();
      const err = new Error('Request body exceeds 16 KiB limit.');
      err.statusCode = 413;
      reject(err);
      return;
    }

    let bytes = 0;
    const chunks = [];
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        req.pause();
        const err = new Error('Request body exceeds 16 KiB limit.');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Request JSON body must be a plain object.');
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('Malformed JSON request body.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

function createIpRateLimiter({
  maxRequests = DEFAULT_RATE_LIMIT_MAX,
  windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  nowFn = () => Date.now(),
} = {}) {
  const buckets = new Map();

  return function checkLimit(ipKey) {
    const key = String(ipKey || 'unknown');
    const now = nowFn();
    let entry = buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count += 1;
    buckets.set(key, entry);

    if (buckets.size > 2000) {
      for (const [k, val] of buckets.entries()) {
        if (now >= val.resetAt) {
          buckets.delete(k);
        }
      }
    }

    return {
      allowed: entry.count <= maxRequests,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  };
}

function sanitizeCustomerOrderView(order) {
  return {
    orderId: order.orderId,
    paymentReference: order.paymentReference,
    serviceId: order.serviceId,
    serviceName: order.serviceName,
    asset: order.asset,
    network: order.network,
    networkDisplayName: order.networkDisplayName,
    usdtContract: order.usdtContract,
    advertisedPriceUsdt: order.advertisedPriceUsdt,
    amountDueUsdt: order.amountDueUsdt,
    state: order.state,
    statusReason: order.statusReason,
    txHash: order.txHash,
    confirmations: order.confirmations,
    receivedUsdt: order.receivedUsdt,
    blockchainVerified: Boolean(order.blockchainVerified),
    binanceVerified: Boolean(order.binanceVerified),
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    updatedAt: order.updatedAt,
  };
}

/**
 * Builds the Node HTTP request listener for VitalsScout order creation, status polling,
 * TXID submission, and authenticated admin reconciliation/manual review.
 */
export function createPaymentHttpHandler({
  engine,
  store,
  config,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  nowFn = () => Date.now(),
}) {
  const checkRateLimit = createIpRateLimiter({
    maxRequests: rateLimitMax,
    windowMs: rateLimitWindowMs,
    nowFn,
  });
  const secrets = Array.isArray(config?.secretValues) ? config.secretValues : [];

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const method = String(req.method || 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        applySecurityHeaders(req, res, config);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/health') {
        sendJson(
          req,
          res,
          200,
          {
            ok: true,
            service: 'vitalsscout-payment-api',
            paymentAsset: config.paymentAsset,
            network: config.network,
            networkDisplayName: config.networkDisplayName,
            binanceEnabled: Boolean(config.binanceEnabled),
            bscscanEnabled: Boolean(config.bscscanEnabled),
            autoFulfillmentEnabled: false,
            minConfirmations: config.minConfirmations,
          },
          config,
        );
        return;
      }

      const clientIp = req.socket?.remoteAddress || 'unknown';
      const limit = checkRateLimit(clientIp);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        sendJson(
          req,
          res,
          429,
          { ok: false, error: 'Too many requests; please wait before retrying.' },
          config,
        );
        return;
      }

      if (method === 'POST' && pathname === '/api/orders') {
        const adminAuth = isAdminAuthorized(req, config);
        if (!adminAuth.configured) {
          sendJson(
            req,
            res,
            503,
            { ok: false, error: 'Order creation requires VITALS_ADMIN_TOKEN; public self-serve order creation is disabled.' },
            config,
          );
          return;
        }
        if (!adminAuth.authorized) {
          sendJson(req, res, 401, { ok: false, error: 'Unauthorized: operator authentication required to create orders.' }, config);
          return;
        }
        const body = await readJsonBody(req);
        try {
          const order = await engine.createOrder({
            serviceId: body.serviceId,
            targetUrl: body.targetUrl,
            customerContact: body.customerContact,
            notes: body.notes,
          });
          sendJson(req, res, 201, { ok: true, order: sanitizeCustomerOrderView(order) }, config);
        } catch (err) {
          const status = err?.code === 'ACTIVE_PAYMENT_WINDOW_LOCKED' ? 409 : err?.code === 'CONCURRENT_INVOICE_LIMIT' ? 503 : 400;
          sendJson(
            req,
            res,
            status,
            { ok: false, code: err?.code || 'BAD_REQUEST', error: err.message },
            config,
          );
        }
        return;
      }

      const getOrderMatch = /^\/api\/orders\/([A-Za-z0-9_-]{3,40})$/.exec(pathname);
      if (method === 'GET' && getOrderMatch) {
        const orderId = getOrderMatch[1];
        const adminAuth = isAdminAuthorized(req, config);
        const refParam = String(url.searchParams.get('ref') || '').trim();
        const order = await engine.getOrder(orderId);

        if (adminAuth.authorized) {
          if (!order) {
            sendJson(req, res, 404, { ok: false, error: 'Order not found.' }, config);
            return;
          }
          sendJson(req, res, 200, { ok: true, order }, config);
          return;
        }

        if (!order || !timingSafeEqualString(refParam, String(order.paymentReference || ''))) {
          sendJson(
            req,
            res,
            403,
            { ok: false, error: 'Valid orderId and matching paymentReference (?ref=...) are required.' },
            config,
          );
          return;
        }

        sendJson(req, res, 200, { ok: true, order: sanitizeCustomerOrderView(order) }, config);
        return;
      }

      const submitTxMatch = /^\/api\/orders\/([A-Za-z0-9_-]{3,40})\/submit-tx$/.exec(pathname);
      if (method === 'POST' && submitTxMatch) {
        const orderId = submitTxMatch[1];
        const adminAuth = isAdminAuthorized(req, config);
        const body = await readJsonBody(req);
        const order = await store.getOrder(orderId);

        if (!adminAuth.authorized) {
          const refFromBody = String(body.paymentReference || '').trim();
          if (!order || !timingSafeEqualString(refFromBody, String(order.paymentReference || ''))) {
            sendJson(
              req,
              res,
              403,
              { ok: false, error: 'Valid orderId and matching paymentReference are required.' },
              config,
            );
            return;
          }
        } else if (!order) {
          sendJson(req, res, 404, { ok: false, error: 'Order not found.' }, config);
          return;
        }

        const result = await engine.verifyOrderByTxHash(orderId, body.txHash);
        const statusCode =
          result.reason === 'INVALID_TX_HASH'
            ? 400
            : result.rejected
              ? 409
              : result.retryable
                ? 503
                : 200;

        sendJson(
          req,
          res,
          statusCode,
          {
            ok: result.ok,
            idempotent: Boolean(result.idempotent),
            reason: result.reason || result.statusReason,
            error: result.error,
            order: result.order ? sanitizeCustomerOrderView(result.order) : undefined,
          },
          config,
        );
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/reconcile') {
        const adminAuth = isAdminAuthorized(req, config);
        if (!adminAuth.configured) {
          sendJson(
            req,
            res,
            503,
            { ok: false, error: 'Admin endpoints are disabled because VITALS_ADMIN_TOKEN is not configured.' },
            config,
          );
          return;
        }
        if (!adminAuth.authorized) {
          sendJson(req, res, 401, { ok: false, error: 'Unauthorized.' }, config);
          return;
        }
        const result = await engine.pollAndReconcile();
        sendJson(req, res, result.ok ? 200 : 503, result, config);
        return;
      }

      const resolveMatch = /^\/api\/admin\/orders\/([A-Za-z0-9_-]{3,40})\/resolve$/.exec(pathname);
      if (method === 'POST' && resolveMatch) {
        const adminAuth = isAdminAuthorized(req, config);
        if (!adminAuth.configured) {
          sendJson(
            req,
            res,
            503,
            { ok: false, error: 'Admin endpoints are disabled because VITALS_ADMIN_TOKEN is not configured.' },
            config,
          );
          return;
        }
        if (!adminAuth.authorized) {
          sendJson(req, res, 401, { ok: false, error: 'Unauthorized.' }, config);
          return;
        }
        const body = await readJsonBody(req);
        const result = await engine.resolveManualReview({
          orderId: resolveMatch[1],
          action: body.action,
          operatorNote: body.operatorNote,
          resolvedBy: body.resolvedBy || 'admin-api',
        });
        sendJson(req, res, result.ok ? 200 : 400, result, config);
        return;
      }

      sendJson(req, res, 404, { ok: false, error: 'Endpoint not found.' }, config);
    } catch (err) {
      const status = Number(err?.statusCode || 500);
      sendJson(
        req,
        res,
        status,
        {
          ok: false,
          error: status >= 500 ? 'Internal server error.' : redactSecrets(err?.message || 'Bad request.', secrets),
        },
        config,
        status === 413 ? () => req.destroy() : null,
      );
    }
  };
}

/**
 * Starts the HTTP API server with explicit runtime config and fail-closed safety guarantees.
 */
export function startPaymentServer(env = process.env) {
  const config = loadRuntimeConfig(env);
  const store = createOrderStore(config.storeFilePath);
  const binanceClient = createBinanceClient({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    baseUrl: config.binanceApiBaseUrl,
    receivingAddress: config.receivingAddress,
    recvWindowMs: config.recvWindowMs,
  });
  const bscClient = createBscClient({
    receivingAddress: config.receivingAddress,
    usdtContract: config.usdtContract,
    bscscanApiBaseUrl: config.bscscanApiBaseUrl,
    bscscanApiKey: config.bscscanApiKey,
    logScanRpcUrl: config.logScanRpcUrl,
    bscRpcUrls: config.bscRpcUrls,
  });
  const engine = createPaymentVerificationEngine({
    store,
    binanceClient,
    bscClient,
    config,
  });

  const handler = createPaymentHttpHandler({ engine, store, config });
  const server = http.createServer(handler);
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    console.log(
      `VitalsScout Payment API listening on http://${config.host}:${port} ` +
        `[binance=${config.binanceEnabled ? 'enabled' : 'disabled'}, autoFulfillment=${config.autoFulfillmentEnabled ? 'enabled' : 'disabled'}]`,
    );
  });
  return { server, engine, store, config };
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  startPaymentServer();
}
