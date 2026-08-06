import 'server-only';

import {
  enqueueAdminPaymentReconciliationNotification,
  sendPendingAdminRecoveryNotificationsForOrder,
} from '@/lib/paypal/txLedger/adminNotificationOutbox';
import type { CanonicalPaymentReconciliationResult } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';

export type CanonicalPaymentFailureNotificationContext = {
  orderToken: string;
  paypalOrderId: string | null;
  customerName: string;
  customerEmail: string;
  receiptLink?: string | null;
};

/**
 * Creates a deduplicated payment-reconciliation alert without allowing email/outbox
 * infrastructure to hide the durable ledger failure that the caller already persisted.
 */
export async function notifyCanonicalPaymentFailure(
  context: CanonicalPaymentFailureNotificationContext,
  reconciliation: CanonicalPaymentReconciliationResult,
) {
  if (reconciliation.ok) return;

  try {
    await enqueueAdminPaymentReconciliationNotification({
      orderToken: context.orderToken,
      paypalOrderId: context.paypalOrderId,
      customerName: context.customerName,
      customerEmail: context.customerEmail,
      ledgerStatus: PAYPAL_LEDGER_STATUS.ERROR,
      errorCode: reconciliation.errorCode,
      errorMessage: reconciliation.reason,
      issueSummary: [
        reconciliation.reason,
        reconciliation.evidenceKind === 'capture'
          ? 'PayPal capture evidence was preserved. Do not fulfill or recapture automatically.'
          : 'PayPal authorization evidence requires review. Do not capture automatically.',
      ],
      receiptLink: context.receiptLink ?? null,
    });
    await sendPendingAdminRecoveryNotificationsForOrder(context.orderToken);
  } catch (error) {
    console.error('[paypal.canonical_payment_reconciliation.notification_failed]', {
      orderToken: context.orderToken,
      errorCode: reconciliation.errorCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
