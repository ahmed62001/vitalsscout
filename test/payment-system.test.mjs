import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BINANCE_DEPOSIT_STATUS,
  createBinanceClient,
  formatBaseUnits,
  parseDecimalToBaseUnits,
  signBinanceQuery,
} from '../server/binance-client.mjs';
import { createBscClient } from '../server/bsc-client.mjs';
import {
  BSC_CHAIN_ID_HEX,
  RECEIVING_DEPOSIT_ADDRESS,
  TRANSFER_TOPIC,
  USDT_BEP20_CONTRACT,
  loadRuntimeConfig,
  redactSecrets,
} from '../server/config.mjs';
import { ORDER_STATES } from '../server/order-states.mjs';
import { createOrderStore } from '../server/store.mjs';
import { createPaymentVerificationEngine } from '../server/verification-engine.mjs';
import { createPaymentHttpHandler } from '../server/api-server.mjs';

function makeHash(fillByte) {
  return `0x${String(fillByte).repeat(64).slice(0, 64)}`;
}

function padAddressTopic(address) {
  return `0x${'0'.repeat(24)}${address.toLowerCase().replace(/^0x/, '')}`;
}

function encodeUint256Hex(amountBaseUnits) {
  return `0x${BigInt(amountBaseUnits).toString(16).padStart(64, '0')}`;
}

async function createTempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitalsscout-pay-test-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    storePath: path.join(dir, 'orders.json'),
  };
}

function createHarness({
  storePath,
  clock = { nowMs: 1_800_000_000_000 },
  binanceApiKey = 'test_readonly_key_123456',
  binanceApiSecret = 'test_readonly_secret_abcdef',
  autoFulfillmentEnabled = false,
  onOrderPaid = null,
  bscState = {},
  binanceState = {},
  bscscanApiKey = '',
  fetchImpl = null,
}) {
  const state = {
    latestBlock: bscState.latestBlock ?? 50_000_100,
    rpcOverrides: bscState.rpcOverrides || {}, // rpcUrl -> overrides or 'DOWN'
    txs: bscState.txs || {}, // txHash -> { receipt, mempoolTx, block }
    logs: bscState.logs || [],
    binanceOk: binanceState.ok !== false,
    binanceReason: binanceState.reason || null,
    binanceDeposits: binanceState.deposits || [],
    binanceStatusCode: binanceState.statusCode || 200,
  };

  const rpcCallImpl = async (rpcUrl, method, params) => {
    const nodeOverride = state.rpcOverrides[rpcUrl];
    if (nodeOverride === 'DOWN') {
      throw new Error(`Simulated RPC outage on ${rpcUrl}`);
    }
    const chainId = nodeOverride?.chainId || BSC_CHAIN_ID_HEX;
    const latestBlock = nodeOverride?.latestBlock ?? state.latestBlock;

    if (method === 'eth_chainId') {
      return chainId;
    }
    if (method === 'eth_blockNumber') {
      return `0x${latestBlock.toString(16)}`;
    }
    if (method === 'eth_getTransactionReceipt') {
      const tx = nodeOverride?.txs?.[params[0]] ?? state.txs[params[0]];
      return tx?.receipt ?? null;
    }
    if (method === 'eth_getTransactionByHash') {
      const tx = nodeOverride?.txs?.[params[0]] ?? state.txs[params[0]];
      return tx?.mempoolTx ?? null;
    }
    if (method === 'eth_getBlockByNumber') {
      for (const txEntry of Object.values(state.txs)) {
        if (txEntry?.block && txEntry.block.number === params[0]) {
          return txEntry.block;
        }
      }
      return {
        number: params[0],
        hash: makeHash('b'),
        timestamp: `0x${Math.floor(clock.nowMs / 1000).toString(16)}`,
      };
    }
    if (method === 'eth_getLogs') {
      return state.logs;
    }
    throw new Error(`Unexpected RPC method in mock: ${method}`);
  };

  const mockBinanceFetch =
    fetchImpl ||
    (async (urlStr) => {
      if (urlStr.includes('/sapi/v1/capital/deposit/address')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              address: RECEIVING_DEPOSIT_ADDRESS,
              coin: 'USDT',
              tag: '',
            }),
        };
      }
      if (!state.binanceOk) {
        if (state.binanceReason === 'TIMEOUT') {
          const err = new Error('Simulated timeout');
          err.name = 'AbortError';
          throw err;
        }
        return {
          ok: false,
          status: state.binanceStatusCode,
          text: async () => JSON.stringify({ code: -1021, msg: 'Simulated Binance error' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(state.binanceDeposits),
      };
    });

  const store = createOrderStore(storePath, { nowFn: () => clock.nowMs });
  const binanceClient = createBinanceClient({
    apiKey: binanceApiKey,
    apiSecret: binanceApiSecret,
    fetchImpl: mockBinanceFetch,
    nowFn: () => clock.nowMs,
  });
  const bscClient = createBscClient({
    bscRpcUrls: ['https://rpc1.example.com', 'https://rpc2.example.com'],
    logScanRpcUrl: 'https://rpc1.example.com',
    bscscanApiKey,
    fetchImpl: fetchImpl || mockBinanceFetch,
    rpcCallImpl,
  });

  const config = loadRuntimeConfig({
    BINANCE_API_KEY: binanceApiKey,
    BINANCE_API_SECRET: binanceApiSecret,
    VITALS_AUTO_FULFILLMENT_ENABLED: autoFulfillmentEnabled ? 'true' : 'false',
    VITALS_ORDER_STORE_PATH: storePath,
    VITALS_ADMIN_TOKEN: 'admin-super-secret-token-value',
  });

  const engine = createPaymentVerificationEngine({
    store,
    binanceClient,
    bscClient,
    config,
    onOrderPaid,
    nowFn: () => clock.nowMs,
  });

  return { state, store, binanceClient, bscClient, config, engine, clock };
}

function buildUsdtTransferTx({
  txHash,
  amountBaseUnits,
  contract = USDT_BEP20_CONTRACT,
  to = RECEIVING_DEPOSIT_ADDRESS,
  from = '0x1111111111111111111111111111111111111111',
  blockNumber = 50_000_080,
  timestampMs = 1_800_000_010_000,
  status = '0x1',
  removed = false,
}) {
  const blockHex = `0x${blockNumber.toString(16)}`;
  const blockHash = makeHash('d');
  return {
    receipt: {
      transactionHash: txHash,
      blockNumber: blockHex,
      blockHash,
      status,
      logs: [
        {
          address: contract,
          removed,
          logIndex: '0x0',
          topics: [TRANSFER_TOPIC, padAddressTopic(from), padAddressTopic(to)],
          data: encodeUint256Hex(amountBaseUnits),
          blockNumber: blockHex,
          blockHash,
          transactionHash: txHash,
        },
      ],
    },
    mempoolTx: null,
    block: {
      number: blockHex,
      hash: blockHash,
      timestamp: `0x${Math.floor(timestampMs / 1000).toString(16)}`,
    },
  };
}

test('fail-closed defaults: Binance disabled without secrets and auto-fulfillment blocked even if flag set', () => {
  const unsetCfg = loadRuntimeConfig({});
  assert.equal(unsetCfg.binanceEnabled, false);
  assert.equal(unsetCfg.autoFulfillmentEnabled, false);

  const dangerousAttempt = loadRuntimeConfig({
    VITALS_AUTO_FULFILLMENT_ENABLED: 'true',
  });
  assert.equal(dangerousAttempt.binanceEnabled, false);
  assert.equal(dangerousAttempt.autoFulfillmentEnabled, false);
  assert.equal(dangerousAttempt.autoFulfillmentRequestedWithoutBinance, true);

  const client = createBinanceClient({});
  assert.equal(client.isEnabled(), false);

  const redacted = redactSecrets('err secret_abc and signature=0123456789abcdef0123456789abcdef', [
    'secret_abc',
  ]);
  assert.equal(redacted, 'err [REDACTED] and signature=[REDACTED]');
});

test('1. Valid exact USDT (BEP20) payment verified on BSC quorum + Binance deposit -> Paid', async (t) => {
  const { storePath } = await createTempEnv(t);
  const txHash = makeHash('a');
  let deliveredCount = 0;

  const { state, engine, binanceClient } = createHarness({
    storePath,
    autoFulfillmentEnabled: true,
    onOrderPaid: async () => {
      deliveredCount += 1;
    },
  });

  const addrCheck = await binanceClient.verifyDepositAddress();
  assert.equal(addrCheck.ok, true);
  assert.equal(addrCheck.address, RECEIVING_DEPOSIT_ADDRESS);

  const order = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://merchant-example.com',
    customerContact: 'owner@merchant-example.com',
  });
  assert.equal(order.state, ORDER_STATES.AWAITING_PAYMENT);
  assert.equal(order.advertisedPriceUsdt, '48.86');
  assert.equal(order.amountDueUsdt, '48.86');

  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    amountBaseUnits: parseDecimalToBaseUnits('48.86'),
    blockNumber: 50_000_080, // 21 confirmations against 50_000_100
    timestampMs: 1_800_000_030_000,
  });
  state.binanceDeposits.push({
    id: 'dep_001',
    amount: '48.86',
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_DEPOSIT_ADDRESS,
    txId: txHash,
    status: BINANCE_DEPOSIT_STATUS.SUCCESS,
    transferType: 0,
    insertTime: 1_800_000_035_000,
    travelRuleStatus: 0,
  });

  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, true);
  assert.equal(res.order.state, ORDER_STATES.PAID);
  assert.equal(res.order.blockchainVerified, true);
  assert.equal(res.order.binanceVerified, true);
  assert.equal(res.order.binanceDepositId, 'dep_001');
  assert.equal(deliveredCount, 1);

  // Re-verifying is strictly idempotent and does NOT re-trigger delivery.
  const second = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(deliveredCount, 1);
});

test('2. Wrong token contract (non-USDT spoof) rejected -> Failed', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://example.org',
    customerContact: 'alice@example.org',
  });
  const txHash = makeHash('2');
  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    contract: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // spoofed non-USDT contract
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });

  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, false);
  assert.equal(res.order.state, ORDER_STATES.FAILED);
  assert.equal(res.order.statusReason, 'WRONG_TOKEN_CONTRACT');
});

test('3. Wrong network (chainId != 0x38) rejected -> Failed', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://example.org',
    customerContact: 'alice@example.org',
  });
  state.rpcOverrides['https://rpc1.example.com'] = { chainId: '0x1' };
  state.rpcOverrides['https://rpc2.example.com'] = { chainId: '0x1' };

  const txHash = makeHash('3');
  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, false);
  assert.equal(res.order.state, ORDER_STATES.FAILED);
  assert.equal(res.order.statusReason, 'WRONG_NETWORK');
});

test('4. Wrong receiving address rejected -> Failed', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://example.org',
    customerContact: 'bob@example.org',
  });
  const txHash = makeHash('4');
  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    to: '0x9999999999999999999999999999999999999999', // unintended third-party recipient address
    amountBaseUnits: parseDecimalToBaseUnits('48.86'),
  });

  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, false);
  assert.equal(res.order.state, ORDER_STATES.FAILED);
  assert.equal(res.order.statusReason, 'WRONG_DESTINATION_ADDRESS');
});

test('5. Underpayment detected -> Underpaid (never Paid)', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://example.org',
    customerContact: 'bob@example.org',
  });
  const txHash = makeHash('5');
  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    amountBaseUnits: parseDecimalToBaseUnits('48.50'),
  });

  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, false);
  assert.equal(res.order.state, ORDER_STATES.UNDERPAID);
  assert.equal(res.order.receivedUsdt, '48.50');
  assert.equal(res.order.blockchainVerified, true);
  assert.equal(res.order.binanceVerified, false);
});

test('6. Overpayment detected -> Overpaid (routed safely, never auto-Paid)', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath, autoFulfillmentEnabled: true });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://example.org',
    customerContact: 'bob@example.org',
  });
  const txHash = makeHash('6');
  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    amountBaseUnits: parseDecimalToBaseUnits('25.00'),
  });

  const res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, false);
  assert.equal(res.order.state, ORDER_STATES.OVERPAID);
  assert.equal(res.order.receivedUsdt, '25.00');
  assert.equal(res.order.deliveryTriggered, false);
});

test('7. Expired invoice sweeps to Expired, and late payment routes to Manual Review (never Paid)', async (t) => {
  const { storePath } = await createTempEnv(t);
  const clock = { nowMs: 1_800_000_000_000 };
  const { state, engine } = createHarness({ storePath, clock });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://late.example.com',
    customerContact: 'late@example.com',
  });

  clock.nowMs += 31 * 60 * 1000; // advance past 30-minute TTL
  const expiredView = await engine.getOrder(order.orderId);
  assert.equal(expiredView.state, ORDER_STATES.EXPIRED);

  const lateTx = makeHash('7');
  state.txs[lateTx] = buildUsdtTransferTx({
    txHash: lateTx,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
    timestampMs: clock.nowMs - 5_000,
  });

  const lateRes = await engine.verifyOrderByTxHash(order.orderId, lateTx);
  assert.equal(lateRes.ok, false);
  assert.equal(lateRes.reason, 'LATE_PAYMENT_AFTER_EXPIRATION');
  assert.equal(lateRes.order.state, ORDER_STATES.MANUAL_REVIEW);
});

test('8. Full confirmation progression: Mempool -> Confirming -> Binance Pending/Credited -> Paid', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://progress.example.com',
    customerContact: 'user@progress.example.com',
  });
  const txHash = makeHash('8');

  // Mempool -> Payment Detected
  state.txs[txHash] = { receipt: null, mempoolTx: { hash: txHash, blockNumber: null } };
  let res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.order.state, ORDER_STATES.PAYMENT_DETECTED);

  // Mined with 3 confirmations -> Confirming
  state.latestBlock = 50_000_100;
  state.txs[txHash] = buildUsdtTransferTx({
    txHash,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
    blockNumber: 50_000_098,
  });
  res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.order.state, ORDER_STATES.CONFIRMING);
  assert.equal(res.order.confirmations, 3);

  // 20 confirmations reached, Binance deposit status=6 (Credited cannot withdraw) -> still Confirming
  state.latestBlock = 50_000_120;
  state.binanceDeposits.push({
    id: 'dep_progress',
    amount: '20.86',
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_DEPOSIT_ADDRESS,
    txId: txHash,
    status: BINANCE_DEPOSIT_STATUS.CREDITED_LOCKED,
    transferType: 0,
    insertTime: 1_800_000_020_000,
  });
  res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.order.state, ORDER_STATES.CONFIRMING);
  assert.equal(res.order.blockchainVerified, true);
  assert.equal(res.order.binanceVerified, false);

  // Binance transitions deposit status=1 -> Paid
  state.binanceDeposits[0].status = BINANCE_DEPOSIT_STATUS.SUCCESS;
  res = await engine.verifyOrderByTxHash(order.orderId, txHash);
  assert.equal(res.ok, true);
  assert.equal(res.order.state, ORDER_STATES.PAID);
  assert.equal(res.order.binanceVerified, true);
});

test('9. Fail-closed when Binance API is disabled, down, or has Travel Rule hold (never Paid)', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state: sDisabled, engine: engDisabled } = createHarness({
    storePath,
    binanceApiKey: '',
    binanceApiSecret: '',
    autoFulfillmentEnabled: true,
  });
  const ord1 = await engDisabled.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://nobinance.example.com',
    customerContact: 'a@example.com',
  });
  const tx1 = makeHash('9');
  sDisabled.txs[tx1] = buildUsdtTransferTx({
    txHash: tx1,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });
  const r1 = await engDisabled.verifyOrderByTxHash(ord1.orderId, tx1);
  assert.equal(r1.ok, false);
  assert.equal(r1.order.state, ORDER_STATES.MANUAL_REVIEW);
  assert.equal(r1.order.blockchainVerified, true);
  assert.equal(r1.order.binanceVerified, false);
  assert.equal(r1.order.deliveryTriggered, false);

  // Travel rule hold on another harness
  const { dir } = await createTempEnv(t);
  const { state: sHold, engine: engHold } = createHarness({
    storePath: path.join(dir, 'hold.json'),
  });
  const ord2 = await engHold.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://travelrule.example.com',
    customerContact: 'b@example.com',
  });
  const tx2 = makeHash('c');
  sHold.txs[tx2] = buildUsdtTransferTx({
    txHash: tx2,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });
  sHold.binanceDeposits.push({
    id: 'dep_hold',
    amount: '20.86',
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_DEPOSIT_ADDRESS,
    txId: tx2,
    status: BINANCE_DEPOSIT_STATUS.WAITING_USER_CONFIRM,
    travelRuleStatus: 1,
    transferType: 0,
  });
  const r2 = await engHold.verifyOrderByTxHash(ord2.orderId, tx2);
  assert.equal(r2.ok, false);
  assert.equal(r2.order.state, ORDER_STATES.MANUAL_REVIEW);
  assert.equal(r2.order.statusReason, 'BINANCE_TRAVEL_RULE_HOLD');

  // Binance API timeout fails closed (never Paid)
  const { state: sDown, engine: engDown } = createHarness({
    storePath: path.join(dir, 'timeout.json'),
    binanceState: { ok: false, reason: 'TIMEOUT' },
  });
  const ord3 = await engDown.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://timeout.example.com',
    customerContact: 'c@example.com',
  });
  const tx3 = makeHash('e');
  sDown.txs[tx3] = buildUsdtTransferTx({
    txHash: tx3,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });
  const r3 = await engDown.verifyOrderByTxHash(ord3.orderId, tx3);
  assert.equal(r3.ok, false);
  assert.notEqual(r3.order.state, ORDER_STATES.PAID);
});

test('10. Replay & concurrent race: duplicate TXID claim across two orders blocks second atomically', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine } = createHarness({ storePath });

  const ordA = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://first.example.com',
    customerContact: 'first@example.com',
  });
  const ordB = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://second.example.com',
    customerContact: 'second@example.com',
  });

  const sharedTx = makeHash('f');
  state.txs[sharedTx] = buildUsdtTransferTx({
    txHash: sharedTx,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });
  state.binanceDeposits.push({
    id: 'dep_shared',
    amount: '20.86',
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_DEPOSIT_ADDRESS,
    txId: sharedTx,
    status: BINANCE_DEPOSIT_STATUS.SUCCESS,
    transferType: 0,
  });

  // Sequential replay rejected
  const resA = await engine.verifyOrderByTxHash(ordA.orderId, sharedTx);
  assert.equal(resA.ok, true);
  assert.equal(resA.order.state, ORDER_STATES.PAID);

  const resB = await engine.verifyOrderByTxHash(ordB.orderId, sharedTx);
  assert.equal(resB.ok, false);
  assert.equal(resB.rejected, true);
  assert.equal(resB.reason, 'TX_HASH_ALREADY_CLAIMED');

  // Concurrent double-submit race on fresh orders
  const ordC = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://race1.example.com',
    customerContact: 'r1@example.com',
  });
  const ordD = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://race2.example.com',
    customerContact: 'r2@example.com',
  });
  const raceTx = makeHash('1');
  state.txs[raceTx] = buildUsdtTransferTx({
    txHash: raceTx,
    amountBaseUnits: parseDecimalToBaseUnits(ordC.amountDueUsdt),
  });
  state.binanceDeposits.push({
    id: 'dep_race',
    amount: ordC.amountDueUsdt,
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_DEPOSIT_ADDRESS,
    txId: raceTx,
    status: BINANCE_DEPOSIT_STATUS.SUCCESS,
    transferType: 0,
  });

  const [rC, rD] = await Promise.all([
    engine.verifyOrderByTxHash(ordC.orderId, raceTx),
    engine.verifyOrderByTxHash(ordD.orderId, raceTx),
  ]);
  const outcomes = [rC, rD];
  assert.equal(outcomes.filter((x) => x.ok === true).length, 1);
  assert.equal(outcomes.filter((x) => x.rejected === true && x.reason === 'TX_HASH_ALREADY_CLAIMED').length, 1);
});

test('11. Reverted TX, invalid TXID format, and pre-order historical TX replay rejected -> Failed', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, engine, clock } = createHarness({ storePath });
  const order = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://invalid.example.com',
    customerContact: 'inv@example.com',
  });

  const badFmt = await engine.verifyOrderByTxHash(order.orderId, '0x123');
  assert.equal(badFmt.ok, false);
  assert.equal(badFmt.reason, 'INVALID_TX_HASH');

  const revertedTx = makeHash('0');
  state.txs[revertedTx] = buildUsdtTransferTx({
    txHash: revertedTx,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
    status: '0x0',
  });
  const revRes = await engine.verifyOrderByTxHash(order.orderId, revertedTx);
  assert.equal(revRes.ok, false);
  assert.equal(revRes.order.state, ORDER_STATES.FAILED);
  assert.equal(revRes.order.statusReason, 'TX_REVERTED');

  // Pre-order timestamp replay rejected on new order
  const ord2 = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://oldtx.example.com',
    customerContact: 'old@example.com',
  });
  const oldTx = makeHash('9');
  state.txs[oldTx] = buildUsdtTransferTx({
    txHash: oldTx,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
    blockNumber: 50_000_070,
    timestampMs: clock.nowMs - 600_000, // 10 minutes prior to order creation
  });
  const oldRes = await engine.verifyOrderByTxHash(ord2.orderId, oldTx);
  assert.equal(oldRes.ok, false);
  assert.equal(oldRes.order.state, ORDER_STATES.FAILED);
  assert.equal(oldRes.order.statusReason, 'TX_BEFORE_ORDER_CREATED');
});

test('12. Unique sub-cent matching, Etherscan V2 free-plan fallback -> eth_getLogs auto-reconcile, RPC consensus guard', async (t) => {
  const { storePath } = await createTempEnv(t);

  // Mock fetch simulating Binance SAPI + Etherscan V2 free-plan ChainID 56 rejection
  const hybridFetch = async (urlStr) => {
    if (urlStr.includes('api.etherscan.io/v2/api')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: '0',
          message: 'NOTOK',
          result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.',
        }),
      };
    }
    if (urlStr.includes('/sapi/v1/capital/deposit/hisrec')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              id: 'dep_match_2',
              amount: '48.8599',
              coin: 'USDT',
              network: 'BSC',
              address: RECEIVING_DEPOSIT_ADDRESS,
              txId: makeHash('7'),
              status: BINANCE_DEPOSIT_STATUS.SUCCESS,
              transferType: 0,
              insertTime: 1_800_000_020_000,
            },
          ]),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    };
  };

  const { state, engine } = createHarness({
    storePath,
    bscscanApiKey: 'mock_free_etherscan_key',
    fetchImpl: hybridFetch,
  });

  const ord1 = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://buyer1.example.com',
    customerContact: 'b1@example.com',
  });
  const ord2 = await engine.createOrder({
    serviceId: 'audit-and-fix',
    targetUrl: 'https://buyer2.example.com',
    customerContact: 'b2@example.com',
  });

  // Advertised price stays transparently 48.86; concurrent second order gets transparent -0.0001 matching slot
  assert.equal(ord1.advertisedPriceUsdt, '48.86');
  assert.equal(ord1.amountDueUsdt, '48.86');
  assert.equal(ord2.advertisedPriceUsdt, '48.86');
  assert.equal(ord2.matchingAdjustmentUsdt, '-0.0001');
  assert.equal(ord2.amountDueUsdt, '48.8599');

  const txForOrd2 = makeHash('7');
  state.txs[txForOrd2] = buildUsdtTransferTx({
    txHash: txForOrd2,
    amountBaseUnits: parseDecimalToBaseUnits('48.8599'),
  });
  state.logs.push({
    address: USDT_BEP20_CONTRACT,
    removed: false,
    logIndex: '0x0',
    blockNumber: `0x${(50_000_080).toString(16)}`,
    blockHash: makeHash('d'),
    transactionHash: txForOrd2,
    topics: [
      TRANSFER_TOPIC,
      padAddressTopic('0x2222222222222222222222222222222222222222'),
      padAddressTopic(RECEIVING_DEPOSIT_ADDRESS),
    ],
    data: encodeUint256Hex(parseDecimalToBaseUnits('48.8599')),
  });

  const pollRes = await engine.pollAndReconcile();
  assert.equal(pollRes.ok, true);
  assert.equal(pollRes.bscscanStatus, 'ETHERSCAN_V2_FREE_PLAN_UNSUPPORTED');
  assert.equal(pollRes.scanSource, 'BSC_RPC_GET_LOGS');
  assert.equal(pollRes.matchedOrders.length, 1);
  assert.equal(pollRes.matchedOrders[0].orderId, ord2.orderId);
  assert.equal(pollRes.matchedOrders[0].state, ORDER_STATES.PAID);

  // Order 1 remains untouched in Awaiting Payment!
  const ord1After = await engine.getOrder(ord1.orderId);
  assert.equal(ord1After.state, ORDER_STATES.AWAITING_PAYMENT);

  // RPC quorum disagreement routes safely to Manual Review
  const ord3 = await engine.createOrder({
    serviceId: 'diagnostic-audit',
    targetUrl: 'https://consensus.example.com',
    customerContact: 'con@example.com',
  });
  const disagreeTx = makeHash('e');
  state.txs[disagreeTx] = buildUsdtTransferTx({
    txHash: disagreeTx,
    amountBaseUnits: parseDecimalToBaseUnits('20.86'),
  });
  state.rpcOverrides['https://rpc2.example.com'] = {
    txs: {
      [disagreeTx]: buildUsdtTransferTx({
        txHash: disagreeTx,
        amountBaseUnits: parseDecimalToBaseUnits('10.00'), // RPC2 disagrees!
      }),
    },
  };
  const consRes = await engine.verifyOrderByTxHash(ord3.orderId, disagreeTx);
  assert.equal(consRes.ok, false);
  assert.equal(consRes.order.state, ORDER_STATES.MANUAL_REVIEW);
  assert.equal(consRes.order.statusReason, 'RPC_CONSENSUS_MISMATCH');
});

test('13. Binance HMAC-SHA256 signature verification & Decimal/BaseUnit accuracy', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const signed = signBinanceQuery(
    {
      coin: 'USDT',
      recvWindow: 5000,
      timestamp: 1499827319559,
    },
    secret,
  );
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update('coin=USDT&recvWindow=5000&timestamp=1499827319559')
    .digest('hex');
  assert.equal(signed.signature, expectedHmac);
  assert.equal(formatBaseUnits(parseDecimalToBaseUnits('48.8599')), '48.8599');
  assert.equal(formatBaseUnits(parseDecimalToBaseUnits('20.86')), '20.86');
});

test('14. HTTP API server security: auth, IDOR block, body limit 413, rate limit 429, headers, manual resolution', async (t) => {
  const { storePath } = await createTempEnv(t);
  const { state, store, config, engine } = createHarness({ storePath });
  const handler = createPaymentHttpHandler({
    engine,
    store,
    config,
    rateLimitMax: 12,
    rateLimitWindowMs: 60_000,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Health check omits all secrets and sets strict security headers
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(healthRes.headers.get('referrer-policy'), 'no-referrer');
  const healthJson = await healthRes.json();
  assert.equal(healthJson.autoFulfillmentEnabled, false);
  assert.equal(JSON.stringify(healthJson).includes('test_readonly'), false);

  // Create order via HTTP API
  const createRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://ahmed62001.github.io',
    },
    body: JSON.stringify({
      serviceId: 'diagnostic-audit',
      targetUrl: 'https://api-test.example.com',
      customerContact: 'buyer@example.com',
    }),
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.headers.get('access-control-allow-origin'), 'https://ahmed62001.github.io');
  const { order } = await createRes.json();
  assert.ok(order.orderId.startsWith('VS-'));
  assert.ok(order.paymentReference.startsWith('VS-PAY-'));

  // IDOR test: GET order without ?ref=... or with wrong ref is denied (403)
  const idorRes = await fetch(`${baseUrl}/api/orders/${order.orderId}?ref=WRONG-REF`);
  assert.equal(idorRes.status, 403);

  // Correct ?ref=... succeeds
  const ownRes = await fetch(`${baseUrl}/api/orders/${order.orderId}?ref=${order.paymentReference}`);
  assert.equal(ownRes.status, 200);

  // Admin endpoints fail closed without valid bearer token (401)
  const unauthAdmin = await fetch(`${baseUrl}/api/admin/reconcile`, { method: 'POST' });
  assert.equal(unauthAdmin.status, 401);

  // Submit a reverted TX with valid ref -> moves to Failed, then test Underpaid -> Admin resolve
  const overOrderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceId: 'diagnostic-audit',
      targetUrl: 'https://overpay-api.example.com',
      customerContact: 'over@example.com',
    }),
  });
  const overOrder = (await overOrderRes.json()).order;
  const overTx = makeHash('7');
  state.txs[overTx] = buildUsdtTransferTx({
    txHash: overTx,
    amountBaseUnits: parseDecimalToBaseUnits('22.00'),
    blockNumber: 50_000_075,
  });
  const subOver = await fetch(`${baseUrl}/api/orders/${overOrder.orderId}/submit-tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentReference: overOrder.paymentReference, txHash: overTx }),
  });
  assert.equal(subOver.status, 200);
  const subOverJson = await subOver.json();
  assert.equal(subOverJson.order.state, ORDER_STATES.OVERPAID);

  // Admin resolve with valid Bearer token approves Overpaid -> Paid with audit note
  const resolveRes = await fetch(`${baseUrl}/api/admin/orders/${overOrder.orderId}/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer admin-super-secret-token-value',
    },
    body: JSON.stringify({
      action: 'APPROVE_PAID',
      operatorNote: 'Confirmed overpayment in Binance Deposit History; surplus refunded out-of-band.',
    }),
  });
  assert.equal(resolveRes.status, 200);
  const resolveJson = await resolveRes.json();
  assert.equal(resolveJson.order.state, ORDER_STATES.PAID);

  // Oversize body rejected with 413
  const oversized = 'A'.repeat(20_000);
  const bigRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceId: 'diagnostic-audit', targetUrl: `https://a.com/${oversized}`, customerContact: 'x' }),
  });
  assert.equal(bigRes.status, 413);

  // Rate limit triggers 429 cleanly
  let hit429 = false;
  for (let i = 0; i < 15; i += 1) {
    const r = await fetch(`${baseUrl}/api/orders/${order.orderId}?ref=${order.paymentReference}`);
    if (r.status === 429) {
      hit429 = true;
      break;
    }
  }
  assert.equal(hit429, true);
});

if (process.env.VITALS_LIVE_BSC_SMOKE === '1') {
  test('LIVE BSC RPC read-only eth_getLogs & head block smoke check (no funds, read-only)', async () => {
    const bsc = createBscClient();
    const head = await bsc.getLatestBlockNumber();
    assert.equal(head.ok, true);
    assert.ok(head.blockNumber > 40_000_000);

    const scan = await bsc.scanIncomingDeposits({
      fromBlock: head.blockNumber - 100,
      toBlock: head.blockNumber,
    });
    assert.equal(scan.ok, true);
    assert.equal(scan.source, 'BSC_RPC_GET_LOGS');
    assert.ok(Array.isArray(scan.transfers));
  });
}
