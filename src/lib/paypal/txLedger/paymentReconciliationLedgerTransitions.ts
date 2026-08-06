import {
  getDurableCanonicalPayPalCaptureMismatch,
  reconcileCanonicalPayPalAuthorization,
  reconcileCanonicalPayPalPaymentChain,
} from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { getDurableAuthorizationMismatch } from '@/lib/paypal/txLedger/payPalAuthorizationLedgerTransition';
import {
  asRecord,
  asString,
  getProcessingAuthorizePayload,
  getRelatedAuthorizationId,
  getRelatedOrderId,
  safeJson,
} from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import type { PaymentLedgerRow } from '@/lib/paypal/txLedger/paymentReconciliationTypes';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';

export type PaymentReconciliationLedgerDecision = {
  data: Record<string, unknown>;
  errorCode: string;
  message: string;
  issueSummary: string[];
  severity: 'critical' | 'warning';
  ok: boolean;
  action: string;
  status: string;
  captureId: string | null;
  authorizationStatus: string | null;
  shouldResumeFulfillment: boolean;
  shouldNotify: boolean;
};

const CAPTURE_RECONCILIATION_ADVANCED_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.CAPTURED,
  PAYPAL_LEDGER_STATUS.RECEIPT_UPLOADED,
  PAYPAL_LEDGER_STATUS.PAYMENT_SAVED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_BLOCKED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_FAILED,
  PAYPAL_LEDGER_STATUS.FULFILLMENT_ATTENTION_REQUIRED,
  PAYPAL_LEDGER_STATUS.COMPLETED,
  PAYPAL_LEDGER_STATUS.REFUNDED,
]);

const AUTHORIZATION_RECONCILIATION_ADVANCE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.INTENT_CREATING,
  PAYPAL_LEDGER_STATUS.INTENT_CREATED,
  PAYPAL_LEDGER_STATUS.AUTHORIZED,
  PAYPAL_LEDGER_STATUS.ERROR,
]);

function captureLinkedData({
  row,
  payload,
  orderPayload,
  authorizationPayload,
  authorizePayload,
}: {
  row: PaymentLedgerRow;
  payload: unknown;
  orderPayload?: unknown;
  authorizationPayload?: unknown;
  authorizePayload?: unknown;
}) {
  const paypalOrderId =
    row.paypalOrderId ?? getRelatedOrderId(payload) ?? getRelatedOrderId(orderPayload);
  const paypalAuthorizationId =
    row.paypalAuthorizationId ??
    getRelatedAuthorizationId(payload) ??
    getRelatedAuthorizationId(orderPayload) ??
    getRelatedAuthorizationId(authorizationPayload);

  return {
    ...(paypalOrderId ? { paypalOrderId } : {}),
    ...(paypalAuthorizationId ? { paypalAuthorizationId } : {}),
    ...(authorizePayload ? { authorizePayload: safeJson(authorizePayload) } : {}),
    capturePayload: safeJson(payload),
  };
}

function statusForIncompleteCapture(status: string | null) {
  if (status === 'PENDING') return PAYPAL_LEDGER_STATUS.PENDING;
  if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') {
    return PAYPAL_LEDGER_STATUS.REFUNDED;
  }
  return PAYPAL_LEDGER_STATUS.ERROR;
}

export function buildReconciledCaptureLedgerDecision({
  row,
  payload,
  orderPayload,
  authorizationPayload,
}: {
  row: PaymentLedgerRow;
  payload: unknown;
  orderPayload?: unknown;
  authorizationPayload?: unknown;
}): PaymentReconciliationLedgerDecision {
  const completion = getPayPalCaptureCompletion(payload);
  const storedCapture = getPayPalCaptureCompletion(row.capturePayload);
  const durableMismatch = getDurableAuthorizationMismatch(row);
  if (durableMismatch) {
    const retainedCapturePayload = storedCapture.ok ? row.capturePayload : payload;
    return {
      data: {
        capturePayload: safeJson(retainedCapturePayload),
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: durableMismatch.errorCode,
        lastErrorMessage: row.lastErrorMessage ?? durableMismatch.reason,
      },
      errorCode: durableMismatch.errorCode,
      message: durableMismatch.reason,
      issueSummary: [
        completion.reason,
        durableMismatch.reason,
        'The completed capture was preserved as payment evidence, but fulfillment remains blocked.',
      ],
      severity: 'critical',
      ok: false,
      action: 'authorization_reconciled_amount_mismatch',
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: completion.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  const durableCaptureMismatch = getDurableCanonicalPayPalCaptureMismatch(row);
  if (durableCaptureMismatch) {
    const storedCapture = getPayPalCaptureCompletion(row.capturePayload);
    return {
      data: {
        capturePayload: safeJson(row.capturePayload),
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: durableCaptureMismatch.errorCode,
        lastErrorMessage: row.lastErrorMessage ?? durableCaptureMismatch.reason,
      },
      errorCode: durableCaptureMismatch.errorCode,
      message: durableCaptureMismatch.reason,
      issueSummary: [
        durableCaptureMismatch.reason,
        'The mismatched completed capture evidence was retained and fulfillment remains blocked.',
      ],
      severity: 'critical',
      ok: false,
      action: 'capture_reconciled_amount_mismatch',
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: storedCapture.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  if (
    !completion.ok &&
    (storedCapture.ok ||
      CAPTURE_RECONCILIATION_ADVANCED_STATUSES.has(row.status) ||
      Boolean(row.processingCompletedAt))
  ) {
    return {
      data: { status: row.status },
      errorCode: 'PAYPAL_CAPTURE_RECONCILIATION_STALE',
      message: 'A stale incomplete PayPal capture result did not replace newer ledger evidence.',
      issueSummary: [],
      severity: 'warning',
      ok: true,
      action: 'capture_reconciliation_stale_result_ignored',
      status: row.status,
      captureId: storedCapture.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: false,
    };
  }

  const authorizePayload = getProcessingAuthorizePayload({
    row,
    orderPayload,
    paymentPayload: payload,
    authorizationPayload,
  });
  const baseData = captureLinkedData({
    row,
    payload,
    orderPayload,
    authorizationPayload,
    authorizePayload,
  });

  if (!completion.ok) {
    const status = statusForIncompleteCapture(completion.status);
    return {
      data: {
        ...baseData,
        status,
        lastErrorCode: 'CAPTURE_NOT_COMPLETED',
        lastErrorMessage: completion.reason,
      },
      errorCode: 'CAPTURE_NOT_COMPLETED',
      message: completion.reason,
      issueSummary: [
        completion.reason,
        'Fulfillment remains blocked until PayPal capture is completed.',
      ],
      severity: 'critical',
      ok: false,
      action: 'capture_checked_incomplete',
      status,
      captureId: completion.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  const paymentChain = reconcileCanonicalPayPalPaymentChain(row, authorizePayload, payload);
  if (!paymentChain.ok) {
    const reconciliation = paymentChain.reconciliation;
    return {
      data: {
        ...baseData,
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: reconciliation.errorCode,
        lastErrorMessage: reconciliation.reason,
      },
      errorCode: reconciliation.errorCode,
      message: reconciliation.reason,
      issueSummary: [
        completion.reason,
        reconciliation.reason,
        'The completed capture was preserved as payment evidence, but fulfillment remains blocked.',
      ],
      severity: 'critical',
      ok: false,
      action: `${paymentChain.failedAt}_reconciled_amount_mismatch`,
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: completion.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  if (!authorizePayload) {
    const message =
      'PayPal capture is COMPLETED, but no PayPal order/customId payload is available for payment-save processing.';
    return {
      data: {
        ...baseData,
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: 'PAYPAL_CAPTURE_RECONCILED_AUTHORIZE_PAYLOAD_MISSING',
        lastErrorMessage: message,
      },
      errorCode: 'PAYPAL_CAPTURE_RECONCILED_AUTHORIZE_PAYLOAD_MISSING',
      message,
      issueSummary: [
        completion.reason,
        message,
        'Fulfillment remains blocked until PayPal order/customId evidence is restored.',
      ],
      severity: 'critical',
      ok: false,
      action: 'capture_reconciled_authorize_payload_missing',
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: completion.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  if (
    CAPTURE_RECONCILIATION_ADVANCED_STATUSES.has(row.status) ||
    Boolean(row.processingCompletedAt)
  ) {
    return {
      data: { status: row.status },
      errorCode: 'PAYPAL_CAPTURE_RECONCILED_ADVANCED_STATE',
      message: `PayPal capture evidence was reconciled; existing ledger state ${row.status} was retained.`,
      issueSummary: [],
      severity: 'warning',
      ok: true,
      action: 'capture_reconciled_advanced_state_preserved',
      status: row.status,
      captureId: completion.captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: false,
    };
  }

  return {
    data: {
      ...baseData,
      status: PAYPAL_LEDGER_STATUS.CAPTURED,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    errorCode: 'PAYPAL_CAPTURE_RECONCILED',
    message: completion.reason,
    issueSummary: [
      completion.reason,
      'Ledger capture payload was refreshed from PayPal.',
      'Server-side fulfillment processing was resumed.',
    ],
    severity: 'warning',
    ok: true,
    action: 'capture_reconciled_and_fulfillment_resumed',
    status: PAYPAL_LEDGER_STATUS.CAPTURED,
    captureId: completion.captureId,
    authorizationStatus: null,
    shouldResumeFulfillment: true,
    shouldNotify: true,
  };
}

export function buildReconciledAuthorizationLedgerDecision({
  row,
  payload,
  orderPayload,
  now = new Date(),
}: {
  row: PaymentLedgerRow;
  payload: unknown;
  orderPayload?: unknown;
  now?: Date;
}): PaymentReconciliationLedgerDecision {
  const authorization = asRecord(payload);
  const authorizationStatus = asString(authorization?.status)?.toUpperCase() ?? null;
  const durableMismatch = getDurableAuthorizationMismatch(row);
  if (durableMismatch) {
    return {
      data: {
        status: PAYPAL_LEDGER_STATUS.ERROR,
        ...(row.paypalAuthorizationId
          ? { paypalAuthorizationId: row.paypalAuthorizationId }
          : {}),
        authorizePayload: safeJson(row.authorizePayload),
        lastErrorCode: durableMismatch.errorCode,
        lastErrorMessage: row.lastErrorMessage ?? durableMismatch.reason,
      },
      errorCode: durableMismatch.errorCode,
      message: durableMismatch.reason,
      issueSummary: [
        durableMismatch.reason,
        'The authorization evidence was preserved, but capture and fulfillment remain blocked.',
      ],
      severity: 'critical',
      ok: false,
      action: 'authorization_checked_amount_mismatch',
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: null,
      authorizationStatus,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  const paymentReconciliation = reconcileCanonicalPayPalAuthorization(row, payload);
  const paypalOrderId =
    row.paypalOrderId ?? getRelatedOrderId(payload) ?? getRelatedOrderId(orderPayload);
  if (!paymentReconciliation.ok) {
    return {
      data: {
        ...(paypalOrderId ? { paypalOrderId } : {}),
        paypalAuthorizationId: row.paypalAuthorizationId ?? asString(authorization?.id),
        authorizePayload: safeJson(payload),
        status: PAYPAL_LEDGER_STATUS.ERROR,
        lastErrorCode: paymentReconciliation.errorCode,
        lastErrorMessage: paymentReconciliation.reason,
      },
      errorCode: paymentReconciliation.errorCode,
      message: paymentReconciliation.reason,
      issueSummary: [
        paymentReconciliation.reason,
        'The authorization evidence was preserved, but capture and fulfillment remain blocked.',
      ],
      severity: 'critical',
      ok: false,
      action: 'authorization_checked_amount_mismatch',
      status: PAYPAL_LEDGER_STATUS.ERROR,
      captureId: null,
      authorizationStatus,
      shouldResumeFulfillment: false,
      shouldNotify: true,
    };
  }

  const expirationTime = asString(authorization?.expirationTime);
  const expiresAt = expirationTime ? new Date(expirationTime) : null;
  const expired = Boolean(expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt <= now);
  const isOpen = authorizationStatus === 'CREATED' && !expired;
  const message = isOpen
    ? expirationTime
      ? `PayPal authorization is still open until ${expirationTime}. Manual capture or reauthorization review is required.`
      : 'PayPal authorization is still open. Manual capture or reauthorization review is required.'
    : authorizationStatus === 'CAPTURED'
      ? 'PayPal reports the authorization as captured, but no completed capture payload is stored locally.'
      : expired
        ? `PayPal authorization expired at ${expirationTime}. A new authorized payment is required before fulfillment.`
        : `PayPal authorization status is ${authorizationStatus ?? 'unknown'} and requires manual review.`;
  const errorCode = isOpen
    ? 'PAYPAL_AUTHORIZATION_STILL_OPEN'
    : authorizationStatus === 'CAPTURED'
      ? 'PAYPAL_AUTHORIZATION_CAPTURED_WITHOUT_CAPTURE_PAYLOAD'
      : authorizationStatus === 'VOIDED'
        ? 'PAYPAL_AUTHORIZATION_VOIDED'
        : authorizationStatus === 'DENIED'
          ? 'PAYPAL_AUTHORIZATION_DENIED'
          : expired
            ? 'PAYPAL_AUTHORIZATION_EXPIRED'
            : 'PAYPAL_AUTHORIZATION_RECONCILIATION_REQUIRED';
  const status = isOpen
    ? PAYPAL_LEDGER_STATUS.AUTHORIZED
    : authorizationStatus === 'PENDING'
      ? PAYPAL_LEDGER_STATUS.PENDING
      : PAYPAL_LEDGER_STATUS.ERROR;
  const preservesAdvancedState =
    !AUTHORIZATION_RECONCILIATION_ADVANCE_STATUSES.has(row.status) ||
    Boolean(row.processingCompletedAt);
  const durableAuthorizePayload = safeJson(
    getProcessingAuthorizePayload({ row, orderPayload, authorizationPayload: payload }) ?? payload,
  );

  if (preservesAdvancedState) {
    return {
      data: { status: row.status },
      errorCode: 'PAYPAL_AUTHORIZATION_RECONCILED_ADVANCED_STATE',
      message: `PayPal authorization evidence was reconciled; existing ledger state ${row.status} was retained.`,
      issueSummary: [],
      severity: 'warning',
      ok: true,
      action: 'authorization_reconciled_advanced_state_preserved',
      status: row.status,
      captureId: null,
      authorizationStatus,
      shouldResumeFulfillment: false,
      shouldNotify: false,
    };
  }

  return {
    data: {
      ...(paypalOrderId ? { paypalOrderId } : {}),
      paypalAuthorizationId: row.paypalAuthorizationId ?? asString(authorization?.id),
      authorizePayload: durableAuthorizePayload,
      status,
      lastErrorCode: errorCode,
      lastErrorMessage: message,
    },
    errorCode,
    message,
    issueSummary: isOpen
      ? [
          message,
          'The reconciliation scanner does not auto-capture authorizations.',
          'Review PayPal first, then decide whether manual capture or a new customer checkout is appropriate.',
        ]
      : [message, 'Fulfillment remains blocked until the PayPal payment state is resolved.'],
    severity: isOpen ? 'warning' : 'critical',
    ok: false,
    action: isOpen ? 'authorization_checked_open' : 'authorization_checked_attention_required',
    status,
    captureId: null,
    authorizationStatus,
    shouldResumeFulfillment: false,
    shouldNotify: true,
  };
}

export function buildMissingPaymentReferenceLedgerDecision(
  row: PaymentLedgerRow,
): PaymentReconciliationLedgerDecision {
  const hasNewerPaymentEvidence = Boolean(
    row.paypalAuthorizationId ||
      getRelatedAuthorizationId(row.authorizePayload) ||
      getPayPalCaptureCompletion(row.capturePayload).captureId ||
      CAPTURE_RECONCILIATION_ADVANCED_STATUSES.has(row.status) ||
      row.status === PAYPAL_LEDGER_STATUS.CAPTURED ||
      row.processingCompletedAt,
  );

  if (hasNewerPaymentEvidence) {
    return {
      data: { status: row.status },
      errorCode: 'PAYPAL_PAYMENT_REFERENCE_STALE_RESULT',
      message: 'A stale missing-reference result did not replace newer PayPal ledger evidence.',
      issueSummary: [],
      severity: 'warning',
      ok: true,
      action: 'missing_payment_reference_stale_result_ignored',
      status: row.status,
      captureId: getPayPalCaptureCompletion(row.capturePayload).captureId,
      authorizationStatus: null,
      shouldResumeFulfillment: false,
      shouldNotify: false,
    };
  }

  const message = 'No PayPal capture ID or authorization ID is available for reconciliation.';
  return {
    data: {
      status: PAYPAL_LEDGER_STATUS.ERROR,
      lastErrorCode: 'PAYPAL_PAYMENT_REFERENCE_MISSING',
      lastErrorMessage: message,
    },
    errorCode: 'PAYPAL_PAYMENT_REFERENCE_MISSING',
    message,
    issueSummary: [
      message,
      'Review the PayPal order from the PayPal dashboard before fulfillment.',
    ],
    severity: 'critical',
    ok: false,
    action: 'missing_payment_reference',
    status: PAYPAL_LEDGER_STATUS.ERROR,
    captureId: null,
    authorizationStatus: null,
    shouldResumeFulfillment: false,
    shouldNotify: true,
  };
}
