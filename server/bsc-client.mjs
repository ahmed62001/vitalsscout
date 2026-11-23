import {
  BSC_CHAIN_ID,
  BSC_CHAIN_ID_HEX,
  DEFAULT_BLOCK_SCAN_LOOKBACK,
  DEFAULT_BSC_RPCS,
  DEFAULT_LOG_SCAN_RPC,
  DEFAULT_MIN_CONFIRMATIONS,
  ETHERSCAN_V2_API_BASE_URL,
  MAX_ETH_GET_LOGS_BLOCK_SPAN,
  MIN_CLOCK_SKEW_TOLERANCE_MS,
  RECEIVING_DEPOSIT_ADDRESS,
  TRANSFER_TOPIC,
  USDT_BEP20_CONTRACT,
  redactSecrets,
} from './config.mjs';
import {
  formatBaseUnits,
  isAllowedRpcUrl,
  isValidTxHash,
  normalizeTxHash,
} from '../docs/assets/usdt-verifier.js';

function isZeroPaddedAddressMatch(topicHex, targetAddress) {
  if (typeof topicHex !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topicHex)) {
    return false;
  }
  const cleanTarget = targetAddress.toLowerCase().replace(/^0x/, '');
  return topicHex.slice(26).toLowerCase() === cleanTarget;
}

function extractAddressFromTopic(topicHex) {
  if (typeof topicHex !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topicHex)) {
    return null;
  }
  return `0x${topicHex.slice(26).toLowerCase()}`;
}

function padAddressToTopic(address) {
  const clean = String(address).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return `0x${'0'.repeat(24)}${clean}`;
}

function hexToSafeInt(hexValue) {
  if (typeof hexValue !== 'string' || !/^0x[0-9a-f]+$/i.test(hexValue)) {
    return null;
  }
  const big = BigInt(hexValue);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(big);
}

function parseLogUint256(dataHex) {
  if (typeof dataHex !== 'string' || !/^0x[0-9a-f]{64}$/i.test(dataHex)) {
    return null;
  }
  return BigInt(dataHex);
}

function analyzeReceiptLogs(logs, usdtContract, receivingAddress) {
  const targetContractLower = usdtContract.toLowerCase();
  const targetAddressLower = receivingAddress.toLowerCase();
  let matchingBaseUnits = 0n;
  let matchingLogCount = 0;
  const wrongTokenContracts = [];
  const otherRecipients = [];

  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log || log.removed === true) {
      continue;
    }
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) {
      continue;
    }
    const amount = parseLogUint256(log.data);
    if (amount === null || amount <= 0n) {
      continue;
    }

    const logContractLower = String(log.address || '').toLowerCase();
    const toTarget = isZeroPaddedAddressMatch(topics[2], targetAddressLower);

    if (logContractLower === targetContractLower && toTarget) {
      matchingBaseUnits += amount;
      matchingLogCount += 1;
    } else if (toTarget && logContractLower !== targetContractLower) {
      wrongTokenContracts.push(String(log.address || ''));
    } else if (logContractLower === targetContractLower && !toTarget) {
      const recipient = extractAddressFromTopic(topics[2]);
      if (recipient) {
        otherRecipients.push(recipient);
      }
    }
  }

  return {
    matchingBaseUnits,
    matchingLogCount,
    wrongTokenContracts,
    otherRecipients,
  };
}

/**
 * Creates a BNB Smart Chain (BEP20) independent blockchain verifier & deposit log scanner.
 * Supports Etherscan API V2 (when a paid ChainID 56 key is provided) plus free multi-RPC
 * BSC JSON-RPC verification and 2-of-N receipt quorum.
 * @param {object} [options]
 */
export function createBscClient(options = {}) {
  const receivingAddress = String(options.receivingAddress || RECEIVING_DEPOSIT_ADDRESS)
    .trim()
    .toLowerCase();
  const usdtContract = String(options.usdtContract || USDT_BEP20_CONTRACT).trim().toLowerCase();
  const bscscanApiBaseUrl = String(options.bscscanApiBaseUrl || ETHERSCAN_V2_API_BASE_URL).replace(/\/+$/, '');
  const bscscanApiKey = String(options.bscscanApiKey || '').trim();
  const logScanRpcUrl = String(options.logScanRpcUrl || DEFAULT_LOG_SCAN_RPC).trim();
  const rpcUrls = Array.isArray(options.bscRpcUrls) && options.bscRpcUrls.length > 0
    ? [...options.bscRpcUrls]
    : [...DEFAULT_BSC_RPCS];
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const secrets = bscscanApiKey ? [bscscanApiKey] : [];

  for (const url of rpcUrls) {
    if (!isAllowedRpcUrl(url)) {
      throw new Error(`Unsafe RPC endpoint blocked: ${url}`);
    }
  }
  if (!isAllowedRpcUrl(logScanRpcUrl)) {
    throw new Error(`Unsafe log scan RPC endpoint blocked: ${logScanRpcUrl}`);
  }

  async function defaultRpcCall(rpcUrl, method, params = []) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('No fetch implementation available.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`RPC HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data?.error) {
        throw new Error(data.error.message || 'JSON-RPC error');
      }
      return data?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  const rpcCall = options.rpcCallImpl || defaultRpcCall;

  async function querySingleRpcForTx(rpcUrl, normalizedHash) {
    const chainId = await rpcCall(rpcUrl, 'eth_chainId', []);
    if (String(chainId || '').toLowerCase() !== BSC_CHAIN_ID_HEX) {
      return {
        rpcUrl,
        wrongNetwork: true,
        chainId: String(chainId || ''),
      };
    }

    const [receipt, latestBlockHex] = await Promise.all([
      rpcCall(rpcUrl, 'eth_getTransactionReceipt', [normalizedHash]),
      rpcCall(rpcUrl, 'eth_blockNumber', []),
    ]);

    if (!receipt) {
      const mempoolTx = await rpcCall(rpcUrl, 'eth_getTransactionByHash', [normalizedHash]);
      return {
        rpcUrl,
        wrongNetwork: false,
        receipt: null,
        mempoolTx: mempoolTx || null,
        latestBlock: hexToSafeInt(latestBlockHex),
      };
    }

    if (String(receipt.transactionHash || '').toLowerCase() !== normalizedHash) {
      throw new Error('Mismatched receipt transactionHash.');
    }

    const txBlockNumber = hexToSafeInt(receipt.blockNumber);
    const latestBlock = hexToSafeInt(latestBlockHex);
    if (txBlockNumber === null || latestBlock === null) {
      throw new Error('Invalid block numbers returned by BSC RPC.');
    }

    let blockTimestampMs = null;
    const blockObj = await rpcCall(rpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (blockObj && String(blockObj.hash || '').toLowerCase() === String(receipt.blockHash || '').toLowerCase()) {
      const tsSec = hexToSafeInt(blockObj.timestamp);
      if (tsSec !== null) {
        blockTimestampMs = tsSec * 1000;
      }
    } else if (blockObj && receipt.blockHash) {
      throw new Error('Block hash mismatch between transaction receipt and block header.');
    }

    const logAnalysis = analyzeReceiptLogs(receipt.logs, usdtContract, receivingAddress);
    const confirmations = latestBlock >= txBlockNumber ? latestBlock - txBlockNumber + 1 : 0;

    return {
      rpcUrl,
      wrongNetwork: false,
      receipt,
      txBlockNumber,
      blockHash: String(receipt.blockHash || '').toLowerCase(),
      receiptStatus: String(receipt.status || '').toLowerCase(),
      blockTimestampMs,
      latestBlock,
      confirmations,
      logAnalysis,
    };
  }

  async function scanViaEtherscanV2(fromBlock, toBlock) {
    if (!bscscanApiKey) {
      return { ok: false, reason: 'DISABLED_MISSING_KEY', transfers: [] };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, reason: 'FETCH_UNAVAILABLE', transfers: [] };
    }

    const url = new URL(bscscanApiBaseUrl);
    url.searchParams.set('chainid', String(BSC_CHAIN_ID));
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'tokentx');
    url.searchParams.set('contractaddress', usdtContract);
    url.searchParams.set('address', receivingAddress);
    url.searchParams.set('startblock', String(fromBlock));
    url.searchParams.set('endblock', String(toBlock));
    url.searchParams.set('page', '1');
    url.searchParams.set('offset', '100');
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('apikey', bscscanApiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const json = await res.json();
      if (json?.status !== '1') {
        const resultMsg = String(json?.result || json?.message || '');
        if (/free api access is not supported for this chain/i.test(resultMsg)) {
          return {
            ok: false,
            reason: 'ETHERSCAN_V2_FREE_PLAN_UNSUPPORTED',
            error: redactSecrets(resultMsg, secrets),
            transfers: [],
          };
        }
        if (/no transactions found/i.test(resultMsg)) {
          return { ok: true, source: 'ETHERSCAN_V2', transfers: [] };
        }
        return {
          ok: false,
          reason: 'ETHERSCAN_V2_NOTOK',
          error: redactSecrets(resultMsg, secrets),
          transfers: [],
        };
      }

      const rows = Array.isArray(json.result) ? json.result : [];
      const transfers = [];
      for (const row of rows) {
        if (
          String(row?.contractAddress || '').toLowerCase() !== usdtContract ||
          String(row?.to || '').toLowerCase() !== receivingAddress ||
          row?.isError === '1' ||
          row?.txreceipt_status === '0'
        ) {
          continue;
        }
        let amountBaseUnits = 0n;
        try {
          amountBaseUnits = BigInt(String(row.value || '0'));
        } catch {
          continue;
        }
        if (amountBaseUnits <= 0n) {
          continue;
        }
        transfers.push({
          txHash: normalizeTxHash(row.hash),
          logIndex: Number(row.logIndex || 0),
          fromAddress: String(row.from || '').toLowerCase(),
          toAddress: receivingAddress,
          tokenContract: usdtContract,
          amountBaseUnits,
          amountUsdt: formatBaseUnits(amountBaseUnits),
          blockNumber: Number(row.blockNumber),
          blockHash: String(row.blockHash || '').toLowerCase(),
          blockTimestampMs: row.timeStamp ? Number(row.timeStamp) * 1000 : null,
          confirmations: row.confirmations ? Number(row.confirmations) : 0,
          source: 'ETHERSCAN_V2',
        });
      }
      return { ok: true, source: 'ETHERSCAN_V2', transfers };
    } catch (error) {
      return {
        ok: false,
        reason: 'ETHERSCAN_V2_ERROR',
        error: redactSecrets(error?.message || String(error), secrets),
        transfers: [],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getLatestBlockNumber() {
      const scanList = [logScanRpcUrl, ...rpcUrls.filter((u) => u !== logScanRpcUrl)];
      const errors = [];
      for (const url of scanList) {
        try {
          const [chainId, blockHex] = await Promise.all([
            rpcCall(url, 'eth_chainId', []),
            rpcCall(url, 'eth_blockNumber', []),
          ]);
          if (String(chainId || '').toLowerCase() !== BSC_CHAIN_ID_HEX) {
            errors.push(`${url}: wrong chainId ${chainId}`);
            continue;
          }
          const blockNum = hexToSafeInt(blockHex);
          if (blockNum !== null) {
            return { ok: true, blockNumber: blockNum, rpcUrl: url };
          }
        } catch (err) {
          errors.push(`${url}: ${err?.message || String(err)}`);
        }
      }
      return { ok: false, reason: 'RPC_UNAVAILABLE', error: errors.join('; ') };
    },

    /**
     * Scans incoming USDT (BEP20) transfers to the locked receiving address.
     * Uses Etherscan V2 if keyed & supported on Chain ID 56, and falls back to BSC RPC eth_getLogs.
     * @param {object} [opts]
     */
    async scanIncomingDeposits(opts = {}) {
      const headRes = opts.toBlock !== undefined
        ? { ok: true, blockNumber: Number(opts.toBlock) }
        : await this.getLatestBlockNumber();
      if (!headRes.ok) {
        return {
          ok: false,
          reason: headRes.reason,
          error: headRes.error,
          transfers: [],
        };
      }

      const toBlock = headRes.blockNumber;
      const fromBlock = opts.fromBlock !== undefined
        ? Math.max(0, Number(opts.fromBlock))
        : Math.max(0, toBlock - DEFAULT_BLOCK_SCAN_LOOKBACK);

      if (fromBlock > toBlock) {
        return {
          ok: true,
          source: 'NONE_NEEDED',
          fromBlock,
          toBlock,
          latestBlock: toBlock,
          transfers: [],
        };
      }

      let bscscanMeta = { status: bscscanApiKey ? 'ATTEMPTED' : 'DISABLED_MISSING_KEY' };
      if (bscscanApiKey) {
        const v2 = await scanViaEtherscanV2(fromBlock, toBlock);
        if (v2.ok) {
          return {
            ok: true,
            source: v2.source,
            bscscanStatus: 'OK',
            fromBlock,
            toBlock,
            latestBlock: toBlock,
            transfers: v2.transfers,
          };
        }
        bscscanMeta = { status: v2.reason, error: v2.error };
      }

      const recipientTopic = padAddressToTopic(receivingAddress);
      const transfers = [];
      const seenKeys = new Set();
      const blockTimestampCache = new Map();

      for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += MAX_ETH_GET_LOGS_BLOCK_SPAN) {
        const chunkEnd = Math.min(toBlock, chunkStart + MAX_ETH_GET_LOGS_BLOCK_SPAN - 1);
        const rawLogs = await rpcCall(logScanRpcUrl, 'eth_getLogs', [
          {
            fromBlock: `0x${chunkStart.toString(16)}`,
            toBlock: `0x${chunkEnd.toString(16)}`,
            address: usdtContract,
            topics: [TRANSFER_TOPIC, null, recipientTopic],
          },
        ]);

        for (const log of Array.isArray(rawLogs) ? rawLogs : []) {
          if (!log || log.removed === true) {
            continue;
          }
          if (
            String(log.address || '').toLowerCase() !== usdtContract ||
            !Array.isArray(log.topics) ||
            String(log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC ||
            !isZeroPaddedAddressMatch(log.topics[2], receivingAddress)
          ) {
            continue;
          }
          const amountBaseUnits = parseLogUint256(log.data);
          if (amountBaseUnits === null || amountBaseUnits <= 0n) {
            continue;
          }

          const txHash = normalizeTxHash(log.transactionHash);
          const logIndex = hexToSafeInt(log.logIndex) ?? 0;
          const dedupKey = `${txHash}:${logIndex}`;
          if (!txHash || seenKeys.has(dedupKey)) {
            continue;
          }
          seenKeys.add(dedupKey);

          const blockNumber = hexToSafeInt(log.blockNumber);
          let blockTimestampMs = null;
          if (blockNumber !== null) {
            if (!blockTimestampCache.has(blockNumber)) {
              try {
                const blk = await rpcCall(logScanRpcUrl, 'eth_getBlockByNumber', [log.blockNumber, false]);
                const ts = hexToSafeInt(blk?.timestamp);
                blockTimestampCache.set(blockNumber, ts !== null ? ts * 1000 : null);
              } catch {
                blockTimestampCache.set(blockNumber, null);
              }
            }
            blockTimestampMs = blockTimestampCache.get(blockNumber) ?? null;
          }

          transfers.push({
            txHash,
            logIndex,
            fromAddress: extractAddressFromTopic(log.topics[1]) || '',
            toAddress: receivingAddress,
            tokenContract: usdtContract,
            amountBaseUnits,
            amountUsdt: formatBaseUnits(amountBaseUnits),
            blockNumber,
            blockHash: String(log.blockHash || '').toLowerCase(),
            blockTimestampMs,
            confirmations: blockNumber !== null && toBlock >= blockNumber ? toBlock - blockNumber + 1 : 0,
            source: 'BSC_RPC_GET_LOGS',
          });
        }
      }

      return {
        ok: true,
        source: 'BSC_RPC_GET_LOGS',
        bscscanStatus: bscscanMeta.status,
        bscscanError: bscscanMeta.error,
        fromBlock,
        toBlock,
        latestBlock: toBlock,
        transfers,
      };
    },

    /**
     * Independently verifies a specific transaction hash against BSC RPC quorum.
     * Enforces chain ID 56, official USDT BEP20 contract, target address, non-reorged logs,
     * creation/expiration window, minimum confirmations, and exact BigInt amount matching.
     * @param {object} opts
     */
    async verifyTransaction(opts) {
      const normalizedHash = normalizeTxHash(opts?.txHash);
      if (!isValidTxHash(normalizedHash)) {
        return {
          ok: false,
          status: 'FAILED',
          reason: 'INVALID_TX_HASH',
          error: 'Transaction hash must be a valid 66-character 0x-prefixed hex string.',
        };
      }

      const expectedBaseUnits = BigInt(opts.expectedBaseUnits);
      const minConfirmations = Number(opts.minConfirmations || DEFAULT_MIN_CONFIRMATIONS);
      const requireQuorum = opts.requireQuorum !== false && rpcUrls.length >= 2;
      const requiredAgreeingNodes = requireQuorum ? 2 : 1;

      const settled = await Promise.allSettled(
        rpcUrls.map((url) => querySingleRpcForTx(url, normalizedHash)),
      );

      const observations = [];
      const errors = [];
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          observations.push(item.value);
        } else {
          errors.push(item.reason?.message || String(item.reason));
        }
      }

      const wrongNetworkObs = observations.find((o) => o.wrongNetwork);
      if (wrongNetworkObs && observations.every((o) => o.wrongNetwork)) {
        return {
          ok: false,
          status: 'FAILED',
          reason: 'WRONG_NETWORK',
          txHash: normalizedHash,
          error: `RPC returned chain ID ${wrongNetworkObs.chainId}; expected BSC ${BSC_CHAIN_ID_HEX} (56).`,
        };
      }

      const validObs = observations.filter((o) => !o.wrongNetwork);
      if (validObs.length === 0) {
        return {
          ok: false,
          status: 'RETRYABLE_ERROR',
          reason: 'RPC_UNAVAILABLE',
          txHash: normalizedHash,
          error: `No healthy BSC RPC nodes responded (${errors.join('; ') || 'network error'}).`,
        };
      }

      const receiptObs = validObs.filter((o) => o.receipt !== null);
      if (receiptObs.length === 0) {
        const mempoolObs = validObs.find((o) => o.mempoolTx !== null);
        if (mempoolObs) {
          return {
            ok: false,
            status: 'PENDING_MEMPOOL',
            reason: 'TX_UNCONFIRMED_IN_MEMPOOL',
            txHash: normalizedHash,
            confirmations: 0,
            requiredConfirmations: minConfirmations,
          };
        }
        return {
          ok: false,
          status: 'NOT_FOUND',
          reason: 'TX_NOT_FOUND',
          txHash: normalizedHash,
          error: 'Transaction hash not found on BNB Smart Chain.',
        };
      }

      if (receiptObs.length < requiredAgreeingNodes) {
        return {
          ok: false,
          status: 'RETRYABLE_ERROR',
          reason: 'RPC_QUORUM_UNAVAILABLE',
          txHash: normalizedHash,
          error: `Only ${receiptObs.length} BSC RPC node(s) returned a receipt; ${requiredAgreeingNodes} required for quorum.`,
        };
      }

      const fingerprints = new Set(
        receiptObs.map(
          (o) =>
            `${o.txBlockNumber}:${o.blockHash}:${o.receiptStatus}:${o.logAnalysis.matchingBaseUnits.toString()}:${o.logAnalysis.wrongTokenContracts.join(',')}:${o.logAnalysis.otherRecipients.join(',')}`,
        ),
      );

      if (fingerprints.size > 1) {
        return {
          ok: false,
          status: 'MANUAL_REVIEW',
          reason: 'RPC_CONSENSUS_MISMATCH',
          txHash: normalizedHash,
          error: 'BSC RPC nodes returned conflicting receipt data for this transaction hash.',
        };
      }

      const primary = receiptObs[0];
      const maxLatestBlock = Math.max(...receiptObs.map((o) => o.latestBlock));
      const confirmations = Math.max(0, maxLatestBlock - primary.txBlockNumber + 1);
      const blockTimestampMs =
        receiptObs.find((o) => typeof o.blockTimestampMs === 'number')?.blockTimestampMs ?? null;

      if (primary.receiptStatus !== '0x1') {
        return {
          ok: false,
          status: 'FAILED',
          reason: 'TX_REVERTED',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockHash: primary.blockHash,
          confirmations,
          blockTimestampMs,
          error: 'Transaction reverted on-chain (receipt status != 0x1).',
        };
      }

      const { matchingBaseUnits, wrongTokenContracts, otherRecipients } = primary.logAnalysis;
      if (matchingBaseUnits <= 0n) {
        if (wrongTokenContracts.length > 0) {
          return {
            ok: false,
            status: 'FAILED',
            reason: 'WRONG_TOKEN_CONTRACT',
            txHash: normalizedHash,
            blockNumber: primary.txBlockNumber,
            confirmations,
            wrongTokenContracts,
            error: `Received token contract (${wrongTokenContracts[0]}) is not official USDT BEP20 (${usdtContract}).`,
          };
        }
        if (otherRecipients.length > 0) {
          return {
            ok: false,
            status: 'FAILED',
            reason: 'WRONG_DESTINATION_ADDRESS',
            txHash: normalizedHash,
            blockNumber: primary.txBlockNumber,
            confirmations,
            otherRecipients,
            error: `USDT transfer went to ${otherRecipients[0]}, not the configured Binance BSC deposit address (${receivingAddress}).`,
          };
        }
        return {
          ok: false,
          status: 'FAILED',
          reason: 'NO_MATCHING_USDT_TRANSFER',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          confirmations,
          error: 'No valid USDT (BEP20) Transfer log to the receiving address found in transaction receipt.',
        };
      }

      if (
        opts.orderCreatedAtMs !== undefined &&
        blockTimestampMs !== null &&
        blockTimestampMs + MIN_CLOCK_SKEW_TOLERANCE_MS < Number(opts.orderCreatedAtMs)
      ) {
        return {
          ok: false,
          status: 'FAILED',
          reason: 'TX_BEFORE_ORDER_CREATED',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockTimestampMs,
          receivedBaseUnits: matchingBaseUnits,
          receivedUsdt: formatBaseUnits(matchingBaseUnits),
          error: 'Transaction occurred before the order invoice was created and cannot be applied.',
        };
      }

      if (
        opts.orderExpiresAtMs !== undefined &&
        blockTimestampMs !== null &&
        blockTimestampMs > Number(opts.orderExpiresAtMs)
      ) {
        return {
          ok: false,
          status: 'EXPIRED_PAYMENT',
          reason: 'TX_AFTER_ORDER_EXPIRATION',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockHash: primary.blockHash,
          blockTimestampMs,
          confirmations,
          receivedBaseUnits: matchingBaseUnits,
          receivedUsdt: formatBaseUnits(matchingBaseUnits),
          expectedBaseUnits,
          expectedUsdt: formatBaseUnits(expectedBaseUnits),
          error: 'On-chain USDT payment arrived after the invoice expiration window.',
        };
      }

      const amountComparison =
        matchingBaseUnits === expectedBaseUnits
          ? 'EXACT'
          : matchingBaseUnits < expectedBaseUnits
            ? 'UNDERPAID'
            : 'OVERPAID';

      if (confirmations < minConfirmations) {
        return {
          ok: false,
          status: 'CONFIRMING',
          reason: 'INSUFFICIENT_CONFIRMATIONS',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockHash: primary.blockHash,
          blockTimestampMs,
          confirmations,
          requiredConfirmations: minConfirmations,
          receivedBaseUnits: matchingBaseUnits,
          receivedUsdt: formatBaseUnits(matchingBaseUnits),
          expectedBaseUnits,
          expectedUsdt: formatBaseUnits(expectedBaseUnits),
          amountComparison,
        };
      }

      if (matchingBaseUnits < expectedBaseUnits) {
        return {
          ok: false,
          status: 'UNDERPAID',
          reason: 'UNDERPAID_AMOUNT',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockHash: primary.blockHash,
          blockTimestampMs,
          confirmations,
          receivedBaseUnits: matchingBaseUnits,
          receivedUsdt: formatBaseUnits(matchingBaseUnits),
          expectedBaseUnits,
          expectedUsdt: formatBaseUnits(expectedBaseUnits),
          deficitBaseUnits: expectedBaseUnits - matchingBaseUnits,
          deficitUsdt: formatBaseUnits(expectedBaseUnits - matchingBaseUnits),
          error: `Received ${formatBaseUnits(matchingBaseUnits)} USDT, which is below expected ${formatBaseUnits(expectedBaseUnits)} USDT.`,
        };
      }

      if (matchingBaseUnits > expectedBaseUnits) {
        return {
          ok: false,
          status: 'OVERPAID',
          reason: 'OVERPAID_AMOUNT',
          txHash: normalizedHash,
          blockNumber: primary.txBlockNumber,
          blockHash: primary.blockHash,
          blockTimestampMs,
          confirmations,
          receivedBaseUnits: matchingBaseUnits,
          receivedUsdt: formatBaseUnits(matchingBaseUnits),
          expectedBaseUnits,
          expectedUsdt: formatBaseUnits(expectedBaseUnits),
          surplusBaseUnits: matchingBaseUnits - expectedBaseUnits,
          surplusUsdt: formatBaseUnits(matchingBaseUnits - expectedBaseUnits),
          error: `Received ${formatBaseUnits(matchingBaseUnits)} USDT, exceeding expected ${formatBaseUnits(expectedBaseUnits)} USDT.`,
        };
      }

      return {
        ok: true,
        status: 'CONFIRMED',
        reason: 'BLOCKCHAIN_CONFIRMED',
        source: 'BSC_RPC_QUORUM',
        quorumCount: receiptObs.length,
        txHash: normalizedHash,
        blockNumber: primary.txBlockNumber,
        blockHash: primary.blockHash,
        blockTimestampMs,
        confirmations,
        receivedBaseUnits: matchingBaseUnits,
        receivedUsdt: formatBaseUnits(matchingBaseUnits),
        expectedBaseUnits,
        expectedUsdt: formatBaseUnits(expectedBaseUnits),
      };
    },
  };
}
