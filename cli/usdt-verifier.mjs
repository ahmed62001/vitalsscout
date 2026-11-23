export const BSC_CHAIN_ID_HEX = '0x38';
export const BSC_CHAIN_ID = 56;
export const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
export const USDT_DECIMALS = 18;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const RECEIVING_WALLET = '0x3214fbd3d68c2ab7d6bc32963ed011cc541ee6f2';
export const MIN_CONFIRMATIONS = 15;
export const DEFAULT_MAX_TX_AGE_SECONDS = 86400; // 24 hours
export const CUSTOMER_TX_UNVERIFIED_LABEL = 'Customer-submitted transaction hash — UNVERIFIED.';

export const PAYMENT_STATES = Object.freeze({
  PENDING: 'Pending',
  ON_CHAIN_CONFIRMED: 'On-Chain Confirmed (Awaiting Binance Deposit Check)',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  MANUAL_REVIEW: 'Manual Review',
});

export const DEFAULT_BSC_RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
];

export const USDT_SERVICES = {
  audit: {
    key: 'audit',
    name: 'Website Diagnostic Audit',
    expectedUsdt: '20.86',
    expectedBaseUnits: 20860000000000000000n,
  },
  'audit-fix': {
    key: 'audit-fix',
    name: 'Website Audit + Fix',
    expectedUsdt: '48.86',
    expectedBaseUnits: 48860000000000000000n,
  },
};

const BASE_UNIT_DIVISOR = 1000000000000000000n;
const PADDED_ADDRESS_RE = /^0x0{24}[0-9a-fA-F]{40}$/;
const HEX_UINT256_RE = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Format 18-decimal base units (BigInt) into a human-readable decimal string.
 * @param {bigint} value
 * @param {number} [precision=4]
 * @returns {string}
 */
export function formatBaseUnits(value, precision = 4) {
  const whole = value / BASE_UNIT_DIVISOR;
  const rem = value % BASE_UNIT_DIVISOR;
  const fracFull = rem.toString().padStart(USDT_DECIMALS, '0');
  const trimmed = fracFull.slice(0, precision).replace(/0+$/, '');
  const minTwo = fracFull.slice(0, 2);
  const shown = trimmed.length >= 2 ? trimmed : minTwo;
  return `${whole.toString()}.${shown}`;
}

/**
 * Validate and normalize an EVM transaction hash.
 * @param {string} rawHash
 * @returns {string|null}
 */
export function normalizeTxHash(rawHash) {
  const trimmed = String(rawHash ?? '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return `0x${trimmed.toLowerCase()}`;
  }
  return null;
}

/**
 * Check whether a string is a valid 32-byte EVM transaction hash.
 * @param {string} rawHash
 * @returns {boolean}
 */
export function isValidTxHash(rawHash) {
  return normalizeTxHash(rawHash) !== null;
}

/**
 * Enforce HTTPS-only public RPC endpoints (rejects http://, embedded credentials, and loopback/private literals).
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isAllowedRpcUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return false;
  }
  return true;
}

function parseTimestampMs(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : NaN;
  }
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function rpcRequest(endpoint, method, params, fetchImpl, timeoutMs = 10000) {
  if (!isAllowedRpcUrl(endpoint)) {
    throw new Error(`Disallowed RPC endpoint: ${endpoint}`);
  }
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      ...(ac ? { signal: ac.signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (!payload || typeof payload !== 'object' || payload.jsonrpc !== '2.0') {
      throw new Error('Malformed JSON-RPC 2.0 response envelope');
    }
    if (payload.error) {
      throw new Error(payload.error.message || 'JSON-RPC error');
    }
    if (!('result' in payload)) {
      throw new Error('JSON-RPC response missing result field');
    }
    return payload.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractUsdtTransfers(receipt) {
  const targetContract = USDT_BEP20_CONTRACT.toLowerCase();
  const targetWallet = RECEIVING_WALLET.toLowerCase();
  const senders = [];
  let receivedBaseUnits = 0n;
  let matchingLogs = 0;

  for (const log of receipt?.logs || []) {
    if (!log || typeof log !== 'object' || log.removed === true) continue;
    const addr = String(log.address || '').toLowerCase();
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (addr !== targetContract) continue;
    if (topics.length !== 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!PADDED_ADDRESS_RE.test(String(topics[1])) || !PADDED_ADDRESS_RE.test(String(topics[2]))) continue;

    const toAddr = `0x${String(topics[2]).slice(26).toLowerCase()}`;
    if (toAddr !== targetWallet) continue;

    const dataHex = String(log.data || '').trim();
    if (!HEX_UINT256_RE.test(dataHex)) continue;

    const amount = BigInt(dataHex);
    if (amount <= 0n) continue;

    const fromAddr = `0x${String(topics[1]).slice(26).toLowerCase()}`;
    if (!senders.includes(fromAddr)) {
      senders.push(fromAddr);
    }
    receivedBaseUnits += amount;
    matchingLogs += 1;
  }

  return { senders, receivedBaseUnits, matchingLogs };
}

async function querySingleRpc(endpoint, normalizedHash, fetchImpl) {
  const chainId = await rpcRequest(endpoint, 'eth_chainId', [], fetchImpl);
  if (String(chainId).toLowerCase() !== BSC_CHAIN_ID_HEX) {
    throw new Error(`Unexpected chainId ${chainId} (expected ${BSC_CHAIN_ID_HEX})`);
  }

  const [receipt, latestBlockHex] = await Promise.all([
    rpcRequest(endpoint, 'eth_getTransactionReceipt', [normalizedHash], fetchImpl),
    rpcRequest(endpoint, 'eth_blockNumber', [], fetchImpl),
  ]);

  let tx = null;
  let block = null;
  if (receipt === null) {
    tx = await rpcRequest(endpoint, 'eth_getTransactionByHash', [normalizedHash], fetchImpl);
  } else if (receipt.blockNumber) {
    block = await rpcRequest(endpoint, 'eth_getBlockByNumber', [receipt.blockNumber, false], fetchImpl);
    if (
      block &&
      block.hash &&
      receipt.blockHash &&
      String(block.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()
    ) {
      throw new Error('Block hash mismatch between transaction receipt and block header');
    }
  }

  return { endpoint, receipt, latestBlockHex, tx, block };
}

/**
 * Independently verify the on-chain BSC (BEP20) portion of a USDT payment.
 * NOTE: On-chain verification alone NEVER marks an order Paid. Operator must still
 * confirm uniqueness in the local replay registry and verify the matching deposit
 * in Binance Deposit History (Completed/Credited + on-chain consistency).
 *
 * @param {object} options
 * @param {string} options.txHash
 * @param {'audit'|'audit-fix'} options.serviceKey
 * @param {string[]} [options.rpcEndpoints]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.minConfirmations]
 * @param {string|number|null} [options.orderCreatedAt]
 * @param {string|number|null} [options.orderExpiresAt]
 * @param {number|null} [options.maxAgeSeconds]
 * @param {boolean} [options.requireQuorum]
 * @param {number} [options.nowMs]
 */
export async function verifyUsdtBep20Payment({
  txHash,
  serviceKey,
  rpcEndpoints = DEFAULT_BSC_RPCS,
  fetchImpl = globalThis.fetch,
  minConfirmations = MIN_CONFIRMATIONS,
  orderCreatedAt = null,
  orderExpiresAt = null,
  maxAgeSeconds = DEFAULT_MAX_TX_AGE_SECONDS,
  requireQuorum,
  nowMs = Date.now(),
}) {
  const baseFailMeta = {
    verified: false,
    onChainVerified: false,
    binanceDepositVerified: false,
    paid: false,
    requiresBinanceDepositCheck: true,
    txSubmissionLabel: CUSTOMER_TX_UNVERIFIED_LABEL,
  };

  const service = USDT_SERVICES[serviceKey];
  if (!service) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INVALID_SERVICE',
      message: `Unknown service "${serviceKey}". Expected "audit" ($20.86) or "audit-fix" ($48.86).`,
    };
  }

  const normalizedHash = normalizeTxHash(txHash);
  if (!normalizedHash) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INVALID_TX_HASH',
      message: 'Invalid transaction hash. Enter a 66-character 0x... BNB Smart Chain txHash.',
    };
  }

  if (!Array.isArray(rpcEndpoints) || rpcEndpoints.length === 0 || rpcEndpoints.some((u) => !isAllowedRpcUrl(u))) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INVALID_RPC_URL',
      txHash: normalizedHash,
      message: 'All configured BNB Smart Chain RPC endpoints must be public HTTPS URLs.',
    };
  }

  const createdMs = parseTimestampMs(orderCreatedAt);
  const expiresMs = parseTimestampMs(orderExpiresAt);
  if (Number.isNaN(createdMs) || Number.isNaN(expiresMs)) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INVALID_TIME_WINDOW',
      txHash: normalizedHash,
      message: 'Invalid orderCreatedAt or orderExpiresAt timestamp.',
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.PENDING,
      status: 'FETCH_UNAVAILABLE',
      txHash: normalizedHash,
      message: 'HTTP fetch API is unavailable in this runtime. Verify manually on BscScan and Binance Deposit History before marking Paid.',
    };
  }

  let primary = null;
  let primaryIdx = -1;
  const primaryErrors = [];
  for (let i = 0; i < rpcEndpoints.length; i += 1) {
    try {
      primary = await querySingleRpc(rpcEndpoints[i], normalizedHash, fetchImpl);
      primaryIdx = i;
      break;
    } catch (err) {
      primaryErrors.push(`${rpcEndpoints[i]}: ${err?.message || String(err)}`);
    }
  }

  const bscscanUrl = `https://bscscan.com/tx/${normalizedHash}`;

  if (!primary) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.PENDING,
      status: 'RPC_UNAVAILABLE',
      txHash: normalizedHash,
      bscscanUrl,
      message: `Automated BNB Smart Chain RPC verification is temporarily unavailable (${primaryErrors.join('; ')}). Check manually on BscScan and Binance Deposit History — do not mark Paid until all checks pass.`,
    };
  }

  const { endpoint, receipt, latestBlockHex, tx, block } = primary;

  if (receipt === null) {
    if (tx && tx.blockNumber === null) {
      return {
        ...baseFailMeta,
        paymentState: PAYMENT_STATES.PENDING,
        status: 'PENDING_MEMPOOL',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        message: 'Transaction is in the BNB Smart Chain mempool and not yet included in a block. Wait and re-verify.',
      };
    }
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'TX_NOT_FOUND',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: 'Transaction hash not found on BNB Smart Chain (BEP20). Confirm sender used BSC (Chain ID 56), not ERC20 or TRC20.',
    };
  }

  if (receipt.transactionHash && String(receipt.transactionHash).toLowerCase() !== normalizedHash) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'RECEIPT_HASH_MISMATCH',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: 'RPC node returned a mismatched transactionHash receipt. Verification rejected.',
    };
  }

  if (String(receipt.status).toLowerCase() !== '0x1') {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'TX_REVERTED',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: 'Transaction reverted on-chain (status 0x0). No USDT transfer succeeded.',
    };
  }

  const { senders, receivedBaseUnits, matchingLogs } = extractUsdtTransfers(receipt);
  if (matchingLogs === 0) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'NO_MATCHING_USDT_TRANSFER',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: `No official USDT (BEP20) Transfer event to ${RECEIVING_WALLET} found in this transaction (wrong token contract, wrong recipient, or wrong asset).`,
    };
  }

  const receivedUsdt = formatBaseUnits(receivedBaseUnits);
  const txBlock = Number.parseInt(receipt.blockNumber, 16);
  const latestBlock = Number.parseInt(latestBlockHex, 16);
  const confirmations = Number.isFinite(txBlock) && Number.isFinite(latestBlock) && latestBlock >= txBlock
    ? latestBlock - txBlock + 1
    : 0;

  if (receivedBaseUnits < service.expectedBaseUnits) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'INSUFFICIENT_AMOUNT',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      confirmations,
      receivedBaseUnits: receivedBaseUnits.toString(),
      receivedUsdt,
      expectedUsdt: service.expectedUsdt,
      message: `Insufficient amount: received ${receivedUsdt} USDT, expected exact ${service.expectedUsdt} USDT for ${service.name}.`,
    };
  }

  if (receivedBaseUnits > service.expectedBaseUnits) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.MANUAL_REVIEW,
      status: 'OVERPAID_AMOUNT',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      confirmations,
      receivedBaseUnits: receivedBaseUnits.toString(),
      receivedUsdt,
      expectedUsdt: service.expectedUsdt,
      message: `Amount mismatch (overpaid): received ${receivedUsdt} USDT instead of exact ${service.expectedUsdt} USDT for ${service.name}. Flagged for Manual Review.`,
    };
  }

  const blockTsSec = block?.timestamp ? Number.parseInt(block.timestamp, 16) : null;
  const blockTimestampMs = Number.isFinite(blockTsSec) ? blockTsSec * 1000 : null;
  const blockTimestampIso = blockTimestampMs !== null ? new Date(blockTimestampMs).toISOString() : null;

  if (blockTimestampMs === null && (createdMs !== null || expiresMs !== null || maxAgeSeconds !== null)) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.FAILED,
      status: 'BLOCK_TIMESTAMP_UNAVAILABLE',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      message: 'Unable to validate on-chain block timestamp. Verify manually on BscScan.',
    };
  }

  if (blockTimestampMs !== null) {
    if (createdMs !== null && blockTimestampMs < createdMs - 60000) {
      return {
        ...baseFailMeta,
        paymentState: PAYMENT_STATES.FAILED,
        status: 'TX_PRE_ORDER',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        blockNumber: txBlock,
        blockTimestamp: blockTimestampIso,
        message: 'Transaction occurred before payment instructions were issued (possible old transaction replay).',
      };
    }

    if (
      (expiresMs !== null && blockTimestampMs > expiresMs) ||
      (maxAgeSeconds !== null && nowMs - blockTimestampMs > maxAgeSeconds * 1000)
    ) {
      return {
        ...baseFailMeta,
        paymentState: PAYMENT_STATES.EXPIRED,
        status: 'PAYMENT_EXPIRED',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        blockNumber: txBlock,
        blockTimestamp: blockTimestampIso,
        confirmations,
        receivedBaseUnits: receivedBaseUnits.toString(),
        receivedUsdt,
        expectedUsdt: service.expectedUsdt,
        message: 'Payment window expired (transaction timestamp is outside the valid payment window). Route to Manual Review.',
      };
    }
  }

  if (confirmations < minConfirmations) {
    return {
      ...baseFailMeta,
      paymentState: PAYMENT_STATES.PENDING,
      status: 'PENDING_CONFIRMATIONS',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      blockTimestamp: blockTimestampIso,
      confirmations,
      minConfirmations,
      receivedBaseUnits: receivedBaseUnits.toString(),
      receivedUsdt,
      expectedUsdt: service.expectedUsdt,
      message: `Payment detected (${receivedUsdt} USDT) at block ${txBlock}, currently ${confirmations}/${minConfirmations} confirmations. Wait until at least ${minConfirmations} confirmations.`,
    };
  }

  const useQuorum = requireQuorum !== undefined ? Boolean(requireQuorum) : rpcEndpoints.length >= 2;
  const quorumRpcs = [endpoint];

  if (useQuorum) {
    const others = rpcEndpoints.filter((_, idx) => idx !== primaryIdx);
    let secondaryData = null;
    for (const secUrl of others) {
      try {
        secondaryData = await querySingleRpc(secUrl, normalizedHash, fetchImpl);
        break;
      } catch {
        // try next independent RPC endpoint
      }
    }

    if (!secondaryData) {
      return {
        ...baseFailMeta,
        paymentState: PAYMENT_STATES.PENDING,
        status: 'RPC_QUORUM_UNAVAILABLE',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        blockNumber: txBlock,
        blockTimestamp: blockTimestampIso,
        confirmations,
        receivedBaseUnits: receivedBaseUnits.toString(),
        receivedUsdt,
        expectedUsdt: service.expectedUsdt,
        message: 'Primary RPC saw the transfer, but a second independent BNB Smart Chain RPC node could not be reached to confirm quorum. Verify manually on BscScan.',
      };
    }

    const secReceipt = secondaryData.receipt;
    const secBlock = secReceipt?.blockNumber ? Number.parseInt(secReceipt.blockNumber, 16) : null;
    const secBlockHash = secReceipt?.blockHash ? String(secReceipt.blockHash).toLowerCase() : null;
    const priBlockHash = receipt?.blockHash ? String(receipt.blockHash).toLowerCase() : null;
    const secTransfers = secReceipt ? extractUsdtTransfers(secReceipt) : { receivedBaseUnits: 0n, matchingLogs: 0 };
    const secHashMismatch = secReceipt?.transactionHash && String(secReceipt.transactionHash).toLowerCase() !== normalizedHash;

    if (
      !secReceipt ||
      secHashMismatch ||
      String(secReceipt.status).toLowerCase() !== '0x1' ||
      secBlock !== txBlock ||
      (priBlockHash && secBlockHash && secBlockHash !== priBlockHash) ||
      secTransfers.matchingLogs === 0 ||
      secTransfers.receivedBaseUnits !== receivedBaseUnits
    ) {
      return {
        ...baseFailMeta,
        paymentState: PAYMENT_STATES.MANUAL_REVIEW,
        status: 'RPC_CONSENSUS_MISMATCH',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        secondaryRpc: secondaryData.endpoint,
        message: 'Secondary BNB Smart Chain RPC node disagreed with primary verification result. Flagged for Manual Review.',
      };
    }

    quorumRpcs.push(secondaryData.endpoint);
  }

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
    txHash: normalizedHash,
    serviceKey: service.key,
    serviceName: service.name,
    network: 'BSC — BNB Smart Chain (BEP20)',
    networkDisplayName: 'BSC',
    chainId: BSC_CHAIN_ID,
    contract: USDT_BEP20_CONTRACT,
    recipient: RECEIVING_WALLET,
    senders,
    blockNumber: txBlock,
    blockTimestamp: blockTimestampIso,
    confirmations,
    receivedBaseUnits: receivedBaseUnits.toString(),
    receivedUsdt,
    expectedUsdt: service.expectedUsdt,
    bscscanUrl,
    rpcUsed: endpoint,
    quorumVerified: useQuorum,
    quorumRpcs,
    verifiedAt: new Date(nowMs).toISOString(),
    message: `On-chain BSC checks passed for ${receivedUsdt} USDT (BEP20) at block #${txBlock} (${confirmations} confirmations${useQuorum ? ', 2-RPC quorum' : ''}). NOT marked Paid until verified unique in local replay registry and matched as Completed/Credited in Binance Deposit History.`,
  };
}
