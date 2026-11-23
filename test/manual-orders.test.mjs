import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  CUSTOMER_TX_UNVERIFIED_LABEL,
  MANUAL_ORDER_STATES,
  PROJECT_ROOT,
  REQUIRED_VERIFICATION_CHECKS,
  canStartFulfillment,
  createManualOrderRegistry,
  validateRegistryPath,
} from '../cli/order-registry.mjs';
import {
  BSC_CHAIN_ID,
  PAYMENT_STATES,
  RECEIVING_WALLET,
  USDT_BEP20_CONTRACT,
} from '../cli/usdt-verifier.mjs';

const execFileAsync = promisify(execFile);

function makeTxHash(byteHex) {
  return `0x${String(byteHex).repeat(64).slice(0, 64)}`;
}

async function makeTempRegistryEnv(t) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vitalsscout-manual-test-'));
  const privateDir = path.join(baseDir, 'registry');
  const registryPath = path.join(privateDir, 'manual-orders.json');
  t.after(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });
  return { baseDir, privateDir, registryPath };
}

function makeMockOnChainVerifier(overrides = {}) {
  return async ({ txHash, serviceKey }) => {
    const expectedUsdt = serviceKey === 'audit' ? '20.86' : '48.86';
    const expectedBaseUnits =
      serviceKey === 'audit' ? '20860000000000000000' : '48860000000000000000';
    return {
      verified: true,
      onChainVerified: true,
      binanceDepositVerified: false,
      paid: false,
      requiresBinanceDepositCheck: true,
      paymentState: PAYMENT_STATES.ON_CHAIN_CONFIRMED,
      status: 'ON_CHAIN_CONFIRMED_AWAITING_BINANCE',
      txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
      checks: {
        chainId56: true,
        usdtTokenContract: true,
        depositRecipientAddress: true,
        exactRequiredNetAmount: true,
        receiptStatusSuccess: true,
        min15Confirmations: true,
      },
      txHash,
      serviceKey,
      chainId: BSC_CHAIN_ID,
      contract: USDT_BEP20_CONTRACT,
      recipient: RECEIVING_WALLET,
      blockNumber: 50_000_000,
      blockTimestamp: '2026-11-23T12:15:00.000Z',
      confirmations: 18,
      receivedBaseUnits: expectedBaseUnits,
      receivedUsdt: expectedUsdt,
      expectedUsdt,
      quorumVerified: true,
      quorumRpcs: ['https://rpc1.invalid/', 'https://rpc2.invalid/'],
      ...overrides,
    };
  };
}

function makeValidBinanceRecord(txHash, amount = '48.86', overrides = {}) {
  return {
    status: 'Completed',
    txId: txHash,
    coin: 'USDT',
    network: 'BSC',
    address: RECEIVING_WALLET,
    creditedAmountUsdt: amount,
    depositRef: `BIN-DEP-${txHash.slice(2, 10)}`,
    checkedAt: '2026-11-23T12:20:00.000Z',
    ...overrides,
  };
}

test('1. Order creation records authoritative Order ID without issuing deposit address or payment instructions', async (t) => {
  const { registryPath, privateDir } = await makeTempRegistryEnv(t);
  let nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const reg = createManualOrderRegistry(registryPath, { nowFn: () => nowMs });

  const order = await reg.createOrder({
    serviceKey: 'audit-fix',
    targetUrl: 'https://client-shop.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'client-founder',
    operator: 'Ahmed Mohamed',
    notes: '5 templates scoped',
  });

  assert.match(order.orderId, /^VS-20261123-[0-9A-F]{6}$/);
  assert.equal(order.orderIdAuthority, 'operator-local-registry');
  assert.equal(order.status, MANUAL_ORDER_STATES.ACCEPTED);
  assert.equal(order.requiredAmountUsdt, '48.86');
  assert.equal(order.autoFulfillment, false);
  assert.equal(order.paymentInstructionsIssued, false);
  assert.equal(order.paymentInstructionsIssuedAt, null);
  assert.equal(order.paymentTxHash, null);
  assert.equal(JSON.stringify(order).includes(RECEIVING_WALLET), false);

  const startAttempt = await reg.startFulfillment({ orderId: order.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(startAttempt.ok, false);
  assert.equal(startAttempt.code, 'FULFILLMENT_BLOCKED_UNVERIFIED');

  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
});

test('2. Single active payment window lock blocks simultaneous unresolved paid orders', async (t) => {
  const { registryPath } = await makeTempRegistryEnv(t);
  let nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const reg = createManualOrderRegistry(registryPath, { nowFn: () => nowMs });

  const ord1 = await reg.createOrder({
    serviceKey: 'audit',
    targetUrl: 'https://one.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'one',
    operator: 'Ahmed Mohamed',
  });
  const ord2 = await reg.createOrder({
    serviceKey: 'audit-fix',
    targetUrl: 'https://two.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'two',
    operator: 'Ahmed Mohamed',
  });

  const issued1 = await reg.issuePaymentInstructions({ orderId: ord1.orderId, operator: 'Ahmed Mohamed', ttlMinutes: 60 });
  assert.equal(issued1.ok, true);
  assert.equal(issued1.order.status, MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED);
  assert.ok(issued1.paymentInstructionsText.includes(RECEIVING_WALLET));
  assert.ok(issued1.paymentInstructionsText.includes('20.86 USDT'));
  assert.ok(issued1.paymentInstructionsText.includes('vitalsscout@proton.me'));
  assert.ok(issued1.paymentInstructionsText.includes('sending wallet address (or exchange withdrawal confirmation)'));

  // Issuing for ord2 must be blocked while ord1 is in Payment Instructions Issued
  const blockedWhileIssued = await reg.issuePaymentInstructions({ orderId: ord2.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(blockedWhileIssued.ok, false);
  assert.equal(blockedWhileIssued.code, 'ACTIVE_PAYMENT_WINDOW_LOCKED');
  assert.deepEqual(blockedWhileIssued.blockingOrderIds, [ord1.orderId]);

  // Submitting unverified txHash keeps ord1 unresolved -> ord2 still blocked
  const tx1 = makeTxHash('a');
  const rec1 = await reg.recordCustomerTxHash({
    orderId: ord1.orderId,
    txHash: tx1,
    channel: 'linkedin-dm',
    operator: 'Ahmed Mohamed',
  });
  assert.equal(rec1.ok, true);
  assert.equal(rec1.label, CUSTOMER_TX_UNVERIFIED_LABEL);
  assert.equal(rec1.order.txSubmissionLabel, CUSTOMER_TX_UNVERIFIED_LABEL);
  assert.equal(rec1.order.status, MANUAL_ORDER_STATES.TX_SUBMITTED_UNVERIFIED);

  const blockedWhileSubmitted = await reg.issuePaymentInstructions({ orderId: ord2.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(blockedWhileSubmitted.ok, false);
  assert.equal(blockedWhileSubmitted.code, 'ACTIVE_PAYMENT_WINDOW_LOCKED');

  // Flagging ord1 as Manual Review also keeps the window locked
  await reg.flagManualReview({ orderId: ord1.orderId, reason: 'Check deposit', operator: 'Ahmed Mohamed' });
  const blockedWhileReview = await reg.issuePaymentInstructions({ orderId: ord2.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(blockedWhileReview.ok, false);
  assert.equal(blockedWhileReview.code, 'ACTIVE_PAYMENT_WINDOW_LOCKED');

  // Once ord1 is resolved/closed (e.g. Expired), ord2 may open its payment window
  await reg.closeOrder({
    orderId: ord1.orderId,
    status: MANUAL_ORDER_STATES.EXPIRED,
    reason: 'No verified payment received',
    operator: 'Ahmed Mohamed',
  });
  const issued2 = await reg.issuePaymentInstructions({ orderId: ord2.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(issued2.ok, true);
  assert.equal(issued2.order.status, MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED);
});

test('3. Failure of any single verification check prevents Paid and blocks startFulfillment', async (t) => {
  const scenarios = [
    {
      name: 'Wrong Chain ID (not 56)',
      expectedFailedCheck: 'chainId56',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'WRONG_NETWORK',
        paymentState: PAYMENT_STATES.FAILED,
        chainId: 1,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Wrong USDT contract or recipient (NO_MATCHING_USDT_TRANSFER)',
      expectedFailedCheck: 'usdtTokenContract',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'NO_MATCHING_USDT_TRANSFER',
        paymentState: PAYMENT_STATES.FAILED,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Wrong recipient reported on verified object',
      expectedFailedCheck: 'depositRecipientAddress',
      onChain: {
        recipient: '0x9999999999999999999999999999999999999999',
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Underpayment (exact net amount failed)',
      expectedFailedCheck: 'exactRequiredNetAmount',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'INSUFFICIENT_AMOUNT',
        paymentState: PAYMENT_STATES.FAILED,
        receivedBaseUnits: '20850000000000000000',
        receivedUsdt: '20.85',
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.85'),
    },
    {
      name: 'Overpayment (exact net amount failed -> Manual Review)',
      expectedFailedCheck: 'exactRequiredNetAmount',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'OVERPAID_AMOUNT',
        paymentState: PAYMENT_STATES.MANUAL_REVIEW,
        receivedBaseUnits: '21000000000000000000',
        receivedUsdt: '21.00',
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '21.00'),
    },
    {
      name: 'Reverted transaction receipt',
      expectedFailedCheck: 'receiptStatusSuccess',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'TX_REVERTED',
        paymentState: PAYMENT_STATES.FAILED,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Fewer than 15 block confirmations',
      expectedFailedCheck: 'min15Confirmations',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'PENDING_CONFIRMATIONS',
        paymentState: PAYMENT_STATES.PENDING,
        confirmations: 14,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Binance Deposit History not Completed/Credited',
      expectedFailedCheck: 'binanceDepositHistoryCompleted',
      onChain: {},
      binance: (tx) => makeValidBinanceRecord(tx, '20.86', { status: 'Pending' }),
    },
    {
      name: 'Binance Deposit History missing completely',
      expectedFailedCheck: 'binanceDepositHistoryCompleted',
      onChain: {},
      binance: () => null,
    },
    {
      name: 'Inconsistency between on-chain tx and Binance txId',
      expectedFailedCheck: 'onChainAndBinanceConsistent',
      onChain: {},
      binance: () => makeValidBinanceRecord(makeTxHash('9'), '20.86'),
    },
    {
      name: 'Inconsistency between on-chain amount and Binance credited amount',
      expectedFailedCheck: 'onChainAndBinanceConsistent',
      onChain: {},
      binance: (tx) => makeValidBinanceRecord(tx, '20.50'),
    },
    {
      name: 'RPC consensus mismatch -> Manual Review',
      expectedFailedCheck: 'min15Confirmations',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'RPC_CONSENSUS_MISMATCH',
        paymentState: PAYMENT_STATES.MANUAL_REVIEW,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Pre-order transaction replay rejected',
      expectedFailedCheck: 'onChainAndBinanceConsistent',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'TX_PRE_ORDER',
        paymentState: PAYMENT_STATES.FAILED,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
    {
      name: 'Expired payment window rejected -> Manual Review',
      expectedFailedCheck: 'onChainAndBinanceConsistent',
      onChain: {
        verified: false,
        onChainVerified: false,
        status: 'PAYMENT_EXPIRED',
        paymentState: PAYMENT_STATES.EXPIRED,
        confirmations: 20,
      },
      binance: (tx) => makeValidBinanceRecord(tx, '20.86'),
    },
  ];

  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    const { registryPath } = await makeTempRegistryEnv(t);
    const reg = createManualOrderRegistry(registryPath);
    const ord = await reg.createOrder({
      serviceKey: 'audit',
      targetUrl: `https://case-${i}.example.com`,
      contactChannel: 'linkedin-dm',
      contactHandle: `case-${i}`,
      operator: 'Ahmed Mohamed',
    });
    await reg.issuePaymentInstructions({ orderId: ord.orderId, operator: 'Ahmed Mohamed' });
    const txHash = makeTxHash(((i + 1) % 15).toString(16));
    await reg.recordCustomerTxHash({
      orderId: ord.orderId,
      txHash,
      channel: 'linkedin-dm',
      operator: 'Ahmed Mohamed',
    });

    const verifyRes = await reg.verifyManualPayment({
      orderId: ord.orderId,
      txHash,
      binanceRecord: sc.binance(txHash),
      operator: 'Ahmed Mohamed',
      verifyOnChainImpl: makeMockOnChainVerifier(sc.onChain),
    });

    assert.equal(verifyRes.ok, false, `${sc.name}: verifyManualPayment must fail`);
    assert.notEqual(verifyRes.order.status, MANUAL_ORDER_STATES.PAID, `${sc.name}: must NEVER mark Paid`);
    assert.equal(
      verifyRes.checks[sc.expectedFailedCheck],
      false,
      `${sc.name}: expected check "${sc.expectedFailedCheck}" to fail, got ${JSON.stringify(verifyRes.checks)}`,
    );

    const fulfillRes = await reg.startFulfillment({ orderId: ord.orderId, operator: 'Ahmed Mohamed' });
    assert.equal(fulfillRes.ok, false, `${sc.name}: startFulfillment must be blocked`);
    assert.equal(fulfillRes.code, 'FULFILLMENT_BLOCKED_UNVERIFIED');
  }
});

test('4. Transaction hash replay across orders and conflicting txHash on same order are rejected', async (t) => {
  const { registryPath } = await makeTempRegistryEnv(t);
  const reg = createManualOrderRegistry(registryPath);

  const ord1 = await reg.createOrder({
    serviceKey: 'audit-fix',
    targetUrl: 'https://first.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'first',
    operator: 'Ahmed Mohamed',
  });
  await reg.issuePaymentInstructions({ orderId: ord1.orderId, operator: 'Ahmed Mohamed' });

  const sharedTx = makeTxHash('d');
  await reg.recordCustomerTxHash({
    orderId: ord1.orderId,
    txHash: sharedTx,
    channel: 'linkedin-dm',
    operator: 'Ahmed Mohamed',
  });

  // Conflicting second txHash submitted on same order -> Manual Review
  const conflictingTx = makeTxHash('e');
  const conflictRes = await reg.recordCustomerTxHash({
    orderId: ord1.orderId,
    txHash: conflictingTx,
    channel: 'linkedin-dm',
    operator: 'Ahmed Mohamed',
  });
  assert.equal(conflictRes.ok, false);
  assert.equal(conflictRes.code, 'CONFLICTING_TX_HASH');
  assert.equal(conflictRes.order.status, MANUAL_ORDER_STATES.MANUAL_REVIEW);

  // Ambiguity blocks Paid even with matching Binance record until explicitly cleared
  const blockedByAmbiguity = await reg.verifyManualPayment({
    orderId: ord1.orderId,
    txHash: sharedTx,
    binanceRecord: makeValidBinanceRecord(sharedTx, '48.86'),
    operator: 'Ahmed Mohamed',
    verifyOnChainImpl: makeMockOnChainVerifier(),
  });
  assert.equal(blockedByAmbiguity.ok, false);
  assert.equal(blockedByAmbiguity.order.status, MANUAL_ORDER_STATES.MANUAL_REVIEW);

  // Explicitly clear manual review reason -> all 9 checks pass -> Paid -> startFulfillment -> Fulfilled
  const paidRes = await reg.verifyManualPayment({
    orderId: ord1.orderId,
    txHash: sharedTx,
    binanceRecord: makeValidBinanceRecord(sharedTx, '48.86'),
    operator: 'Ahmed Mohamed',
    clearManualReviewReason: 'Customer confirmed typo in earlier message; verified correct txHash on Binance web UI.',
    verifyOnChainImpl: makeMockOnChainVerifier(),
  });
  assert.equal(paidRes.ok, true);
  assert.equal(paidRes.order.status, MANUAL_ORDER_STATES.PAID);
  assert.equal(paidRes.failedChecks.length, 0);
  for (const key of REQUIRED_VERIFICATION_CHECKS) {
    assert.equal(paidRes.order.verification.checks[key], true);
  }

  // Attempting to reuse sharedTx on a second order must be rejected
  const ord2 = await reg.createOrder({
    serviceKey: 'audit-fix',
    targetUrl: 'https://second.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'second',
    operator: 'Ahmed Mohamed',
  });
  await reg.issuePaymentInstructions({ orderId: ord2.orderId, operator: 'Ahmed Mohamed' });

  const replayRecordTx = await reg.recordCustomerTxHash({
    orderId: ord2.orderId,
    txHash: sharedTx,
    channel: 'linkedin-dm',
    operator: 'Ahmed Mohamed',
  });
  assert.equal(replayRecordTx.ok, false);
  assert.equal(replayRecordTx.code, 'TX_HASH_ALREADY_CLAIMED');

  const replayVerify = await reg.verifyManualPayment({
    orderId: ord2.orderId,
    txHash: sharedTx,
    binanceRecord: makeValidBinanceRecord(sharedTx, '48.86'),
    operator: 'Ahmed Mohamed',
    verifyOnChainImpl: makeMockOnChainVerifier(),
  });
  assert.equal(replayVerify.ok, false);
  assert.equal(replayVerify.code, 'TX_HASH_ALREADY_CLAIMED');

  // Fulfill ord1 cleanly
  const startRes = await reg.startFulfillment({ orderId: ord1.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.order.status, MANUAL_ORDER_STATES.FULFILLMENT_IN_PROGRESS);
  assert.equal(startRes.order.autoFulfillment, false);

  const closeRes = await reg.closeOrder({
    orderId: ord1.orderId,
    status: MANUAL_ORDER_STATES.FULFILLED,
    reason: 'Delivered PR and re-audit report privately.',
    operator: 'Ahmed Mohamed',
  });
  assert.equal(closeRes.ok, true);
  assert.equal(closeRes.order.status, MANUAL_ORDER_STATES.FULFILLED);
  assert.ok(closeRes.order.auditTrail.length >= 6);
});

test('5. Tampered Paid order missing any verification check is blocked by canStartFulfillment', async (t) => {
  const { registryPath } = await makeTempRegistryEnv(t);
  const reg = createManualOrderRegistry(registryPath);
  const ord = await reg.createOrder({
    serviceKey: 'audit',
    targetUrl: 'https://tamper.example.com',
    contactChannel: 'linkedin-dm',
    contactHandle: 'tamper',
    operator: 'Ahmed Mohamed',
  });
  await reg.issuePaymentInstructions({ orderId: ord.orderId, operator: 'Ahmed Mohamed' });
  const tx = makeTxHash('7');
  await reg.verifyManualPayment({
    orderId: ord.orderId,
    txHash: tx,
    binanceRecord: makeValidBinanceRecord(tx, '20.86'),
    operator: 'Ahmed Mohamed',
    verifyOnChainImpl: makeMockOnChainVerifier(),
  });

  // Tamper stored order in registry JSON so one check is false
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  raw.orders[ord.orderId].verification.checks.binanceDepositHistoryCompleted = false;
  fs.writeFileSync(registryPath, JSON.stringify(raw, null, 2), { mode: 0o600 });

  const tamperedOrder = await reg.getOrder(ord.orderId);
  const snap = await reg.readSnapshot();
  const gate = canStartFulfillment(tamperedOrder, snap);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes('FAILED_CHECK_binanceDepositHistoryCompleted'));

  const startRes = await reg.startFulfillment({ orderId: ord.orderId, operator: 'Ahmed Mohamed' });
  assert.equal(startRes.ok, false);
  assert.equal(startRes.code, 'FULFILLMENT_BLOCKED_UNVERIFIED');
});

test('6. Path safety rejects docs/, non-.json, and symlinks; CLI commands execute end-to-end', async (t) => {
  const { baseDir, registryPath } = await makeTempRegistryEnv(t);

  assert.throws(
    () => validateRegistryPath(path.join(PROJECT_ROOT, 'docs', 'orders.json'), PROJECT_ROOT),
    /docs\//,
  );
  assert.throws(
    () => validateRegistryPath(path.join(baseDir, 'orders.txt'), PROJECT_ROOT),
    /\.json/,
  );

  const realOutside = path.join(baseDir, 'real.json');
  const symlinkPath = path.join(baseDir, 'sym-orders.json');
  fs.writeFileSync(realOutside, '{}', 'utf8');
  fs.symlinkSync(realOutside, symlinkPath);
  assert.throws(() => validateRegistryPath(symlinkPath, PROJECT_ROOT), /symlink/);

  // CLI flow: create-order -> issue-payment-instructions -> record-tx -> list -> show
  const createOut = await execFileAsync(
    'node',
    [
      './cli/manual-orders.mjs',
      'create-order',
      '--registry',
      registryPath,
      '--service',
      'audit',
      '--url',
      'https://cli-test.example.com',
      '--channel',
      'linkedin-dm',
      '--contact',
      'cli-user',
      '--operator',
      'Ahmed Mohamed',
    ],
    { cwd: PROJECT_ROOT },
  );
  const created = JSON.parse(createOut.stdout);
  assert.equal(created.ok, true);
  assert.equal(created.order.status, MANUAL_ORDER_STATES.ACCEPTED);

  const issueOut = await execFileAsync(
    'node',
    [
      './cli/manual-orders.mjs',
      'issue-payment-instructions',
      '--registry',
      registryPath,
      '--order-id',
      created.order.orderId,
      '--operator',
      'Ahmed Mohamed',
    ],
    { cwd: PROJECT_ROOT },
  );
  const issued = JSON.parse(issueOut.stdout);
  assert.equal(issued.ok, true);
  assert.equal(issued.order.status, MANUAL_ORDER_STATES.PAYMENT_INSTRUCTIONS_ISSUED);

  const txCli = makeTxHash('8');
  const recOut = await execFileAsync(
    'node',
    [
      './cli/manual-orders.mjs',
      'record-tx',
      '--registry',
      registryPath,
      '--order-id',
      created.order.orderId,
      '--tx-hash',
      txCli,
      '--channel',
      'linkedin-dm',
      '--operator',
      'Ahmed Mohamed',
    ],
    { cwd: PROJECT_ROOT },
  );
  const recJson = JSON.parse(recOut.stdout);
  assert.equal(recJson.ok, true);
  assert.equal(recJson.order.txSubmissionLabel, CUSTOMER_TX_UNVERIFIED_LABEL);

  const listOut = await execFileAsync(
    'node',
    ['./cli/manual-orders.mjs', 'list', '--registry', registryPath],
    { cwd: PROJECT_ROOT },
  );
  const listJson = JSON.parse(listOut.stdout);
  assert.equal(listJson.activePaymentWindowCount, 1);
  assert.deepEqual(listJson.activePaymentWindowOrderIds, [created.order.orderId]);

  // start-fulfillment via CLI must fail non-zero while unverified
  await assert.rejects(
    () =>
      execFileAsync(
        'node',
        [
          './cli/manual-orders.mjs',
          'start-fulfillment',
          '--registry',
          registryPath,
          '--order-id',
          created.order.orderId,
          '--operator',
          'Ahmed Mohamed',
        ],
        { cwd: PROJECT_ROOT },
      ),
  );
});
