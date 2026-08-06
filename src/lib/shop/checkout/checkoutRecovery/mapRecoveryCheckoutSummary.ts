import {
  parseCanonicalOrderSnapshotFromLedger,
  type CanonicalOrderSnapshotLedgerEnvelope,
} from '@/lib/paypal/orderSnapshot/canonicalize';
import type {
  CanonicalOrderDestination,
  CanonicalOrderSnapshot,
} from '@/lib/paypal/orderSnapshot/types';
import { reconcileCanonicalPayPalPaymentChain } from '@/lib/paypal/txLedger/canonicalPaymentReconciliation';

type JsonRecord = Record<string, unknown>;

type RecoveryLedgerRow = CanonicalOrderSnapshotLedgerEnvelope & {
  orderToken: string;
  status: string;
  cartSnapshot: unknown;
  shippingSnapshot: unknown;
  authorizePayload: unknown;
  capturePayload: unknown;
  receiptLink: string | null;
  receiptFile: string | null;
  djangoPaymentSaveCustomId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function getPath(root: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined;
    return asRecord(current)?.[key];
  }, root);
}

function getCaptureAmount(capturePayload: unknown) {
  const amountPaths = [
    ['amount'],
    ['sellerReceivableBreakdown', 'grossAmount'],
    ['seller_receivable_breakdown', 'gross_amount'],
    ['purchaseUnits', 0, 'payments', 'captures', 0, 'amount'],
    ['purchase_units', 0, 'payments', 'captures', 0, 'amount'],
  ];

  for (const path of amountPaths) {
    const amount = asRecord(getPath(capturePayload, path));
    const value = asNumber(amount?.value);
    const currency = asString(amount?.currencyCode) ?? asString(amount?.currency_code);

    if (value !== null && currency) return { value, currency };
  }

  return null;
}

function formatMoney(
  amount: ReturnType<typeof getCaptureAmount>,
  fallbackCurrency?: string | null,
) {
  if (!amount) return null;

  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: amount.currency ?? fallbackCurrency ?? 'USD',
    }).format(amount.value);
  } catch {
    return `${amount.currency ?? fallbackCurrency ?? 'USD'} ${amount.value.toFixed(2)}`;
  }
}

function getCartSummary(cartSnapshot: unknown) {
  const cart = asArray(cartSnapshot);
  const itemCount = cart.reduce<number>((total, item) => {
    const quantity = asNumber(asRecord(item)?.quantity);
    return total + (quantity ?? 0);
  }, 0);
  const itemTitles = cart
    .map((item) => asString(asRecord(item)?.title) ?? asString(asRecord(item)?.itemDetail))
    .filter(Boolean)
    .slice(0, 2) as string[];

  return {
    itemCount,
    itemTitles,
    label:
      itemTitles.length > 0
        ? `${itemTitles.join(', ')}${cart.length > itemTitles.length ? ` +${cart.length - itemTitles.length} more` : ''}`
        : itemCount
          ? `${itemCount} item${itemCount === 1 ? '' : 's'}`
          : null,
  };
}

function getCanonicalOrderSummary(snapshot: CanonicalOrderSnapshot) {
  const itemCount = snapshot.lines.reduce((total, line) => total + line.quantity, 0);
  const itemTitles = snapshot.lines.slice(0, 2).map((line) => line.title);

  return {
    itemCount,
    itemTitles,
    label:
      itemTitles.length > 0
        ? `${itemTitles.join(', ')}${snapshot.lines.length > itemTitles.length ? ` +${snapshot.lines.length - itemTitles.length} more` : ''}`
        : null,
  };
}

function getShippingSummary(
  shippingSnapshot: unknown,
  canonicalDestination?: CanonicalOrderDestination,
) {
  const shipping = asRecord(shippingSnapshot);

  const city = asString(shipping?.shipping_city);
  const state = canonicalDestination
    ? canonicalDestination.region
    : asString(shipping?.shipping_state);
  const country = canonicalDestination
    ? canonicalDestination.countryIso3
    : asString(shipping?.shipping_country);
  const parts = [city, state, country].filter(Boolean);

  return parts.length ? parts.join(', ') : null;
}

function getStepLabel(row: RecoveryLedgerRow) {
  if (row.lastErrorMessage || row.status === 'error') {
    if (row.djangoPaymentSaveCustomId) return 'Payment saved; fulfillment review pending';
    if (row.receiptLink) return 'Receipt prepared; payment save or fulfillment needs review';
    return 'Payment captured; order review pending';
  }

  if (row.status === 'payment_saved') return 'Payment saved; fulfillment is still being finalized';
  if (row.status === 'receipt_uploaded') return 'Receipt prepared; payment save is still pending';
  if (row.status === 'captured') return 'Payment captured; receipt is still pending';
  return 'Payment received; checkout is still being reviewed';
}

function formatPlacedAt(date: Date) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function mapRecoveryCheckoutSummary(row: RecoveryLedgerRow) {
  let canonicalSnapshot: CanonicalOrderSnapshot | null = null;
  let canonicalEnvelopeInvalid = false;
  try {
    canonicalSnapshot = parseCanonicalOrderSnapshotFromLedger(row).snapshot;
  } catch {
    // A customer can still receive a support reference and actual PayPal capture amount, but
    // corrupt canonical metadata must never revive mutable cart/address values as order truth.
    canonicalEnvelopeInvalid = true;
  }
  const captureAmount = getCaptureAmount(row.capturePayload);
  const canonicalPaymentChain = reconcileCanonicalPayPalPaymentChain(
    row,
    row.authorizePayload,
    row.capturePayload,
  );
  const cartSummary = canonicalEnvelopeInvalid
    ? { itemCount: 0, itemTitles: [], label: null }
    : canonicalSnapshot
      ? getCanonicalOrderSummary(canonicalSnapshot)
      : getCartSummary(row.cartSnapshot);

  return {
    orderToken: row.orderToken,
    status: row.status,
    statusLabel: getStepLabel(row),
    receiptLink: row.receiptLink,
    receiptFile: row.receiptFile,
    djangoPaymentSaveCustomId: row.djangoPaymentSaveCustomId,
    supportReference: row.orderToken,
    shortSupportReference: row.orderToken.slice(0, 8),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    placedAtLabel: formatPlacedAt(row.createdAt),
    // This label describes money PayPal actually captured. The canonical total remains the
    // expected order value and must never be presented as paid when the two disagree.
    paidAmountLabel: formatMoney(captureAmount),
    itemCount: cartSummary.itemCount,
    itemSummaryLabel: cartSummary.label,
    itemTitles: cartSummary.itemTitles,
    shippingSummaryLabel: canonicalEnvelopeInvalid
      ? null
      : getShippingSummary(row.shippingSnapshot, canonicalSnapshot?.destination),
    message: !canonicalPaymentChain.ok
      ? 'Your payment was received, but its amount requires review before fulfillment.'
      : row.lastErrorMessage || row.status === 'error'
        ? 'Your payment was received, but fulfillment needs review.'
        : 'Your payment was received and is still being processed.',
  };
}
