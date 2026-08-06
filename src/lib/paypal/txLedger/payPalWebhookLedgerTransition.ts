import type { CanonicalOrderSnapshotLedgerEnvelope } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  getDurableCanonicalPayPalCaptureMismatch,
  reconcileCanonicalPayPalAuthorization,
  reconcileCanonicalPayPalPaymentChain,
  type CanonicalPaymentReconciliationResult,
} from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import {
  asRecord,
  asString,
  attachPayPalAuthorizationEvidence,
  safeJson,
} from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import { getDurableAuthorizationMismatch } from '@/lib/paypal/txLedger/payPalAuthorizationLedgerTransition';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';

const POST_CAPTURE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.COMPLETED,
  PAYPAL_LEDGER_STATUS.REFUNDED,
]);

const AUTHORIZATION_ADVANCE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.INTENT_CREATING,
  PAYPAL_LEDGER_STATUS.INTENT_CREATED,
  PAYPAL_LEDGER_STATUS.AUTHORIZED,
]);

export type PayPalWebhookTransitionRow = CanonicalOrderSnapshotLedgerEnvelope & {
  status: string;
  authorizePayload: unknown;
  capturePayload: unknown;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  processingCompletedAt: Date | null;
};

export type PayPalWebhookLedgerTransition = {
  data: Record<string, unknown> | null;
  shouldScheduleFulfillment: boolean;
  reconciliationFailure: CanonicalPaymentReconciliationResult | null;
};

export type PayPalCaptureFailureLedgerTransition = {
  data: Record<string, unknown>;
  reconciliationFailure: CanonicalPaymentReconciliationResult | null;
};

function jsonEvidence(value: unknown) {
  if (value === undefined) return null;
  try {
    return safeJson(value);
  } catch {
    return null;
  }
}

function passiveEvent(eventType: string): PayPalWebhookLedgerTransition {
  return {
    data: { lastEventType: eventType },
    shouldScheduleFulfillment: false,
    reconciliationFailure: null,
  };
}

/**
 * Builds a route-level capture failure from the latest ledger row. Provider timeouts and other
 * stale request failures must not replace a completed capture, post-capture progress, or a
 * durable signed amount-mismatch incident that won a concurrent write.
 */
export function buildPayPalCaptureFailureLedgerTransition(
  row: PayPalWebhookTransitionRow,
  failure: { code: string; message: string },
): PayPalCaptureFailureLedgerTransition {
  const durableAuthorizationMismatch = getDurableAuthorizationMismatch(row);
  if (durableAuthorizationMismatch) {
    return {
      data: {
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: durableAuthorizationMismatch.errorCode,
        lastErrorMessage: row.lastErrorMessage ?? durableAuthorizationMismatch.reason,
      },
      reconciliationFailure: durableAuthorizationMismatch,
    };
  }

  const durableCaptureMismatch = getDurableCanonicalPayPalCaptureMismatch(row);
  if (durableCaptureMismatch) {
    return {
      data: {
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: durableCaptureMismatch.errorCode,
        lastErrorMessage: row.lastErrorMessage ?? durableCaptureMismatch.reason,
      },
      reconciliationFailure: durableCaptureMismatch,
    };
  }

  if (
    POST_CAPTURE_STATUSES.has(row.status) ||
    getPayPalCaptureCompletion(row.capturePayload).ok ||
    Boolean(row.processingCompletedAt)
  ) {
    return {
      data: { status: row.status },
      reconciliationFailure: null,
    };
  }

  return {
    data: {
      status: PAYPAL_LEDGER_STATUS.ERROR,
      lastErrorCode: failure.code,
      lastErrorMessage: failure.message,
    },
    reconciliationFailure: null,
  };
}

/**
 * Pure payment-evidence state transition. The route commits this with updatedAt compare-and-swap,
 * then rebuilds it from a fresh row on conflict so a concurrent authorization mismatch cannot be
 * overwritten by a matching capture.
 */
export function buildPayPalWebhookLedgerTransition(
  row: PayPalWebhookTransitionRow,
  eventType: string,
  webhookResource: unknown,
): PayPalWebhookLedgerTransition {
  switch (eventType) {
    case 'PAYMENT.AUTHORIZATION.CREATED': {
      const reconciliation = reconcileCanonicalPayPalAuthorization(row, webhookResource);
      const durableMismatch = reconciliation.ok ? getDurableAuthorizationMismatch(row) : null;
      if (durableMismatch) {
        return {
          data: {
            status: PAYPAL_LEDGER_STATUS.ERROR,
            ...(jsonEvidence(row.authorizePayload)
              ? { authorizePayload: jsonEvidence(row.authorizePayload) }
              : {}),
            lastEventType: eventType,
            lastErrorCode: durableMismatch.errorCode,
            lastErrorMessage: row.lastErrorMessage ?? durableMismatch.reason,
          },
          shouldScheduleFulfillment: false,
          reconciliationFailure: durableMismatch,
        };
      }
      const directAuthorizationId = asString(asRecord(webhookResource)?.id);
      const directEvidence = jsonEvidence(webhookResource);
      const durableAuthorizePayload =
        attachPayPalAuthorizationEvidence(row.authorizePayload, webhookResource) ?? directEvidence;
      const hasCompletedCapture = getPayPalCaptureCompletion(row.capturePayload).ok;
      const preservesAdvancedState =
        !AUTHORIZATION_ADVANCE_STATUSES.has(row.status) ||
        hasCompletedCapture ||
        Boolean(row.processingCompletedAt);
      const nextStatus = reconciliation.ok
        ? !preservesAdvancedState
          ? PAYPAL_LEDGER_STATUS.AUTHORIZED
          : row.status
        : PAYPAL_LEDGER_STATUS.ERROR;
      const shouldPersistAuthorizationEvidence = !reconciliation.ok || !preservesAdvancedState;
      const clearsPriorAuthorizationFailure =
        reconciliation.ok &&
        nextStatus === PAYPAL_LEDGER_STATUS.AUTHORIZED &&
        (row.lastErrorCode === 'CANONICAL_ORDER_SNAPSHOT_INVALID' ||
          row.lastErrorCode === 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH');

      return {
        data: {
          status: nextStatus,
          ...(shouldPersistAuthorizationEvidence && directAuthorizationId
            ? { paypalAuthorizationId: directAuthorizationId }
            : {}),
          ...(shouldPersistAuthorizationEvidence && durableAuthorizePayload
            ? { authorizePayload: durableAuthorizePayload }
            : {}),
          lastEventType: eventType,
          ...(reconciliation.ok
            ? clearsPriorAuthorizationFailure
              ? { lastErrorCode: null, lastErrorMessage: null }
              : {}
            : {
                lastErrorCode: reconciliation.errorCode,
                lastErrorMessage: reconciliation.reason,
              }),
        },
        shouldScheduleFulfillment: false,
        reconciliationFailure: reconciliation.ok ? null : reconciliation,
      };
    }

    case 'PAYMENT.CAPTURE.PENDING':
      if (
        POST_CAPTURE_STATUSES.has(row.status) ||
        getPayPalCaptureCompletion(row.capturePayload).ok
      ) {
        return passiveEvent(eventType);
      }
      return {
        data: {
          status: PAYPAL_LEDGER_STATUS.PENDING,
          ...(jsonEvidence(webhookResource)
            ? { capturePayload: jsonEvidence(webhookResource) }
            : {}),
          lastEventType: eventType,
          lastErrorCode: 'CAPTURE_NOT_COMPLETED',
          lastErrorMessage: getPayPalCaptureCompletion(webhookResource).reason,
        },
        shouldScheduleFulfillment: false,
        reconciliationFailure: null,
      };

    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      if (
        POST_CAPTURE_STATUSES.has(row.status) ||
        getPayPalCaptureCompletion(row.capturePayload).ok
      ) {
        return passiveEvent(eventType);
      }
      return {
        data: {
          status: PAYPAL_LEDGER_STATUS.ERROR,
          ...(jsonEvidence(webhookResource)
            ? { capturePayload: jsonEvidence(webhookResource) }
            : {}),
          lastEventType: eventType,
          lastErrorCode: 'CAPTURE_DECLINED',
          lastErrorMessage: 'PayPal capture declined',
        },
        shouldScheduleFulfillment: false,
        reconciliationFailure: null,
      };

    case 'PAYMENT.CAPTURE.REFUNDED':
      return {
        data: { status: PAYPAL_LEDGER_STATUS.REFUNDED, lastEventType: eventType },
        shouldScheduleFulfillment: false,
        reconciliationFailure: null,
      };

    case 'PAYMENT.CAPTURE.COMPLETED': {
      const storedCapture = getPayPalCaptureCompletion(row.capturePayload);
      const webhookCapture = getPayPalCaptureCompletion(webhookResource);
      if (!storedCapture.ok && !webhookCapture.ok) {
        return {
          data: {
            status: PAYPAL_LEDGER_STATUS.ERROR,
            lastEventType: eventType,
            lastErrorCode: 'CAPTURE_NOT_COMPLETED',
            lastErrorMessage: webhookCapture.reason,
          },
          shouldScheduleFulfillment: false,
          reconciliationFailure: null,
        };
      }

      const capturePayload = webhookCapture.ok ? webhookResource : row.capturePayload;
      const durableCapturePayload = jsonEvidence(capturePayload);
      const durableCaptureMismatch = getDurableCanonicalPayPalCaptureMismatch(row);
      if (durableCaptureMismatch) {
        return {
          data: {
            status: PAYPAL_LEDGER_STATUS.ERROR,
            ...(jsonEvidence(row.capturePayload)
              ? { capturePayload: jsonEvidence(row.capturePayload) }
              : {}),
            lastEventType: eventType,
            lastErrorCode: durableCaptureMismatch.errorCode,
            lastErrorMessage: row.lastErrorMessage ?? durableCaptureMismatch.reason,
          },
          shouldScheduleFulfillment: false,
          reconciliationFailure: durableCaptureMismatch,
        };
      }
      const paymentChain = reconcileCanonicalPayPalPaymentChain(
        row,
        row.authorizePayload,
        capturePayload,
      );
      if (!paymentChain.ok) {
        return {
          data: {
            status: PAYPAL_LEDGER_STATUS.ERROR,
            ...(durableCapturePayload ? { capturePayload: durableCapturePayload } : {}),
            lastEventType: eventType,
            lastErrorCode: paymentChain.reconciliation.errorCode,
            lastErrorMessage: paymentChain.reconciliation.reason,
          },
          shouldScheduleFulfillment: false,
          reconciliationFailure: paymentChain.reconciliation,
        };
      }

      const preservesAdvancedState = POST_CAPTURE_STATUSES.has(row.status);
      const nextStatus = preservesAdvancedState ? row.status : PAYPAL_LEDGER_STATUS.CAPTURED;
      return {
        data: {
          status: nextStatus,
          ...(!preservesAdvancedState && durableCapturePayload
            ? { capturePayload: durableCapturePayload }
            : {}),
          lastEventType: eventType,
          ...(!preservesAdvancedState ? { lastErrorCode: null, lastErrorMessage: null } : {}),
        },
        shouldScheduleFulfillment:
          !preservesAdvancedState &&
          nextStatus === PAYPAL_LEDGER_STATUS.CAPTURED &&
          !row.processingCompletedAt,
        reconciliationFailure: null,
      };
    }

    default:
      return { data: null, shouldScheduleFulfillment: false, reconciliationFailure: null };
  }
}
