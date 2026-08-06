import type { CanonicalOrderSnapshotLedgerEnvelope } from '@/lib/paypal/orderSnapshot/canonicalize';
import {
  reconcileCanonicalPayPalAuthorization,
  type CanonicalPaymentReconciliationResult,
} from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';
import {
  getRelatedAuthorizationId,
  safeJson,
} from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';

const AUTHORIZATION_ADVANCE_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.INTENT_CREATING,
  PAYPAL_LEDGER_STATUS.INTENT_CREATED,
  PAYPAL_LEDGER_STATUS.AUTHORIZED,
  PAYPAL_LEDGER_STATUS.ERROR,
]);

export type PayPalAuthorizationTransitionRow = CanonicalOrderSnapshotLedgerEnvelope & {
  status: string;
  paypalAuthorizationId: string | null;
  authorizePayload: unknown;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type PayPalAuthorizationLedgerTransition = {
  data: Record<string, unknown>;
  reconciliation: CanonicalPaymentReconciliationResult;
  reconciliationFailure: CanonicalPaymentReconciliationResult | null;
};

export function getDurableAuthorizationMismatch(
  row: CanonicalOrderSnapshotLedgerEnvelope & { authorizePayload: unknown },
) {
  // A fresh canonical intent has no authorization payload yet, so its expected "amount missing"
  // result is not an incident. Once provider evidence is stored, derive the durable mismatch from
  // that evidence instead of trusting mutable error-label text.
  if (row.authorizePayload === null || row.authorizePayload === undefined) return null;

  const reconciliation = reconcileCanonicalPayPalAuthorization(row, row.authorizePayload);
  return !reconciliation.ok &&
    reconciliation.errorCode === 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH'
    ? reconciliation
    : null;
}

/**
 * Builds authorization persistence from the latest ledger row. Once a canonical authorization
 * mismatch is durable, a contradictory success response cannot silently replace its evidence;
 * reconciliation/admin review must resolve that incident first.
 */
export function buildPayPalAuthorizationLedgerTransition(
  row: PayPalAuthorizationTransitionRow,
  payload: unknown,
): PayPalAuthorizationLedgerTransition {
  const reconciliation = reconcileCanonicalPayPalAuthorization(row, payload);
  const durableMismatch = reconciliation.ok ? getDurableAuthorizationMismatch(row) : null;

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
      reconciliation: durableMismatch,
      reconciliationFailure: durableMismatch,
    };
  }

  const paypalAuthorizationId = getRelatedAuthorizationId(payload);
  const nextStatus = reconciliation.ok
    ? AUTHORIZATION_ADVANCE_STATUSES.has(row.status)
      ? PAYPAL_LEDGER_STATUS.AUTHORIZED
      : row.status
    : PAYPAL_LEDGER_STATUS.ERROR;
  const clearsPriorError = reconciliation.ok && nextStatus === PAYPAL_LEDGER_STATUS.AUTHORIZED;

  return {
    data: {
      status: nextStatus,
      ...(paypalAuthorizationId ? { paypalAuthorizationId } : {}),
      authorizePayload: safeJson(payload),
      ...(reconciliation.ok
        ? clearsPriorError
          ? { lastErrorCode: null, lastErrorMessage: null }
          : {}
        : {
            lastErrorCode: reconciliation.errorCode,
            lastErrorMessage: reconciliation.reason,
          }),
    },
    reconciliation,
    reconciliationFailure: reconciliation.ok ? null : reconciliation,
  };
}

export function buildPayPalAuthorizationFailureLedgerTransition(
  row: PayPalAuthorizationTransitionRow,
  failure: { code: string; message: string },
) {
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
      reconciliationFailure: durableMismatch,
    };
  }

  const canRecordAuthorizationFailure =
    row.status === PAYPAL_LEDGER_STATUS.INTENT_CREATING ||
    row.status === PAYPAL_LEDGER_STATUS.INTENT_CREATED ||
    row.status === PAYPAL_LEDGER_STATUS.ERROR;

  return {
    data: canRecordAuthorizationFailure
      ? {
          status: PAYPAL_LEDGER_STATUS.ERROR,
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
        }
      : { status: row.status },
    reconciliationFailure: null,
  };
}
