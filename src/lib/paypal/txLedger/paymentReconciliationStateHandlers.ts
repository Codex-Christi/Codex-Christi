import 'server-only';

import {
  ADMIN_NOTIFICATION_SEVERITY,
  enqueueAdminPaymentReconciliationNotification,
  sendPendingAdminRecoveryNotificationsForOrder,
} from '@/lib/paypal/txLedger/adminNotificationOutbox';
import type {
  PaymentLedgerRow,
  PayPalPaymentReconciliationResult,
} from '@/lib/paypal/txLedger/paymentReconciliationTypes';
import { refreshPaidOrderRecoveryProjectionSafely } from '@/lib/paypal/txLedger/paidOrderRecoveryProjection';
import { runPaidFulfillmentProcessing } from '@/lib/paypal/txLedger/runPaidFulfillmentProcessing';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import type { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';
import {
  buildReconciledAuthorizationLedgerDecision,
  buildReconciledCaptureLedgerDecision,
  buildMissingPaymentReferenceLedgerDecision,
  type PaymentReconciliationLedgerDecision,
} from '@/lib/paypal/txLedger/paymentReconciliationLedgerTransitions';
import { commitOptimisticLedgerTransition } from '@/lib/paypal/txLedger/optimisticLedgerTransition';

const { CRITICAL, WARNING } = ADMIN_NOTIFICATION_SEVERITY;

type ResultArgs = Pick<
  PayPalPaymentReconciliationResult,
  'ok' | 'action' | 'status' | 'message'
> &
  Partial<Pick<PayPalPaymentReconciliationResult, 'captureId' | 'authorizationStatus'>> & {
    row: PaymentLedgerRow;
    notificationCreated?: number;
  };

function result({
  row,
  ok,
  action,
  status,
  message,
  captureId = null,
  authorizationStatus = null,
  notificationCreated = 0,
}: ResultArgs): PayPalPaymentReconciliationResult {
  return {
    orderToken: row.orderToken,
    ok,
    action,
    previousStatus: row.status,
    status,
    message,
    captureId,
    authorizationStatus,
    notificationCreated,
  };
}

async function notifyAttention({
  row,
  errorCode,
  message,
  issueSummary,
  severity,
  resultArgs,
}: {
  row: PaymentLedgerRow;
  errorCode: string;
  message: string;
  issueSummary: string[];
  severity: typeof CRITICAL | typeof WARNING;
  resultArgs: Omit<ResultArgs, 'row' | 'message' | 'notificationCreated'>;
}) {
  const notification = await enqueueAdminPaymentReconciliationNotification({
    orderToken: row.orderToken,
    paypalOrderId: row.paypalOrderId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    ledgerStatus: row.status,
    errorCode,
    errorMessage: message,
    issueSummary,
    receiptLink: null,
    severity,
  });
  await sendPendingAdminRecoveryNotificationsForOrder(row.orderToken).catch((error) => {
    console.error('[paypal.payment_reconciliation.notification_send_failed]', {
      orderToken: row.orderToken,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return result({ row, message, ...resultArgs, notificationCreated: notification.created });
}

async function commitReconciliationDecision(
  {
    row,
    build,
  }: {
  row: PaymentLedgerRow;
  build: (latest: PaymentLedgerRow) => PaymentReconciliationLedgerDecision;
}) {
  const committed = await commitOptimisticLedgerTransition({
    load: () => paypalTxLedger.paypalIntent.findUnique({ where: { orderToken: row.orderToken } }),
    build,
    commit: async (latest, decision) => {
      const updated = await paypalTxLedger.paypalIntent.updateMany({
        where: {
          orderToken: row.orderToken,
          status: latest.status,
          updatedAt: latest.updatedAt,
        },
        data: decision.data as Prisma.PaypalIntentUpdateManyMutationInput,
      });
      return updated.count === 1;
    },
  });
  await refreshPaidOrderRecoveryProjectionSafely(row.orderToken);
  return committed;
}

function decisionResultArgs(decision: PaymentReconciliationLedgerDecision) {
  return {
    ok: decision.ok,
    action: decision.action,
    status: decision.status,
    captureId: decision.captureId,
    authorizationStatus: decision.authorizationStatus,
  };
}

function decisionSeverity(decision: PaymentReconciliationLedgerDecision) {
  return decision.severity === 'warning' ? WARNING : CRITICAL;
}

export async function handleReconciledCapture({
  row,
  payload,
  orderPayload,
  authorizationPayload,
}: {
  row: PaymentLedgerRow;
  payload: unknown;
  orderPayload?: unknown;
  authorizationPayload?: unknown;
}) {
  const committed = await commitReconciliationDecision({
    row,
    build: (latest) =>
      buildReconciledCaptureLedgerDecision({
        row: latest,
        payload,
        orderPayload,
        authorizationPayload,
      }),
  });
  const decision = committed.transition;
  if (!decision.shouldNotify) {
    return result({
      row: committed.row,
      message: decision.message,
      ...decisionResultArgs(decision),
    });
  }
  const notification = await notifyAttention({
    row: committed.row,
    errorCode: decision.errorCode,
    message: decision.message,
    issueSummary: decision.issueSummary,
    severity: decisionSeverity(decision),
    resultArgs: decisionResultArgs(decision),
  });

  if (!decision.shouldResumeFulfillment) return notification;

  try {
    await runPaidFulfillmentProcessing(committed.row.orderToken, {
      triggerDetail: 'capture_reconciled_and_fulfillment_resumed',
      triggerSource: 'payment_reconciliation',
    });
    return result({
      row: committed.row,
      ok: true,
      action: 'capture_reconciled_and_fulfillment_resumed',
      status: PAYPAL_LEDGER_STATUS.CAPTURED,
      message: decision.message,
      captureId: decision.captureId,
      notificationCreated: notification.notificationCreated,
    });
  } catch (error) {
    return result({
      row: committed.row,
      ok: false,
      action: 'capture_reconciled_fulfillment_failed',
      status: PAYPAL_LEDGER_STATUS.CAPTURED,
      message: error instanceof Error ? error.message : String(error),
      captureId: decision.captureId,
      notificationCreated: notification.notificationCreated,
    });
  }
}

export async function handleReconciledAuthorization({
  row,
  payload,
  orderPayload,
}: {
  row: PaymentLedgerRow;
  payload: unknown;
  orderPayload?: unknown;
}) {
  const now = new Date();
  const committed = await commitReconciliationDecision({
    row,
    build: (latest) =>
      buildReconciledAuthorizationLedgerDecision({
        row: latest,
        payload,
        orderPayload,
        now,
      }),
  });
  const decision = committed.transition;
  if (!decision.shouldNotify) {
    return result({
      row: committed.row,
      message: decision.message,
      ...decisionResultArgs(decision),
    });
  }
  return notifyAttention({
    row: committed.row,
    errorCode: decision.errorCode,
    message: decision.message,
    issueSummary: decision.issueSummary,
    severity: decisionSeverity(decision),
    resultArgs: decisionResultArgs(decision),
  });
}

export async function handleMissingPaymentReference(row: PaymentLedgerRow) {
  const committed = await commitReconciliationDecision({
    row,
    build: buildMissingPaymentReferenceLedgerDecision,
  });
  const decision = committed.transition;
  if (!decision.shouldNotify) {
    return result({
      row: committed.row,
      message: decision.message,
      ...decisionResultArgs(decision),
    });
  }
  return notifyAttention({
    row: committed.row,
    errorCode: decision.errorCode,
    message: decision.message,
    issueSummary: decision.issueSummary,
    severity: decisionSeverity(decision),
    resultArgs: decisionResultArgs(decision),
  });
}
