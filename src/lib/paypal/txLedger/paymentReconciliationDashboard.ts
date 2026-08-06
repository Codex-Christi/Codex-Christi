import 'server-only';

import { formatDistanceToNowStrict } from 'date-fns';
import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { asRecord, asString, getPath } from '@/lib/paypal/txLedger/paymentReconciliationEvidence';
import {
  getRecoveryScannerBatchSize,
  getRecoveryScannerMinAgeMinutes,
  isRecoveryScannerEnabled,
} from '@/lib/paypal/txLedger/processingPolicy';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import { paypalTxLedger } from '@/lib/prisma/shop/paypal/paypalTxLedger';
import type {
  PaymentLedgerRow,
  PayPalPaymentReconciliationDashboard,
  PayPalPaymentReconciliationRow,
} from '@/lib/paypal/txLedger/paymentReconciliationTypes';
import { Prisma } from '@/lib/prisma/shop/paypal/txLedger/generated/paypalTxLedger/client';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';

const DEFAULT_MIN_AGE_MINUTES = 15;
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 25;
const PAYMENT_ATTENTION_STATUSES = new Set<string>([
  PAYPAL_LEDGER_STATUS.AUTHORIZED,
  PAYPAL_LEDGER_STATUS.PENDING,
  PAYPAL_LEDGER_STATUS.ERROR,
]);
const PAYMENT_RECONCILIATION_ERROR_CODES = new Set<string>([
  'AUTHORIZE_FAILED',
  'AUTHORIZE_PERSIST_FAILED',
  'AUTHORIZE_RESYNC_FAILED',
  'CAPTURE_FAILED',
  'CAPTURE_NOT_COMPLETED',
  'CAPTURE_PERSIST_FAILED',
  'CANONICAL_ORDER_SNAPSHOT_INVALID',
  'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH',
  'PAYPAL_CAPTURE_AMOUNT_MISMATCH',
  'PAYPAL_CAPTURE_RECONCILED_AUTHORIZE_PAYLOAD_MISSING',
  'PAYPAL_AUTHORIZATION_CAPTURED_WITHOUT_CAPTURE_PAYLOAD',
  'PAYPAL_AUTHORIZATION_DENIED',
  'PAYPAL_AUTHORIZATION_EXPIRED',
  'PAYPAL_AUTHORIZATION_RECONCILIATION_REQUIRED',
  'PAYPAL_AUTHORIZATION_STILL_OPEN',
  'PAYPAL_AUTHORIZATION_VOIDED',
  'PAYPAL_CAPTURE_RECONCILIATION_REQUIRED',
  'PAYPAL_PAYMENT_REFERENCE_MISSING',
]);

export const PAYMENT_RECONCILIATION_ROW_SELECT = {
  orderToken: true,
  paypalOrderId: true,
  paypalAuthorizationId: true,
  customerName: true,
  customerEmail: true,
  initialCurrency: true,
  canonicalOrderSnapshot: true,
  canonicalOrderSnapshotVersion: true,
  canonicalOrderSnapshotHash: true,
  authorizePayload: true,
  capturePayload: true,
  status: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  processingCompletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaypalIntentSelect;

function fallback<T>(fn: () => T, value: T) {
  try {
    return fn();
  } catch {
    return value;
  }
}

export const clampPaymentReconciliationBatchSize = (size: number) =>
  Math.min(Math.max(size, 1), MAX_BATCH_SIZE);
export const getPaymentReconciliationScannerMinAgeMinutes = () =>
  fallback(getRecoveryScannerMinAgeMinutes, DEFAULT_MIN_AGE_MINUTES);
export const getPaymentReconciliationScannerBatchSize = () =>
  fallback(getRecoveryScannerBatchSize, DEFAULT_BATCH_SIZE);
export const getPaymentReconciliationScannerEnabled = () =>
  fallback(isRecoveryScannerEnabled, false);

function getCaptureAmountLabel(row: PaymentLedgerRow) {
  const completion = getPayPalCaptureCompletion(row.capturePayload);
  if (completion.amount) return `${completion.amount.value} ${completion.amount.currency}`;

  const amount = asRecord(getPath(row.authorizePayload, ['purchaseUnits', 0, 'amount']));
  const value = asString(amount?.value);
  const currency = asString(amount?.currencyCode) ?? asString(amount?.currency_code);
  return value && currency ? `${value} ${currency}` : row.initialCurrency ? `- ${row.initialCurrency}` : '-';
}

function getLocalReason(row: PaymentLedgerRow) {
  const completion = getPayPalCaptureCompletion(row.capturePayload);
  if (completion.captureId && !completion.ok) return completion.reason;
  if (row.paypalAuthorizationId && !completion.ok) {
    return 'PayPal authorization exists, but the ledger does not contain a verified completed capture.';
  }
  if (row.lastErrorCode && PAYMENT_RECONCILIATION_ERROR_CODES.has(row.lastErrorCode)) {
    return row.lastErrorMessage ?? `Payment-stage error ${row.lastErrorCode} requires reconciliation.`;
  }
  return 'Ledger payment state is stale and needs PayPal verification.';
}

function getRecommendedAction(row: PaymentLedgerRow) {
  const completion = getPayPalCaptureCompletion(row.capturePayload);
  if (
    row.lastErrorCode === 'CANONICAL_ORDER_SNAPSHOT_INVALID' ||
    row.lastErrorCode === 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH' ||
    row.lastErrorCode === 'PAYPAL_CAPTURE_AMOUNT_MISMATCH'
  ) {
    return 'Do not capture or fulfill. Review the canonical order and PayPal amount evidence.';
  }
  if (completion.captureId && !completion.ok) {
    return 'Check capture status with PayPal and block fulfillment until capture is completed.';
  }
  if (row.paypalAuthorizationId) {
    return 'Check authorization status with PayPal before capture, reauthorization, or customer follow-up.';
  }
  return 'Load PayPal order state and determine whether authorization or capture succeeded.';
}

function getRisk(row: PaymentLedgerRow): PayPalPaymentReconciliationRow['risk'] {
  if (
    row.lastErrorCode === 'CAPTURE_PERSIST_FAILED' ||
    row.lastErrorCode === 'CAPTURE_NOT_COMPLETED' ||
    row.lastErrorCode === 'CANONICAL_ORDER_SNAPSHOT_INVALID' ||
    row.lastErrorCode === 'PAYPAL_AUTHORIZATION_AMOUNT_MISMATCH' ||
    row.lastErrorCode === 'PAYPAL_CAPTURE_AMOUNT_MISMATCH' ||
    (Date.now() - row.updatedAt.getTime()) / 3_600_000 >= 24
  ) {
    return 'critical';
  }
  return row.paypalAuthorizationId || row.capturePayload ? 'warning' : 'info';
}

function hasPaymentEvidence(row: PaymentLedgerRow) {
  return Boolean(
    row.paypalAuthorizationId ||
      row.capturePayload ||
      (row.lastErrorCode && PAYMENT_RECONCILIATION_ERROR_CODES.has(row.lastErrorCode)),
  );
}

function mapRow(row: PaymentLedgerRow): PayPalPaymentReconciliationRow {
  const completion = getPayPalCaptureCompletion(row.capturePayload);
  return {
    orderToken: row.orderToken,
    supportRef: row.orderToken.slice(0, 8).toUpperCase(),
    customer: row.customerEmail || row.customerName,
    status: row.status,
    paypalOrderId: row.paypalOrderId,
    paypalAuthorizationId: row.paypalAuthorizationId,
    captureId: completion.captureId,
    amount: getCaptureAmountLabel(row),
    reason: getLocalReason(row),
    recommendedAction: getRecommendedAction(row),
    risk: getRisk(row),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    updated: formatDistanceToNowStrict(row.updatedAt, { addSuffix: true }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isPaymentReconciliationCandidate(row: PaymentLedgerRow) {
  if (row.processingCompletedAt || !hasPaymentEvidence(row)) return false;
  const captureCompletion = getPayPalCaptureCompletion(row.capturePayload);
  if (captureCompletion.ok) {
    const canonicalReconciliation = reconcileCanonicalPayPalPaymentChain(
      row,
      row.authorizePayload,
      row.capturePayload,
    );
    // A completed PayPal capture with corrupt/mismatched canonical evidence is independently
    // actionable even before another route has persisted an ERROR status/code.
    if (!canonicalReconciliation.ok) return true;
    return false;
  }

  return (
    PAYMENT_ATTENTION_STATUSES.has(row.status) ||
    Boolean(row.lastErrorCode && PAYMENT_RECONCILIATION_ERROR_CODES.has(row.lastErrorCode))
  );
}

export async function findPayPalPaymentReconciliationRows(args?: {
  batchSize?: number;
  minAgeMinutes?: number;
  now?: Date;
  orderTokens?: string[];
}) {
  const now = args?.now ?? new Date();
  const batchSize = clampPaymentReconciliationBatchSize(
    args?.batchSize ?? getPaymentReconciliationScannerBatchSize(),
  );
  const cutoff = new Date(
    now.getTime() - (args?.minAgeMinutes ?? getPaymentReconciliationScannerMinAgeMinutes()) * 60_000,
  );
  const orderTokens = args?.orderTokens?.map((token) => token.trim()).filter(Boolean);
  const rows = await paypalTxLedger.paypalIntent.findMany({
    where: {
      ...(orderTokens?.length ? { orderToken: { in: orderTokens } } : {}),
      processingCompletedAt: null,
      updatedAt: { lte: cutoff },
      OR: [
        { paypalAuthorizationId: { not: null } },
        { capturePayload: { not: Prisma.AnyNull } },
        { status: { in: [...PAYMENT_ATTENTION_STATUSES] } },
        { lastErrorCode: { in: [...PAYMENT_RECONCILIATION_ERROR_CODES] } },
      ],
    },
    orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    take: batchSize * 5,
    select: PAYMENT_RECONCILIATION_ROW_SELECT,
  });

  return rows.filter(isPaymentReconciliationCandidate).slice(0, batchSize).map(mapRow);
}

export async function getPayPalPaymentReconciliationDashboard(): Promise<PayPalPaymentReconciliationDashboard> {
  const minAgeMinutes = getPaymentReconciliationScannerMinAgeMinutes();
  const batchSize = getPaymentReconciliationScannerBatchSize();
  const rows = await findPayPalPaymentReconciliationRows({
    batchSize: Math.max(batchSize, 25),
    minAgeMinutes,
  });

  return {
    rows,
    total: rows.length,
    critical: rows.filter((row) => row.risk === 'critical').length,
    warning: rows.filter((row) => row.risk === 'warning').length,
    info: rows.filter((row) => row.risk === 'info').length,
    generatedAt: new Date().toISOString(),
    minAgeMinutes,
    batchSize,
    enabled: getPaymentReconciliationScannerEnabled(),
  };
}

export async function getPayPalPaymentReconciliationDashboardSummary() {
  const { total, critical, warning } = await getPayPalPaymentReconciliationDashboard();
  return { total, critical, warning };
}
