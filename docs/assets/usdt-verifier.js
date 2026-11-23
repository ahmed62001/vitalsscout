export const BSC_CHAIN_ID_HEX = '0x38';
export const BSC_CHAIN_ID = 56;
export const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
export const USDT_DECIMALS = 18;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const RECEIVING_WALLET = '0x78b865760a7154A8EeC758aC1B9d4a9661Bb8De9';
export const MIN_CONFIRMATIONS = 5;

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

async function rpcRequest(endpoint, method, params, fetchImpl, timeoutMs = 10000) {
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
    if (payload.error) {
      throw new Error(payload.error.message || 'JSON-RPC error');
    }
    return payload.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queryWithFailover(txHash, rpcEndpoints, fetchImpl) {
  const errors = [];
  for (const endpoint of rpcEndpoints) {
    try {
      const chainId = await rpcRequest(endpoint, 'eth_chainId', [], fetchImpl);
      if (String(chainId).toLowerCase() !== BSC_CHAIN_ID_HEX) {
        throw new Error(`Unexpected chainId ${chainId} (expected ${BSC_CHAIN_ID_HEX})`);
      }
      const [receipt, latestBlockHex] = await Promise.all([
        rpcRequest(endpoint, 'eth_getTransactionReceipt', [txHash], fetchImpl),
        rpcRequest(endpoint, 'eth_blockNumber', [], fetchImpl),
      ]);
      let tx = null;
      if (receipt === null) {
        tx = await rpcRequest(endpoint, 'eth_getTransactionByHash', [txHash], fetchImpl);
      }
      return { endpoint, receipt, latestBlockHex, tx };
    } catch (err) {
      errors.push(`${endpoint}: ${err?.message || String(err)}`);
    }
  }
  throw new Error(`All BNB Smart Chain RPC endpoints failed (${errors.join('; ')})`);
}

/**
 * Independently verify a USDT (BEP20) payment on BNB Smart Chain Mainnet.
 * Never returns verified=true unless all on-chain invariants pass.
 *
 * @param {object} options
 * @param {string} options.txHash
 * @param {'audit'|'audit-fix'} options.serviceKey
 * @param {string[]} [options.rpcEndpoints]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.minConfirmations]
 */
export async function verifyUsdtBep20Payment({
  txHash,
  serviceKey,
  rpcEndpoints = DEFAULT_BSC_RPCS,
  fetchImpl = globalThis.fetch,
  minConfirmations = MIN_CONFIRMATIONS,
}) {
  const service = USDT_SERVICES[serviceKey];
  if (!service) {
    return {
      verified: false,
      status: 'INVALID_SERVICE',
      message: `Unknown service "${serviceKey}". Expected "audit" ($20.86) or "audit-fix" ($48.86).`,
    };
  }

  const normalizedHash = normalizeTxHash(txHash);
  if (!normalizedHash) {
    return {
      verified: false,
      status: 'INVALID_TX_HASH',
      message: 'Invalid transaction hash. Enter a 66-character 0x... BNB Smart Chain txHash.',
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      verified: false,
      status: 'FETCH_UNAVAILABLE',
      message: 'HTTP fetch API is unavailable in this runtime.',
    };
  }

  let rpcData;
  try {
    rpcData = await queryWithFailover(normalizedHash, rpcEndpoints, fetchImpl);
  } catch (err) {
    return {
      verified: false,
      status: 'RPC_UNAVAILABLE',
      txHash: normalizedHash,
      message: err?.message || 'Unable to query BNB Smart Chain RPC nodes.',
    };
  }

  const { endpoint, receipt, latestBlockHex, tx } = rpcData;
  const bscscanUrl = `https://bscscan.com/tx/${normalizedHash}`;

  if (receipt === null) {
    if (tx && tx.blockNumber === null) {
      return {
        verified: false,
        status: 'PENDING_MEMPOOL',
        txHash: normalizedHash,
        bscscanUrl,
        rpcUsed: endpoint,
        message: 'Transaction is in the BNB Smart Chain mempool and not yet included in a block. Wait a few seconds and retry.',
      };
    }
    return {
      verified: false,
      status: 'TX_NOT_FOUND',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: 'Transaction hash not found on BNB Smart Chain (BEP20). Confirm you sent on BSC (Chain ID 56), not ERC20 or TRC20.',
    };
  }

  if (String(receipt.status).toLowerCase() !== '0x1') {
    return {
      verified: false,
      status: 'TX_REVERTED',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      message: 'Transaction reverted on-chain (status 0x0). No USDT transfer succeeded.',
    };
  }

  const targetContract = USDT_BEP20_CONTRACT.toLowerCase();
  const targetWallet = RECEIVING_WALLET.toLowerCase();
  const senders = [];
  let receivedBaseUnits = 0n;
  let matchingLogs = 0;

  for (const log of receipt.logs || []) {
    const addr = String(log.address || '').toLowerCase();
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (addr !== targetContract) continue;
    if (topics.length < 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (String(topics[2]).length !== 66) continue;

    const toAddr = `0x${String(topics[2]).slice(26).toLowerCase()}`;
    if (toAddr !== targetWallet) continue;

    const fromAddr = String(topics[1]).length === 66 ? `0x${String(topics[1]).slice(26).toLowerCase()}` : null;
    if (fromAddr && !senders.includes(fromAddr)) {
      senders.push(fromAddr);
    }

    let amount = 0n;
    try {
      amount = BigInt(log.data || '0x0');
    } catch {
      amount = 0n;
    }
    if (amount > 0n) {
      receivedBaseUnits += amount;
      matchingLogs += 1;
    }
  }

  if (matchingLogs === 0) {
    return {
      verified: false,
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
      verified: false,
      status: 'INSUFFICIENT_AMOUNT',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      confirmations,
      receivedBaseUnits: receivedBaseUnits.toString(),
      receivedUsdt,
      expectedUsdt: service.expectedUsdt,
      message: `Insufficient amount: received ${receivedUsdt} USDT, expected at least ${service.expectedUsdt} USDT for ${service.name}.`,
    };
  }

  if (confirmations < minConfirmations) {
    return {
      verified: false,
      status: 'PENDING_CONFIRMATIONS',
      txHash: normalizedHash,
      bscscanUrl,
      rpcUsed: endpoint,
      blockNumber: txBlock,
      confirmations,
      minConfirmations,
      receivedBaseUnits: receivedBaseUnits.toString(),
      receivedUsdt,
      expectedUsdt: service.expectedUsdt,
      message: `Payment detected (${receivedUsdt} USDT) at block ${txBlock}, currently ${confirmations}/${minConfirmations} confirmations. Retry in a few seconds.`,
    };
  }

  return {
    verified: true,
    status: 'VERIFIED',
    txHash: normalizedHash,
    serviceKey: service.key,
    serviceName: service.name,
    network: 'BNB Smart Chain (BEP20)',
    chainId: BSC_CHAIN_ID,
    contract: USDT_BEP20_CONTRACT,
    recipient: RECEIVING_WALLET,
    senders,
    blockNumber: txBlock,
    confirmations,
    receivedBaseUnits: receivedBaseUnits.toString(),
    receivedUsdt,
    expectedUsdt: service.expectedUsdt,
    bscscanUrl,
    rpcUsed: endpoint,
    verifiedAt: new Date().toISOString(),
    message: `Verified ${receivedUsdt} USDT (BEP20) on BNB Smart Chain block #${txBlock} (${confirmations} confirmations).`,
  };
}
