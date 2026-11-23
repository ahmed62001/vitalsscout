import { BINANCE_DEPOSIT_STATUS, formatBaseUnits } from './binance-client.mjs';
import {
  DEFAULT_BLOCK_SCAN_LOOKBACK,
  MIN_CLOCK_SKEW_TOLERANCE_MS,
  RECEIVING_DEPOSIT_ADDRESS,
  redactSecrets,
} from './config.mjs';
import {
  ALLOWED_MANUAL_RESOLUTIONS,
  ORDER_STATES,
  canTriggerDelivery,
} from './order-states.mjs';
import { isValidTxHash, normalizeTxHash } from '../docs/assets/usdt-verifier.js';

function appendHistory(order, fromState, toState, reason, nowIso, extra = undefined) {
  order.history = Array.isArray(order.history) ? order.history : [];
  order.history.push({
    timestamp: nowIso,
    fromState,
    toState,
    reason,
    ...(extra ? { details: extra } : {}),
  });
}

function evaluateBinanceDepositForOrder(deposits, txHash, order, storeData, receivingAddress) {
  const normalizedHash = normalizeTxHash(txHash);
  const expectedBaseUnits = BigInt(order.amountDueBaseUnits);
  const targetAddress = receivingAddress.toLowerCase();

  const matches = deposits.filter((dep) => dep && dep.txId === normalizedHash);
  if (matches.length === 0) {
    return { status: 'NOT_FOUND' };
  }
  if (matches.length > 1) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'BINANCE_AMBIGUOUS_DEPOSIT_RECORDS',
      error: 'Multiple Binance deposit records share the same transaction hash.',
    };
  }

  const dep = matches[0];
  const claimedDeposit = storeData.claimedBinanceDeposits?.[dep.depositId];
  if (claimedDeposit && claimedDeposit.orderId !== order.orderId) {
    return {
      status: 'REJECTED_ALREADY_CLAIMED',
      reason: 'BINANCE_DEPOSIT_ALREADY_CLAIMED',
      claimedByOrderId: claimedDeposit.orderId,
      depositId: dep.depositId,
    };
  }

  if (dep.coin !== 'USDT') {
    return {
      status: 'FAILED',
      reason: 'BINANCE_WRONG_COIN',
      deposit: dep,
      error: `Binance recorded coin ${dep.coin}, expected USDT.`,
    };
  }
  if (dep.network !== 'BSC') {
    return {
      status: 'FAILED',
      reason: 'BINANCE_WRONG_NETWORK',
      deposit: dep,
      error: `Binance recorded network ${dep.network}, expected BSC.`,
    };
  }
  if (dep.address && dep.address !== targetAddress) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'BINANCE_ADDRESS_MISMATCH',
      deposit: dep,
      error: `Binance deposit address ${dep.address} does not match ${targetAddress}.`,
    };
  }
  if (dep.transferType !== 0) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'BINANCE_INTERNAL_TRANSFER_REVIEW',
      deposit: dep,
      error: 'Binance marked transferType != 0 (internal off-chain transfer); manual review required.',
    };
  }
  if (
    dep.travelRuleStatus === 1 ||
    dep.status === BINANCE_DEPOSIT_STATUS.WAITING_USER_CONFIRM
  ) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'BINANCE_TRAVEL_RULE_HOLD',
      deposit: dep,
      error: 'Binance deposit requires Travel Rule / compliance confirmation.',
    };
  }
  if (dep.status === BINANCE_DEPOSIT_STATUS.WRONG_DEPOSIT) {
    return {
      status: 'FAILED',
      reason: 'BINANCE_WRONG_DEPOSIT',
      deposit: dep,
      error: 'Binance flagged deposit status=7 (wrong deposit).',
    };
  }
  if (
    dep.status === BINANCE_DEPOSIT_STATUS.PENDING ||
    dep.status === BINANCE_DEPOSIT_STATUS.CREDITED_LOCKED
  ) {
    return {
      status: 'PENDING',
      reason:
        dep.status === BINANCE_DEPOSIT_STATUS.CREDITED_LOCKED
          ? 'BINANCE_CREDITED_AWAITING_UNLOCK'
          : 'BINANCE_DEPOSIT_PENDING',
      deposit: dep,
    };
  }
  if (dep.status !== BINANCE_DEPOSIT_STATUS.SUCCESS) {
    return {
      status: 'MANUAL_REVIEW',
      reason: `BINANCE_UNKNOWN_STATUS_${dep.status}`,
      deposit: dep,
    };
  }
  if (!dep.amountValid) {
    return {
      status: 'MANUAL_REVIEW',
      reason: 'BINANCE_INVALID_AMOUNT',
      deposit: dep,
    };
  }
  if (dep.amountBaseUnits < expectedBaseUnits) {
    return {
      status: 'UNDERPAID',
      reason: 'BINANCE_AMOUNT_UNDERPAID',
      deposit: dep,
    };
  }
  if (dep.amountBaseUnits > expectedBaseUnits) {
    return {
      status: 'OVERPAID',
      reason: 'BINANCE_AMOUNT_OVERPAID',
      deposit: dep,
    };
  }

  return {
    status: 'CONFIRMED',
    reason: 'BINANCE_DEPOSIT_CONFIRMED',
    deposit: dep,
  };
}

/**
 * Dual-source USDT (BEP20 / BSC) payment verification and order lifecycle engine.
 * Combines independent BNB Smart Chain RPC verification with read-only Binance Deposit History.
 * Never marks an order Paid or enables automatic fulfillment unless both sources confirm.
 */
export function createPaymentVerificationEngine({
  store,
  binanceClient,
  bscClient,
  config,
  onOrderPaid = null,
  nowFn = () => Date.now(),
}) {
  const receivingAddress = String(config?.receivingAddress || RECEIVING_DEPOSIT_ADDRESS).toLowerCase();
  const minConfirmations = Number(config?.minConfirmations || 15);
  const secrets = Array.isArray(config?.secretValues) ? config.secretValues : [];

  async function triggerDeliveryIfAuthorized(orderSnapshot) {
    if (typeof onOrderPaid !== 'function') {
      return { triggered: false, reason: 'NO_HANDLER' };
    }
    if (!canTriggerDelivery(orderSnapshot, Boolean(config?.autoFulfillmentEnabled))) {
      return {
        triggered: false,
        reason: config?.autoFulfillmentEnabled ? 'ALREADY_TRIGGERED_OR_NOT_PAID' : 'AUTO_FULFILLMENT_DISABLED',
      };
    }

    const reserved = await store.mutate((data) => {
      const current = data.orders[orderSnapshot.orderId];
      if (!canTriggerDelivery(current, Boolean(config?.autoFulfillmentEnabled))) {
        return null;
      }
      const nowIso = new Date(nowFn()).toISOString();
      current.deliveryTriggered = true;
      current.deliveryTriggeredAt = nowIso;
      current.updatedAt = nowIso;
      appendHistory(current, current.state, current.state, 'DELIVERY_TRIGGERED', nowIso);
      return structuredClone(current);
    });

    if (!reserved) {
      return { triggered: false, reason: 'IDEMPOTENT_SKIP' };
    }

    await onOrderPaid(reserved);
    return { triggered: true, order: reserved };
  }

  async function expireStaleOrdersInStore() {
    const nowMs = nowFn();
    const nowIso = new Date(nowMs).toISOString();
    return store.mutate((data) => {
      const expiredIds = [];
      for (const order of Object.values(data.orders)) {
        if (order && order.state === ORDER_STATES.AWAITING_PAYMENT && nowMs > Number(order.expiresAtMs)) {
          const prev = order.state;
          order.state = ORDER_STATES.EXPIRED;
          order.statusReason = 'INVOICE_EXPIRED';
          order.updatedAt = nowIso;
          appendHistory(order, prev, ORDER_STATES.EXPIRED, 'INVOICE_EXPIRED', nowIso);
          expiredIds.push(order.orderId);
        }
      }
      return expiredIds;
    });
  }

  return {
    async createOrder(input) {
      return store.createOrder({
        ...input,
        ttlSeconds: input?.ttlSeconds ?? config?.invoiceTtlSeconds,
      });
    },

    async getOrder(orderId) {
      await expireStaleOrdersInStore();
      return store.getOrder(orderId);
    },

    /**
     * Verifies a specific BSC TXID against an Order ID using BSC RPC quorum + Binance Deposit History.
     * Enforces replay/double-spend protection, expiration checks, exact amount comparison, and dual-source gate.
     * @param {string} orderId
     * @param {string} rawTxHash
     */
    async verifyOrderByTxHash(orderId, rawTxHash) {
      const normalizedHash = normalizeTxHash(rawTxHash);
      if (!isValidTxHash(normalizedHash)) {
        return {
          ok: false,
          reason: 'INVALID_TX_HASH',
          error: 'Transaction hash must be a 66-character 0x-prefixed hex string.',
        };
      }

      const snapBefore = await store.readSnapshot();
      const existingOrder = snapBefore.orders[orderId];
      if (!existingOrder) {
        return {
          ok: false,
          reason: 'ORDER_NOT_FOUND',
          error: `Order ${orderId} not found.`,
        };
      }

      const existingTxClaim = snapBefore.claimedTxHashes[normalizedHash];
      if (existingTxClaim && existingTxClaim.orderId !== orderId) {
        return {
          ok: false,
          rejected: true,
          reason: 'TX_HASH_ALREADY_CLAIMED',
          claimedByOrderId: existingTxClaim.orderId,
          error: `Transaction ${normalizedHash} has already been claimed by order ${existingTxClaim.orderId}.`,
        };
      }

      if (existingOrder.state === ORDER_STATES.PAID) {
        if (existingOrder.txHash && existingOrder.txHash !== normalizedHash) {
          return {
            ok: false,
            rejected: true,
            reason: 'ORDER_ALREADY_PAID_DIFFERENT_TX',
            order: existingOrder,
          };
        }
        return {
          ok: true,
          idempotent: true,
          order: existingOrder,
        };
      }

      if (existingOrder.txHash && existingOrder.txHash !== normalizedHash) {
        return {
          ok: false,
          rejected: true,
          reason: 'ORDER_ALREADY_BOUND_TO_TX',
          boundTxHash: existingOrder.txHash,
          error: `Order ${orderId} is already bound to transaction ${existingOrder.txHash}.`,
        };
      }

      const nowMs = nowFn();
      const orderExpiredWallClock =
        existingOrder.state === ORDER_STATES.EXPIRED || nowMs > Number(existingOrder.expiresAtMs);

      const bscRes = await bscClient.verifyTransaction({
        txHash: normalizedHash,
        expectedBaseUnits: existingOrder.amountDueBaseUnits,
        minConfirmations,
        orderCreatedAtMs: existingOrder.createdAtMs,
        orderExpiresAtMs: existingOrder.expiresAtMs,
      });

      if (bscRes.status === 'NOT_FOUND') {
        if (orderExpiredWallClock) {
          const updated = await store.mutate((data) => {
            const ord = data.orders[orderId];
            if (ord && ord.state === ORDER_STATES.AWAITING_PAYMENT) {
              const nowIso = new Date(nowFn()).toISOString();
              ord.state = ORDER_STATES.EXPIRED;
              ord.statusReason = 'INVOICE_EXPIRED';
              ord.updatedAt = nowIso;
              appendHistory(ord, ORDER_STATES.AWAITING_PAYMENT, ORDER_STATES.EXPIRED, 'INVOICE_EXPIRED', nowIso);
            }
            return ord ? structuredClone(ord) : null;
          });
          return {
            ok: false,
            reason: 'INVOICE_EXPIRED',
            order: updated,
            error: 'Order invoice expired without receiving USDT payment.',
          };
        }
        return {
          ok: false,
          reason: 'TX_NOT_FOUND',
          order: existingOrder,
          error: bscRes.error,
        };
      }

      if (bscRes.status === 'RETRYABLE_ERROR') {
        return {
          ok: false,
          retryable: true,
          reason: bscRes.reason,
          order: existingOrder,
          error: redactSecrets(bscRes.error, secrets),
        };
      }

      // If invoice had already transitioned to Expired, TX was mined after expiresAtMs,
      // or an unmined mempool TX was submitted after the invoice deadline -> route to Manual Review (never Paid).
      const lateAfterExpiry =
        existingOrder.state === ORDER_STATES.EXPIRED ||
        bscRes.status === 'EXPIRED_PAYMENT' ||
        (orderExpiredWallClock && bscRes.status === 'PENDING_MEMPOOL') ||
        (orderExpiredWallClock &&
          existingOrder.state === ORDER_STATES.AWAITING_PAYMENT &&
          bscRes.blockTimestampMs === null);

      if (
        lateAfterExpiry &&
        ['EXPIRED_PAYMENT', 'PENDING_MEMPOOL', 'CONFIRMING', 'UNDERPAID', 'OVERPAID', 'CONFIRMED'].includes(
          bscRes.status,
        )
      ) {
        const mutation = await store.mutate((data) => {
          const claim = data.claimedTxHashes[normalizedHash];
          if (claim && claim.orderId !== orderId) {
            return { conflict: true, claimedByOrderId: claim.orderId };
          }
          const ord = data.orders[orderId];
          if (!ord) {
            return { missing: true };
          }
          const nowIso = new Date(nowFn()).toISOString();
          const prevState = ord.state;
          data.claimedTxHashes[normalizedHash] = { orderId, claimedAt: nowIso };
          ord.txHash = normalizedHash;
          ord.state = ORDER_STATES.MANUAL_REVIEW;
          ord.statusReason = 'LATE_PAYMENT_AFTER_EXPIRATION';
          ord.manualReviewReason =
            'USDT transfer submitted or mined after invoice expiration; requires manual operator resolution.';
          ord.confirmations = Number(bscRes.confirmations || 0);
          if (bscRes.receivedBaseUnits !== undefined) {
            ord.receivedBaseUnits = bscRes.receivedBaseUnits.toString();
            ord.receivedUsdt = bscRes.receivedUsdt;
          }
          ord.updatedAt = nowIso;
          appendHistory(
            ord,
            prevState,
            ORDER_STATES.MANUAL_REVIEW,
            'LATE_PAYMENT_AFTER_EXPIRATION',
            nowIso,
            { txHash: normalizedHash },
          );
          return { order: structuredClone(ord) };
        });

        if (mutation.conflict) {
          return {
            ok: false,
            rejected: true,
            reason: 'TX_HASH_ALREADY_CLAIMED',
            claimedByOrderId: mutation.claimedByOrderId,
          };
        }
        return {
          ok: false,
          reason: 'LATE_PAYMENT_AFTER_EXPIRATION',
          order: mutation.order,
        };
      }

      // Fetch Binance deposit history ONLY after blockchain verification confirms exact amount & finality.
      let binanceEval = null;
      let binanceFetchMeta = null;
      if (bscRes.status === 'CONFIRMED') {
        if (!binanceClient || !binanceClient.isEnabled()) {
          binanceEval = {
            status: 'MANUAL_REVIEW',
            reason: 'BINANCE_API_DISABLED_AWAITING_OWNER_CONFIRMATION',
            error:
              'On-chain BSC quorum confirmed, but Binance read-only API is disabled; owner must confirm deposit or configure read-only Binance credentials.',
          };
        } else {
          const depRes = await binanceClient.fetchDeposits({
            startTime: Math.max(0, Number(existingOrder.createdAtMs) - MIN_CLOCK_SKEW_TOLERANCE_MS),
            limit: 200,
          });
          binanceFetchMeta = depRes;
          if (!depRes.ok) {
            binanceEval = {
              status:
                depRes.reason === 'BINANCE_TIMEOUT' || depRes.reason === 'BINANCE_NETWORK_ERROR'
                  ? 'RETRYABLE_PENDING'
                  : 'MANUAL_REVIEW',
              reason: depRes.reason || 'BINANCE_API_ERROR',
              error: redactSecrets(depRes.error, secrets),
            };
          } else {
            binanceEval = evaluateBinanceDepositForOrder(
              depRes.deposits,
              normalizedHash,
              existingOrder,
              snapBefore,
              receivingAddress,
            );
          }
        }
      }

      const commitResult = await store.mutate((data) => {
        const claim = data.claimedTxHashes[normalizedHash];
        if (claim && claim.orderId !== orderId) {
          return { conflict: true, claimedByOrderId: claim.orderId };
        }
        const ord = data.orders[orderId];
        if (!ord) {
          return { missing: true };
        }
        if (ord.state === ORDER_STATES.PAID) {
          return { idempotent: true, order: structuredClone(ord) };
        }

        const nowIso = new Date(nowFn()).toISOString();
        const prevState = ord.state;
        let nextState = ord.state;
        let statusReason = ord.statusReason;
        let manualReviewReason = ord.manualReviewReason;

        // Bind TXID to this order atomically to prevent concurrent double-submission races.
        data.claimedTxHashes[normalizedHash] = { orderId, claimedAt: nowIso };
        ord.txHash = normalizedHash;
        ord.confirmations = Number(bscRes.confirmations || 0);
        if (bscRes.receivedBaseUnits !== undefined) {
          ord.receivedBaseUnits = bscRes.receivedBaseUnits.toString();
          ord.receivedUsdt = bscRes.receivedUsdt;
        }

        if (bscRes.status === 'PENDING_MEMPOOL') {
          nextState = ORDER_STATES.PAYMENT_DETECTED;
          statusReason = bscRes.reason;
        } else if (bscRes.status === 'CONFIRMING') {
          nextState = ORDER_STATES.CONFIRMING;
          statusReason = bscRes.reason;
        } else if (bscRes.status === 'FAILED') {
          nextState = ORDER_STATES.FAILED;
          statusReason = bscRes.reason;
        } else if (bscRes.status === 'MANUAL_REVIEW') {
          nextState = ORDER_STATES.MANUAL_REVIEW;
          statusReason = bscRes.reason;
          manualReviewReason = redactSecrets(bscRes.error, secrets);
        } else if (bscRes.status === 'UNDERPAID') {
          ord.blockchainVerified = true;
          nextState = ORDER_STATES.UNDERPAID;
          statusReason = bscRes.reason;
        } else if (bscRes.status === 'OVERPAID') {
          ord.blockchainVerified = true;
          nextState = ORDER_STATES.OVERPAID;
          statusReason = bscRes.reason;
        } else if (bscRes.status === 'CONFIRMED') {
          ord.blockchainVerified = true;

          // Re-verify Binance claim inside exclusive store lock.
          if (binanceEval?.deposit) {
            const depClaim = data.claimedBinanceDeposits[binanceEval.deposit.depositId];
            if (depClaim && depClaim.orderId !== orderId) {
              nextState = ORDER_STATES.MANUAL_REVIEW;
              statusReason = 'BINANCE_DEPOSIT_ALREADY_CLAIMED';
              manualReviewReason = `Binance deposit ${binanceEval.deposit.depositId} already claimed by ${depClaim.orderId}.`;
              binanceEval = { status: 'REJECTED_ALREADY_CLAIMED' };
            }
          }

          if (binanceEval?.status === 'CONFIRMED') {
            data.claimedBinanceDeposits[binanceEval.deposit.depositId] = {
              orderId,
              txId: normalizedHash,
              claimedAt: nowIso,
            };
            ord.binanceDepositId = binanceEval.deposit.depositId;
            ord.binanceVerified = true;
            ord.manualReviewReason = null;
            nextState = ORDER_STATES.PAID;
            statusReason = 'DUAL_SOURCE_CONFIRMED';
          } else if (
            binanceEval?.status === 'NOT_FOUND' ||
            binanceEval?.status === 'PENDING' ||
            binanceEval?.status === 'RETRYABLE_PENDING'
          ) {
            ord.binanceVerified = false;
            nextState = ORDER_STATES.CONFIRMING;
            statusReason =
              binanceEval.status === 'NOT_FOUND'
                ? 'BLOCKCHAIN_CONFIRMED_AWAITING_BINANCE_CREDIT'
                : binanceEval.reason;
          } else if (binanceEval?.status === 'UNDERPAID') {
            ord.binanceVerified = false;
            nextState = ORDER_STATES.UNDERPAID;
            statusReason = binanceEval.reason;
          } else if (binanceEval?.status === 'OVERPAID') {
            ord.binanceVerified = false;
            nextState = ORDER_STATES.OVERPAID;
            statusReason = binanceEval.reason;
          } else if (binanceEval?.status === 'FAILED') {
            ord.binanceVerified = false;
            nextState = ORDER_STATES.FAILED;
            statusReason = binanceEval.reason;
          } else if (binanceEval?.status === 'REJECTED_ALREADY_CLAIMED') {
            // Already handled above
          } else {
            ord.binanceVerified = false;
            nextState = ORDER_STATES.MANUAL_REVIEW;
            statusReason = binanceEval?.reason || 'BINANCE_MANUAL_REVIEW_REQUIRED';
            manualReviewReason = redactSecrets(binanceEval?.error || statusReason, secrets);
          }
        }

        ord.state = nextState;
        ord.statusReason = statusReason;
        ord.manualReviewReason = manualReviewReason || null;
        ord.updatedAt = nowIso;

        if (prevState !== nextState || ord.history[ord.history.length - 1]?.reason !== statusReason) {
          appendHistory(ord, prevState, nextState, statusReason, nowIso, {
            txHash: normalizedHash,
            confirmations: ord.confirmations,
            receivedUsdt: ord.receivedUsdt,
            binanceEnabled: Boolean(binanceClient?.isEnabled()),
            binanceFetchOk: binanceFetchMeta ? binanceFetchMeta.ok : undefined,
          });
        }

        return { order: structuredClone(ord) };
      });

      if (commitResult.conflict) {
        return {
          ok: false,
          rejected: true,
          reason: 'TX_HASH_ALREADY_CLAIMED',
          claimedByOrderId: commitResult.claimedByOrderId,
        };
      }
      if (commitResult.missing) {
        return { ok: false, reason: 'ORDER_NOT_FOUND' };
      }

      const finalOrder = commitResult.order;
      const deliveryResult = await triggerDeliveryIfAuthorized(finalOrder);

      return {
        ok: finalOrder.state === ORDER_STATES.PAID,
        idempotent: Boolean(commitResult.idempotent),
        order: deliveryResult.order || finalOrder,
        delivery: deliveryResult,
        statusReason: finalOrder.statusReason,
      };
    },

    /**
     * Sweeps expired invoices, re-verifies in-progress transactions, and scans recent
     * BSC USDT incoming transfers to match unclaimed active orders cleanly.
     */
    async pollAndReconcile(opts = {}) {
      const expiredOrderIds = await expireStaleOrdersInStore();
      const snap = await store.readSnapshot();

      const checkedOrderIds = [];
      for (const order of Object.values(snap.orders)) {
        if (
          order &&
          order.txHash &&
          (order.state === ORDER_STATES.PAYMENT_DETECTED || order.state === ORDER_STATES.CONFIRMING)
        ) {
          await this.verifyOrderByTxHash(order.orderId, order.txHash);
          checkedOrderIds.push(order.orderId);
        }
      }

      const headRes = await bscClient.getLatestBlockNumber();
      if (!headRes.ok) {
        return {
          ok: false,
          reason: headRes.reason,
          error: redactSecrets(headRes.error, secrets),
          expiredOrderIds,
          checkedOrderIds,
          matchedOrders: [],
          ambiguousTxHashes: [],
        };
      }

      const toBlock = headRes.blockNumber;
      const fromBlock = opts.fromBlock !== undefined
        ? Math.max(0, Number(opts.fromBlock))
        : snap.lastScannedBlock !== null
          ? Math.max(0, Number(snap.lastScannedBlock) - 5) // overlap 5 blocks to catch shallow reorgs cleanly
          : Math.max(0, toBlock - DEFAULT_BLOCK_SCAN_LOOKBACK);

      const scanRes = await bscClient.scanIncomingDeposits({ fromBlock, toBlock });
      if (!scanRes.ok) {
        return {
          ok: false,
          reason: scanRes.reason,
          error: redactSecrets(scanRes.error, secrets),
          expiredOrderIds,
          checkedOrderIds,
          matchedOrders: [],
          ambiguousTxHashes: [],
        };
      }

      const postCheckSnap = await store.readSnapshot();
      const unclaimedTransfers = scanRes.transfers.filter(
        (t) => !postCheckSnap.claimedTxHashes[t.txHash],
      );

      // Group transfers cleanly in case multiple active orders compete for one deposit amount.
      const awaitingOrders = Object.values(postCheckSnap.orders).filter(
        (o) =>
          o &&
          o.state === ORDER_STATES.AWAITING_PAYMENT &&
          !o.txHash &&
          nowFn() <= Number(o.expiresAtMs),
      );

      const matchedOrders = [];
      const ambiguousTxHashes = [];

      for (const transfer of unclaimedTransfers) {
        const candidates = awaitingOrders.filter((ord) => {
          if (BigInt(ord.amountDueBaseUnits) !== transfer.amountBaseUnits) {
            return false;
          }
          if (transfer.blockTimestampMs === null) {
            return true;
          }
          return (
            transfer.blockTimestampMs + MIN_CLOCK_SKEW_TOLERANCE_MS >= Number(ord.createdAtMs) &&
            transfer.blockTimestampMs <= Number(ord.expiresAtMs)
          );
        });

        if (candidates.length === 1) {
          const target = candidates[0];
          const idx = awaitingOrders.indexOf(target);
          if (idx !== -1) {
            awaitingOrders.splice(idx, 1);
          }
          const outcome = await this.verifyOrderByTxHash(target.orderId, transfer.txHash);
          matchedOrders.push({
            orderId: target.orderId,
            txHash: transfer.txHash,
            state: outcome.order?.state || null,
          });
        } else if (candidates.length > 1) {
          ambiguousTxHashes.push(transfer.txHash);
          const nowIso = new Date(nowFn()).toISOString();
          await store.mutate((data) => {
            for (const cand of candidates) {
              const ord = data.orders[cand.orderId];
              if (ord && ord.state === ORDER_STATES.AWAITING_PAYMENT) {
                ord.state = ORDER_STATES.MANUAL_REVIEW;
                ord.statusReason = 'AMBIGUOUS_CONCURRENT_ORDER_MATCH';
                ord.manualReviewReason = `Incoming deposit ${transfer.txHash} matched multiple active orders.`;
                ord.updatedAt = nowIso;
                appendHistory(
                  ord,
                  ORDER_STATES.AWAITING_PAYMENT,
                  ORDER_STATES.MANUAL_REVIEW,
                  'AMBIGUOUS_CONCURRENT_ORDER_MATCH',
                  nowIso,
                  { txHash: transfer.txHash },
                );
              }
            }
          });
        }
      }

      await store.mutate((data) => {
        if (data.lastScannedBlock === null || toBlock > data.lastScannedBlock) {
          data.lastScannedBlock = toBlock;
        }
      });

      return {
        ok: true,
        scanSource: scanRes.source,
        bscscanStatus: scanRes.bscscanStatus,
        fromBlock,
        toBlock,
        expiredOrderIds,
        checkedOrderIds,
        matchedOrders,
        ambiguousTxHashes,
      };
    },

    /**
     * Explicit authenticated admin resolution for Manual Review, Underpaid, Overpaid, or Expired orders.
     */
    async resolveManualReview({ orderId, action, operatorNote, resolvedBy = 'admin' }) {
      if (!ALLOWED_MANUAL_RESOLUTIONS.includes(action)) {
        return {
          ok: false,
          reason: 'INVALID_RESOLUTION_ACTION',
          error: `Action must be one of: ${ALLOWED_MANUAL_RESOLUTIONS.join(', ')}`,
        };
      }
      const cleanNote = String(operatorNote || '').trim();
      if (!cleanNote || cleanNote.length > 500) {
        return {
          ok: false,
          reason: 'OPERATOR_NOTE_REQUIRED',
          error: 'operatorNote (1-500 chars) is required for manual audit resolution.',
        };
      }

      const result = await store.mutate((data) => {
        const ord = data.orders[orderId];
        if (!ord) {
          return { error: 'ORDER_NOT_FOUND' };
        }
        if (ord.state === ORDER_STATES.PAID) {
          return { error: 'ORDER_ALREADY_PAID', order: structuredClone(ord) };
        }

        const allowedSourceStates = new Set([
          ORDER_STATES.MANUAL_REVIEW,
          ORDER_STATES.UNDERPAID,
          ORDER_STATES.OVERPAID,
          ORDER_STATES.EXPIRED,
        ]);
        if (!allowedSourceStates.has(ord.state)) {
          return { error: 'INVALID_STATE_FOR_MANUAL_RESOLUTION', state: ord.state };
        }

        const nowIso = new Date(nowFn()).toISOString();
        const prevState = ord.state;
        const nextState =
          action === 'APPROVE_PAID'
            ? ORDER_STATES.PAID
            : action === 'MARK_FAILED'
              ? ORDER_STATES.FAILED
              : ORDER_STATES.EXPIRED;

        ord.state = nextState;
        ord.statusReason = `MANUAL_${action}`;
        ord.manualReviewReason = cleanNote;
        ord.updatedAt = nowIso;
        appendHistory(ord, prevState, nextState, `MANUAL_${action}`, nowIso, {
          resolvedBy: String(resolvedBy || 'admin'),
          operatorNote: cleanNote,
        });
        return { order: structuredClone(ord) };
      });

      if (result.error) {
        return {
          ok: false,
          reason: result.error,
          order: result.order,
        };
      }

      const delivery = await triggerDeliveryIfAuthorized(result.order);
      return {
        ok: true,
        order: delivery.order || result.order,
        delivery,
      };
    },
  };
}
