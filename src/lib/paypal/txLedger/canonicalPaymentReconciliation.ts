import {
  parseCanonicalOrderSnapshotFromLedger,
  type CanonicalOrderSnapshotLedgerEnvelope,
} from '@/lib/paypal/orderSnapshot/canonicalize';
import type { CanonicalOrderSnapshot } from '@/lib/paypal/orderSnapshot/types';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import {
  reconcilePayPalMoney,
  type PayPalMoney,
  type PayPalMoneyReconciliation,
} from '@/lib/paypal/txLedger/payPalMoneyReconciliation';

type JsonRecord = Record<string, unknown>;

export type CanonicalPaymentEvidenceKind = 'authorization' | 'capture';

export type CanonicalPaymentReconciliationErrorCode =
  | 'CANONICAL_ORDER_SNAPSHOT_INVALID'
  | 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH'
  | 'PAYPAL_CAPTURE_AMOUNT_MISMATCH';

export type CanonicalPaymentReconciliationResult =
  | {
      ok: true;
      mode: 'legacy';
      evidenceKind: CanonicalPaymentEvidenceKind;
      snapshot: null;
      money: null;
      errorCode: null;
      reason: string;
    }
  | {
      ok: true;
      mode: 'canonical';
      evidenceKind: CanonicalPaymentEvidenceKind;
      snapshot: CanonicalOrderSnapshot;
      money: PayPalMoneyReconciliation;
      errorCode: null;
      reason: string;
    }
  | {
      ok: false;
      mode: 'canonical';
      evidenceKind: CanonicalPaymentEvidenceKind;
      snapshot: CanonicalOrderSnapshot | null;
      money: PayPalMoneyReconciliation | null;
      errorCode: CanonicalPaymentReconciliationErrorCode;
      reason: string;
    };

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function getPath(root: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined;
    return asRecord(current)?.[key];
  }, root);
}

function getMoneyAtPath(payload: unknown, path: Array<string | number>): PayPalMoney | null {
  const amount = asRecord(getPath(payload, path));
  const value = typeof amount?.value === 'string' ? amount.value : null;
  const currencyValue = amount?.currencyCode ?? amount?.currency_code ?? amount?.currency;
  const currency = typeof currencyValue === 'string' ? currencyValue : null;

  return value && currency ? { value, currency } : null;
}

/**
 * Reads PayPal authorization evidence in both server-SDK order envelopes and direct
 * authorization resources used by webhooks/reconciliation.
 */
export function getPayPalAuthorizationMoney(payload: unknown): PayPalMoney | null {
  const amountPaths: Array<Array<string | number>> = [
    ['purchaseUnits', 0, 'payments', 'authorizations', 0, 'amount'],
    ['purchase_units', 0, 'payments', 'authorizations', 0, 'amount'],
    ['amount'],
  ];

  for (const path of amountPaths) {
    const money = getMoneyAtPath(payload, path);
    if (money) return money;
  }

  return null;
}

export function getPayPalCaptureMoney(payload: unknown): PayPalMoney | null {
  const amount = getPayPalCaptureCompletion(payload).amount;
  return amount ? { value: amount.value, currency: amount.currency } : null;
}

function mismatchErrorCode(
  evidenceKind: CanonicalPaymentEvidenceKind,
): CanonicalPaymentReconciliationErrorCode {
  return evidenceKind === 'authorization'
    ? 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH'
    : 'PAYPAL_CAPTURE_AMOUNT_MISMATCH';
}

function reconcileCanonicalPaymentEvidence(args: {
  envelope: CanonicalOrderSnapshotLedgerEnvelope;
  evidenceKind: CanonicalPaymentEvidenceKind;
  actual: PayPalMoney | null;
}): CanonicalPaymentReconciliationResult {
  let parsedEnvelope;
  try {
    parsedEnvelope = parseCanonicalOrderSnapshotFromLedger(args.envelope);
  } catch (error) {
    return {
      ok: false,
      mode: 'canonical',
      evidenceKind: args.evidenceKind,
      snapshot: null,
      money: null,
      errorCode: 'CANONICAL_ORDER_SNAPSHOT_INVALID',
      reason:
        error instanceof Error
          ? error.message
          : 'Canonical order snapshot ledger evidence is invalid.',
    };
  }

  if (parsedEnvelope.mode === 'legacy') {
    return {
      ok: true,
      mode: 'legacy',
      evidenceKind: args.evidenceKind,
      snapshot: null,
      money: null,
      errorCode: null,
      reason: 'Legacy order has no canonical snapshot; existing payment behavior is preserved.',
    };
  }

  const money = reconcilePayPalMoney(parsedEnvelope.snapshot.total, args.actual);
  if (!money.ok) {
    return {
      ok: false,
      mode: 'canonical',
      evidenceKind: args.evidenceKind,
      snapshot: parsedEnvelope.snapshot,
      money,
      errorCode: mismatchErrorCode(args.evidenceKind),
      reason: money.reason,
    };
  }

  return {
    ok: true,
    mode: 'canonical',
    evidenceKind: args.evidenceKind,
    snapshot: parsedEnvelope.snapshot,
    money,
    errorCode: null,
    reason: money.reason,
  };
}

export function reconcileCanonicalPayPalAuthorization(
  envelope: CanonicalOrderSnapshotLedgerEnvelope,
  payload: unknown,
) {
  return reconcileCanonicalPaymentEvidence({
    envelope,
    evidenceKind: 'authorization',
    actual: getPayPalAuthorizationMoney(payload),
  });
}

export function reconcileCanonicalPayPalCapture(
  envelope: CanonicalOrderSnapshotLedgerEnvelope,
  payload: unknown,
) {
  return reconcileCanonicalPaymentEvidence({
    envelope,
    evidenceKind: 'capture',
    actual: getPayPalCaptureMoney(payload),
  });
}

export function getDurableCanonicalPayPalCaptureMismatch(
  envelope: CanonicalOrderSnapshotLedgerEnvelope & { capturePayload: unknown },
) {
  if (envelope.capturePayload === null || envelope.capturePayload === undefined) return null;
  if (getPayPalCaptureCompletion(envelope.capturePayload).status !== 'COMPLETED') return null;

  const reconciliation = reconcileCanonicalPayPalCapture(envelope, envelope.capturePayload);
  return !reconciliation.ok && reconciliation.errorCode === 'PAYPAL_CAPTURE_AMOUNT_MISMATCH'
    ? reconciliation
    : null;
}

/**
 * Final shared payment gate for post-capture work. A matching capture can never hide a missing,
 * corrupt, or mismatched authorization for a canonical order.
 */
export function reconcileCanonicalPayPalPaymentChain(
  envelope: CanonicalOrderSnapshotLedgerEnvelope,
  authorizationPayload: unknown,
  capturePayload: unknown,
) {
  const authorization = reconcileCanonicalPayPalAuthorization(envelope, authorizationPayload);
  if (!authorization.ok) {
    return {
      ok: false as const,
      failedAt: 'authorization' as const,
      reconciliation: authorization,
      authorization,
      capture: null,
    };
  }

  const capture = reconcileCanonicalPayPalCapture(envelope, capturePayload);
  if (!capture.ok) {
    return {
      ok: false as const,
      failedAt: 'capture' as const,
      reconciliation: capture,
      authorization,
      capture,
    };
  }

  return {
    ok: true as const,
    failedAt: null,
    reconciliation: null,
    authorization,
    capture,
    snapshot: capture.snapshot,
  };
}
