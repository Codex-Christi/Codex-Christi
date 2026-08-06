import type { CanonicalOrderSnapshotLedgerEnvelope } from '@/lib/paypal/orderSnapshot/canonicalize';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';

const PAYMENT_CHAIN_REQUIRED_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.COMPLETED,
  PAYPAL_LEDGER_STATUS.REFUNDED,
]);

/**
 * Pre-payment intents legitimately have no authorization or capture evidence. Reconciliation
 * becomes an admin/recovery concern only after PayPal reports a completed capture or the durable
 * ledger has entered a post-capture state.
 */
export function getCanonicalPaymentProjectionState(
  envelope: CanonicalOrderSnapshotLedgerEnvelope & {
    status: string;
    authorizePayload: unknown;
    capturePayload: unknown;
  },
) {
  const captureCompletion = getPayPalCaptureCompletion(envelope.capturePayload);
  const requiresPaymentChain =
    captureCompletion.status === 'COMPLETED' ||
    PAYMENT_CHAIN_REQUIRED_STATUSES.has(envelope.status);
  const paymentChain = requiresPaymentChain
    ? reconcileCanonicalPayPalPaymentChain(
        envelope,
        envelope.authorizePayload,
        envelope.capturePayload,
      )
    : null;

  return {
    captureCompletion,
    isPaid: captureCompletion.ok,
    requiresPaymentChain,
    paymentChain,
    paymentSafeForPostProcessing: paymentChain?.ok === true,
    paymentFailure: paymentChain && !paymentChain.ok ? paymentChain.reconciliation : null,
  };
}
