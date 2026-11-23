/**
 * Order lifecycle states required by the VitalsScout automated USDT verification engine.
 * Exact string labels are preserved across store persistence, API responses, and audit logs.
 */
export const ORDER_STATES = Object.freeze({
  AWAITING_PAYMENT: 'Awaiting Payment',
  PAYMENT_DETECTED: 'Payment Detected',
  CONFIRMING: 'Confirming',
  PAID: 'Paid',
  UNDERPAID: 'Underpaid',
  OVERPAID: 'Overpaid',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
  MANUAL_REVIEW: 'Manual Review',
});

export const ALL_ORDER_STATES = Object.freeze(Object.values(ORDER_STATES));

export const ACTIVE_MATCHABLE_STATES = Object.freeze(
  new Set([
    ORDER_STATES.AWAITING_PAYMENT,
    ORDER_STATES.PAYMENT_DETECTED,
    ORDER_STATES.CONFIRMING,
  ]),
);

export const SLOT_RESERVING_STATES = Object.freeze(
  new Set([
    ORDER_STATES.AWAITING_PAYMENT,
    ORDER_STATES.PAYMENT_DETECTED,
    ORDER_STATES.CONFIRMING,
    ORDER_STATES.UNDERPAID,
    ORDER_STATES.OVERPAID,
    ORDER_STATES.MANUAL_REVIEW,
  ]),
);

export const TERMINAL_STATES = Object.freeze(
  new Set([ORDER_STATES.PAID, ORDER_STATES.EXPIRED, ORDER_STATES.FAILED]),
);

export const ALLOWED_MANUAL_RESOLUTIONS = Object.freeze([
  'APPROVE_PAID',
  'MARK_FAILED',
  'MARK_EXPIRED',
]);

/**
 * Automatic fulfillment is permanently disabled under the manual-payment policy.
 * @returns {false}
 */
export function canTriggerDelivery() {
  return false;
}
