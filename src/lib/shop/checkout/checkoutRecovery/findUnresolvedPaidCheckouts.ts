import 'server-only';

import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { isCompletedPayPalCapture } from '@/lib/paypal/txLedger/captureCompletion';
import { normalizeRecoveryEmail } from './recoveryOtpUtils';
import { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';

const UNRESOLVED_PAID_STATUSES = [
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.ERROR,
] as const;

const RECOVERY_LEDGER_ROW_SELECT = {
  orderToken: true,
  status: true,
  cartSnapshot: true,
  shippingSnapshot: true,
  canonicalOrderSnapshot: true,
  canonicalOrderSnapshotVersion: true,
  canonicalOrderSnapshotHash: true,
  authorizePayload: true,
  capturePayload: true,
  receiptLink: true,
  receiptFile: true,
  djangoPaymentSaveCustomId: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaypalIntentSelect;

async function findUnresolvedPaidCheckoutsByEmailFromLegacyLedger(normalizedEmail: string) {
  const rows = await paypalTxLedger.paypalIntent.findMany({
    where: {
      customerEmail: normalizedEmail,
      processingCompletedAt: null,
      capturePayload: {
        not: Prisma.AnyNull,
      },
      djangoOrderIntentOrderId: {
        not: null,
      },
      djangoOrderIntentVerifyPayload: {
        not: Prisma.AnyNull,
      },
      status: {
        in: [...UNRESOLVED_PAID_STATUSES],
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 10,
    select: RECOVERY_LEDGER_ROW_SELECT,
  });

  return rows.filter((row) => isCompletedPayPalCapture(row.capturePayload)).slice(0, 3);
}

export async function findUnresolvedPaidCheckoutsByEmail(email: string) {
  const normalizedEmail = normalizeRecoveryEmail(email);

  try {
    const projections = await paypalTxLedger.paidOrderRecoveryProjection.findMany({
      where: {
        customerEmail: normalizedEmail,
        isCustomerProtectionVisible: true,
      },
      orderBy: [{ paypalIntentUpdatedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 3,
      select: {
        orderToken: true,
      },
    });

    if (projections.length) {
      const orderTokens = projections.map((projection) => projection.orderToken);
      const rows = await paypalTxLedger.paypalIntent.findMany({
        where: {
          orderToken: {
            in: orderTokens,
          },
        },
        select: RECOVERY_LEDGER_ROW_SELECT,
      });
      const rowByOrderToken = new Map(rows.map((row) => [row.orderToken, row]));

      return orderTokens
        .map((orderToken) => rowByOrderToken.get(orderToken))
        .filter((row): row is (typeof rows)[number] => Boolean(row));
    }

    const projectionCountForEmail = await paypalTxLedger.paidOrderRecoveryProjection.count({
      where: {
        customerEmail: normalizedEmail,
      },
    });

    return projectionCountForEmail > 0
      ? []
      : findUnresolvedPaidCheckoutsByEmailFromLegacyLedger(normalizedEmail);
  } catch (error) {
    console.error('[checkout-recovery.projection_lookup_failed]', {
      error: error instanceof Error ? error.message : String(error),
    });

    return findUnresolvedPaidCheckoutsByEmailFromLegacyLedger(normalizedEmail);
  }
}
