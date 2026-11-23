import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import {
  BSC_CHAIN_ID_HEX,
  PAYMENT_STATES,
  RECEIVING_WALLET,
  TRANSFER_TOPIC,
  USDT_BEP20_CONTRACT,
  verifyUsdtBep20Payment,
} from '../docs/assets/usdt-verifier.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const execFileAsync = promisify(execFile);

const SAMPLE_TX = '0x' + 'a1'.repeat(32);
const SAMPLE_SENDER = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const FAKE_CONTRACT = '0x9999999999999999999999999999999999999999';

function padAddress(addr) {
  return '0x' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
}

function encodeUint256(val) {
  return '0x' + val.toString(16).padStart(64, '0');
}

function makeMockFetch({
  chainId = BSC_CHAIN_ID_HEX,
  latestBlock = 1000,
  blockTimestampSec = Math.floor(Date.now() / 1000) - 120,
  receipt = null,
  tx = null,
}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    let result = null;
    if (body.method === 'eth_chainId') result = chainId;
    else if (body.method === 'eth_blockNumber') result = '0x' + latestBlock.toString(16);
    else if (body.method === 'eth_getTransactionReceipt') {
      result = receipt ? { transactionHash: SAMPLE_TX, ...receipt } : null;
    } else if (body.method === 'eth_getTransactionByHash') result = tx;
    else if (body.method === 'eth_getBlockByNumber') {
      result = { number: body.params?.[0] || '0x3e0', timestamp: '0x' + blockTimestampSec.toString(16) };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { jsonrpc: '2.0', id: body.id, result };
      },
    };
  };
}

function makeTransferLog({
  contract = USDT_BEP20_CONTRACT,
  from = SAMPLE_SENDER,
  to = RECEIVING_WALLET,
  amountBaseUnits,
  removed = false,
}) {
  return {
    address: contract,
    topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    data: encodeUint256(amountBaseUnits),
    removed,
  };
}

async function runTests() {
  const mockRpcs = ['https://mock-bsc-rpc-1.invalid/', 'https://mock-bsc-rpc-2.invalid/'];

  // 1. Invalid hash syntax
  const r1 = await verifyUsdtBep20Payment({ txHash: 'abc123', serviceKey: 'audit', rpcEndpoints: mockRpcs, fetchImpl: makeMockFetch({}) });
  assert.equal(r1.verified, false);
  assert.equal(r1.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r1.status, 'INVALID_TX_HASH');

  // 2. Unknown tx
  const r2 = await verifyUsdtBep20Payment({ txHash: SAMPLE_TX, serviceKey: 'audit', rpcEndpoints: mockRpcs, fetchImpl: makeMockFetch({ receipt: null, tx: null }) });
  assert.equal(r2.verified, false);
  assert.equal(r2.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r2.status, 'TX_NOT_FOUND');

  // 3. Pending mempool tx
  const r3 = await verifyUsdtBep20Payment({ txHash: SAMPLE_TX, serviceKey: 'audit', rpcEndpoints: mockRpcs, fetchImpl: makeMockFetch({ receipt: null, tx: { hash: SAMPLE_TX, blockNumber: null } }) });
  assert.equal(r3.verified, false);
  assert.equal(r3.paymentState, PAYMENT_STATES.PENDING);
  assert.equal(r3.status, 'PENDING_MEMPOOL');

  // 4. Reverted tx
  const r4 = await verifyUsdtBep20Payment({ txHash: SAMPLE_TX, serviceKey: 'audit', rpcEndpoints: mockRpcs, fetchImpl: makeMockFetch({ receipt: { status: '0x0', blockNumber: '0x3e0', logs: [] } }) });
  assert.equal(r4.verified, false);
  assert.equal(r4.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r4.status, 'TX_REVERTED');

  // 5. Spoofed fake token contract
  const r5 = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      receipt: { status: '0x1', blockNumber: '0x3e0', logs: [makeTransferLog({ contract: FAKE_CONTRACT, amountBaseUnits: 20860000000000000000n })] },
    }),
  });
  assert.equal(r5.verified, false);
  assert.equal(r5.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r5.status, 'NO_MATCHING_USDT_TRANSFER');

  // 6. Real USDT contract sent to wrong wallet
  const r6 = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      receipt: { status: '0x1', blockNumber: '0x3e0', logs: [makeTransferLog({ to: OTHER_WALLET, amountBaseUnits: 20860000000000000000n })] },
    }),
  });
  assert.equal(r6.verified, false);
  assert.equal(r6.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r6.status, 'NO_MATCHING_USDT_TRANSFER');

  // 7. Underpayment checks (20.85 < 20.86; 48.85 < 48.86)
  const r7a = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      latestBlock: 1000,
      receipt: { status: '0x1', blockNumber: '0x3e0', logs: [makeTransferLog({ amountBaseUnits: 20850000000000000000n })] },
    }),
  });
  assert.equal(r7a.verified, false);
  assert.equal(r7a.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r7a.status, 'INSUFFICIENT_AMOUNT');

  const r7b = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit-fix',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      latestBlock: 1000,
      receipt: { status: '0x1', blockNumber: '0x3e0', logs: [makeTransferLog({ amountBaseUnits: 48850000000000000000n })] },
    }),
  });
  assert.equal(r7b.verified, false);
  assert.equal(r7b.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r7b.status, 'INSUFFICIENT_AMOUNT');

  // 8. Insufficient confirmations (block 999 vs latest 1000 => 2 < 5)
  const r8 = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      latestBlock: 1000,
      receipt: { status: '0x1', blockNumber: '0x' + (999).toString(16), logs: [makeTransferLog({ amountBaseUnits: 20860000000000000000n })] },
    }),
  });
  assert.equal(r8.verified, false);
  assert.equal(r8.paymentState, PAYMENT_STATES.PENDING);
  assert.equal(r8.status, 'PENDING_CONFIRMATIONS');

  // 9. Exact valid payments with 2-RPC quorum ($20.86 audit & $48.86 audit-fix, >= 5 confirmations)
  const r9a = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      latestBlock: 1000,
      receipt: { status: '0x1', blockNumber: '0x' + (996).toString(16), logs: [makeTransferLog({ amountBaseUnits: 20860000000000000000n })] },
    }),
  });
  assert.equal(RECEIVING_WALLET, '0x3214fbd3d68c2ab7d6bc32963ed011cc541ee6f2');
  assert.equal(r9a.verified, true);
  assert.equal(r9a.paymentState, PAYMENT_STATES.CONFIRMED);
  assert.equal(r9a.status, 'CONFIRMED');
  assert.equal(r9a.networkDisplayName, 'BSC');
  assert.equal(r9a.recipient, '0x3214fbd3d68c2ab7d6bc32963ed011cc541ee6f2');
  assert.equal(r9a.quorumVerified, true);
  assert.equal(r9a.receivedUsdt, '20.86');
  assert.equal(r9a.confirmations, 5);

  const r9b = await verifyUsdtBep20Payment({
    txHash: SAMPLE_TX,
    serviceKey: 'audit-fix',
    rpcEndpoints: mockRpcs,
    fetchImpl: makeMockFetch({
      latestBlock: 1000,
      receipt: { status: '0x1', blockNumber: '0x' + (990).toString(16), logs: [makeTransferLog({ amountBaseUnits: 48860000000000000000n })] },
    }),
  });
  assert.equal(r9b.verified, true);
  assert.equal(r9b.paymentState, PAYMENT_STATES.CONFIRMED);
  assert.equal(r9b.status, 'CONFIRMED');
  assert.equal(r9b.receivedUsdt, '48.86');
  assert.equal(r9b.confirmations, 11);

  // 10. Replay protection via CLI --record against temp registry
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitalsscout-usdt-test-'));
  try {
    const regPath = path.join(tmpDir, 'txs.json');
    fs.writeFileSync(regPath, JSON.stringify([{ txHash: SAMPLE_TX.toLowerCase(), verified: true }], null, 2), 'utf8');
    let failedAsExpected = false;
    try {
      await execFileAsync('node', ['./cli/verify-usdt-payment.mjs', SAMPLE_TX, '--service', 'audit', '--record', regPath], {
        cwd: path.resolve('.'),
      });
    } catch (err) {
      failedAsExpected = true;
      assert.ok(err.stdout.includes('DUPLICATE_TX_ALREADY_REDEEMED'), `Expected duplicate warning, got: ${err.stdout}`);
      assert.ok(err.stdout.includes('"paymentState": "Failed"'), `Expected Failed paymentState, got: ${err.stdout}`);
    }
    assert.equal(failedAsExpected, true, 'Duplicate txHash must exit non-zero');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 11. Live BNB Smart Chain Mainnet RPC smoke check with zero hash
  const zeroHash = '0x' + '0'.repeat(64);
  const r11 = await verifyUsdtBep20Payment({ txHash: zeroHash, serviceKey: 'audit' });
  assert.equal(r11.verified, false);
  assert.equal(r11.paymentState, PAYMENT_STATES.FAILED);
  assert.equal(r11.status, 'TX_NOT_FOUND', `Expected TX_NOT_FOUND from live BSC RPC, got ${r11.status}: ${r11.message}`);

  // 12. Verify static QR SVG file exists, matches exact new Binance BSC address SVG, and < 15 KB
  const qrPath = path.resolve('./docs/assets/usdt-bep20-qr.svg');
  assert.ok(fs.existsSync(qrPath), 'Missing docs/assets/usdt-bep20-qr.svg');
  const qrSize = fs.statSync(qrPath).size;
  const qrSvg = fs.readFileSync(qrPath, 'utf8');
  assert.ok(qrSvg.includes('<svg') && qrSvg.includes('</svg>'), 'QR file must be valid SVG');
  assert.ok(qrSize > 200 && qrSize < 15360, `Unexpected QR SVG byte size: ${qrSize}`);
  const expectedQrSvg = await QRCode.toString(RECEIVING_WALLET, {
    type: 'svg',
    width: 200,
    margin: 2,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
  assert.equal(qrSvg, expectedQrSvg, 'Static QR SVG must encode the exact active Binance BSC deposit address');

  console.log('PASS: All 12 USDT (BEP20) verifier & live BNB Smart Chain RPC smoke tests succeeded.');
}

runTests().catch((err) => {
  console.error('USDT VERIFIER TEST FAILED:', err);
  process.exitCode = 1;
});
