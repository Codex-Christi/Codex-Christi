import { NextResponse } from 'next/server';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { getCanonicalPaymentProjectionState } from '@/lib/paypal/txLedger/canonicalPaymentProjectionState';

type PageProps = {
  params: Promise<{ orderToken: string }>;
};

const CUSTOMER_RECOVERY_GRACE_MS = 45_000;

const CUSTOMER_RECOVERY_LEDGER_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.ERROR,
]);

function getPaidAmountLabel(capturePayload: unknown) {
  const completion = getPayPalCaptureCompletion(capturePayload);
  // A field labeled "Paid" must come from completed capture evidence, never an authorization,
  // pending capture, or the expected canonical order total.
  if (!completion.ok || !completion.amount) return null;

  const value = Number(completion.amount.value);
  if (!Number.isFinite(value)) {
    return `${completion.amount.currency} ${completion.amount.value}`;
  }

  try {
    return new Intl.NumberFormat('en', {
      currency: completion.amount.currency,
      style: 'currency',
    }).format(value);
  } catch {
    return `${completion.amount.currency} ${completion.amount.value}`;
  }
}

function getCustomerRecoveryReason(status: string) {
  if (status === PAYPAL_LEDGER_STATUS.CAPTURED) {
    return 'Payment was captured, but receipt preparation did not finish automatically.';
  }

  if (status === PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED) {
    return 'Receipt was prepared, but payment-save or fulfillment handoff did not finish.';
  }

  if (status === PAYPAL_LEDGER_STATUS.PAYMENT_SAVED) {
    return 'Payment was saved, but fulfillment handoff did not finish.';
  }

  if (
    status === PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED ||
    status === PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED ||
    status === PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED
  ) {
    return 'Fulfillment needs review before the order can move forward.';
  }

  return 'Post-payment processing needs review before the order can move forward.';
}

export async function GET(_req: Request, { params }: PageProps) {
  const { orderToken } = await params;

  const row = await paypalTxLedger.paypalIntent.findUnique({ where: { orderToken } });
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const paymentState = getCanonicalPaymentProjectionState(row);
  const { captureCompletion, paymentFailure } = paymentState;
  const unresolvedAgeMs = Date.now() - row.updatedAt.getTime();
  const isResolved =
    !paymentFailure &&
    (row.status === PAYPAL_LEDGER_STATUS.COMPLETED ||
      row.status === PAYPAL_LEDGER_STATUS.REFUNDED ||
      Boolean(row.processingCompletedAt));
  const isCustomerProtectionVisible =
    captureCompletion.ok &&
    !isResolved &&
    (Boolean(paymentFailure) ||
      (CUSTOMER_RECOVERY_LEDGER_STATUSES.has(row.status) &&
        unresolvedAgeMs >= CUSTOMER_RECOVERY_GRACE_MS));
  const effectiveStatus = paymentFailure ? PAYPAL_LEDGER_STATUS.ERROR : row.status;
  const recoveryReason = paymentFailure
    ? 'Your payment was received, but its amount requires review before fulfillment.'
    : getCustomerRecoveryReason(effectiveStatus);

  return NextResponse.json({
    orderToken: row.orderToken,
    status: effectiveStatus,
    lastEventType: row.lastEventType,
    receiptLink: row.receiptLink,
    receiptFile: row.receiptFile,
    djangoPaymentSaveCustomId: row.djangoPaymentSaveCustomId,
    processingCompletedAt: row.processingCompletedAt,
    paidAmountLabel: getPaidAmountLabel(row.capturePayload),
    customerRecoveryStatus: isCustomerProtectionVisible ? 'paid_unresolved' : null,
    recoveryReason: isCustomerProtectionVisible ? recoveryReason : null,
    updatedAt: row.updatedAt,
    error: paymentFailure
      ? { code: paymentFailure.errorCode, message: recoveryReason }
      : row.lastErrorMessage
        ? { code: row.lastErrorCode, message: row.lastErrorMessage }
        : null,
  });
}
