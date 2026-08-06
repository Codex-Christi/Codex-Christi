import { getPayPalCaptureCompletion } from '@/lib/paypal/txLedger/captureCompletion';
import { PAYPAL_LEDGER_STATUS } from '@/lib/paypal/txLedger/status';
import type { PaymentLedgerRow } from '@/lib/paypal/txLedger/paymentReconciliationTypes';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getPath(root: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined;
    return asRecord(current)?.[key];
  }, root);
}

function firstPath(root: unknown, paths: Array<Array<string | number>>) {
  for (const path of paths) {
    const value = getPath(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function getPurchaseUnits(payload: unknown) {
  const units = firstPath(payload, [['purchaseUnits'], ['purchase_units']]);
  return Array.isArray(units) ? units : [];
}

function getPurchaseUnitCustomId(payload: unknown) {
  const purchaseUnit = asRecord(getPurchaseUnits(payload)[0]);
  return asString(purchaseUnit?.customId) ?? asString(purchaseUnit?.custom_id);
}

function getPaymentResourceCustomId(payload: unknown) {
  const resource = asRecord(payload);
  return asString(resource?.customId) ?? asString(resource?.custom_id);
}

function getMoneyPayload(payload: unknown) {
  const amount = asRecord(asRecord(payload)?.amount);
  const value = asString(amount?.value);
  const currencyCode = asString(amount?.currencyCode) ?? asString(amount?.currency_code);
  return value && currencyCode ? { value, currencyCode } : null;
}

function getAuthorizationRecord(payload: unknown) {
  const nested = firstPath(payload, [
    ['purchaseUnits', 0, 'payments', 'authorizations', 0],
    ['purchase_units', 0, 'payments', 'authorizations', 0],
  ]);
  const nestedRecord = asRecord(nested);
  if (nestedRecord && getMoneyPayload(nestedRecord)) return nestedRecord;

  const direct = asRecord(payload);
  return direct && getMoneyPayload(direct) ? direct : null;
}

function getRelatedIds(payload: unknown) {
  const data = asRecord(
    asRecord(asRecord(payload)?.supplementaryData)?.relatedIds ??
      asRecord(asRecord(payload)?.supplementary_data)?.related_ids,
  );
  return {
    orderId: asString(data?.orderId) ?? asString(data?.order_id),
    authorizationId: asString(data?.authorizationId) ?? asString(data?.authorization_id),
    captureId: asString(data?.captureId) ?? asString(data?.capture_id),
  };
}

function linkedId(payload: unknown, resourcePath: string) {
  const links = asRecord(payload)?.links;
  if (!Array.isArray(links)) return null;

  for (const link of links) {
    const href = asString(asRecord(link)?.href);
    const match = href?.match(new RegExp(`${resourcePath}/([^/?#]+)`));
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function nestedAuthorizationId(payload: unknown) {
  return asString(
    firstPath(payload, [
      ['purchaseUnits', 0, 'payments', 'authorizations', 0, 'id'],
      ['purchase_units', 0, 'payments', 'authorizations', 0, 'id'],
    ]),
  );
}

export function getNestedCapture(payload: unknown) {
  const captures = firstPath(payload, [
    ['purchaseUnits', 0, 'payments', 'captures'],
    ['purchase_units', 0, 'payments', 'captures'],
  ]);
  const records = Array.isArray(captures) ? (captures.map(asRecord).filter(Boolean) as JsonRecord[]) : [];
  return records.find((capture) => getPayPalCaptureCompletion(capture).ok) ?? records[0] ?? null;
}

export function getRelatedOrderId(payload: unknown) {
  return getRelatedIds(payload).orderId ?? linkedId(payload, '/v2/checkout/orders');
}

export function getRelatedAuthorizationId(payload: unknown) {
  return (
    getRelatedIds(payload).authorizationId ??
    nestedAuthorizationId(payload) ??
    linkedId(payload, '/v2/payments/authorizations')
  );
}

export function getRelatedCaptureId(payload: unknown) {
  return (
    getRelatedIds(payload).captureId ??
    getPayPalCaptureCompletion(payload).captureId ??
    linkedId(payload, '/v2/payments/captures')
  );
}

export function hasProcessingAuthorizePayload(payload: unknown) {
  return Boolean(getPurchaseUnits(payload).length && getPurchaseUnitCustomId(payload));
}

function buildMinimalAuthorizePayload(row: PaymentLedgerRow, paymentPayload: unknown, authorizationPayload?: unknown) {
  const payment = asRecord(paymentPayload);
  const authorization = asRecord(authorizationPayload);
  if (!payment && !authorization) return null;

  const amount =
    getMoneyPayload(authorizationPayload) ??
    getMoneyPayload(paymentPayload) ??
    getPayPalCaptureCompletion(paymentPayload).amount;
  const currencyCode = amount ? ('currency' in amount ? amount.currency : amount.currencyCode) : null;

  return {
    id:
      row.paypalOrderId ??
      getRelatedOrderId(paymentPayload) ??
      getRelatedOrderId(authorizationPayload) ??
      row.orderToken,
    status: PAYPAL_LEDGER_STATUS.CAPTURED,
    createTime:
      asString(payment?.createTime) ??
      asString(payment?.create_time) ??
      asString(authorization?.createTime) ??
      asString(authorization?.create_time) ??
      row.createdAt.toISOString(),
    updateTime:
      asString(payment?.updateTime) ??
      asString(payment?.update_time) ??
      asString(authorization?.updateTime) ??
      asString(authorization?.update_time) ??
      row.updatedAt.toISOString(),
    purchaseUnits: [
      {
        customId:
          getPaymentResourceCustomId(authorizationPayload) ??
          getPaymentResourceCustomId(paymentPayload) ??
          row.orderToken,
        amount: amount ? { value: amount.value, currencyCode } : undefined,
      },
    ],
  };
}

/**
 * Replaces the nested authorization resource in an order-shaped payload with direct provider
 * evidence. Returns null when either side is not usable, so callers never mistake a direct
 * authorization resource for the full PayPal order shape needed by downstream processing.
 */
export function attachPayPalAuthorizationEvidence(
  orderPayload: unknown,
  authorizationEvidence: unknown,
) {
  const authorization = getAuthorizationRecord(authorizationEvidence);
  if (!authorization) return null;

  const cloned = asRecord(safeJson(orderPayload));
  if (!cloned) return null;
  const usesSnakeCase = Array.isArray(cloned.purchase_units);
  const purchaseUnits = usesSnakeCase ? cloned.purchase_units : cloned.purchaseUnits;
  if (!Array.isArray(purchaseUnits) || !asRecord(purchaseUnits[0])) return null;

  const firstUnit = asRecord(purchaseUnits[0])!;
  const payments = asRecord(firstUnit.payments) ?? {};
  const enrichedUnit = {
    ...firstUnit,
    payments: {
      ...payments,
      authorizations: [safeJson(authorization)],
    },
  };
  const enrichedUnits = [enrichedUnit, ...purchaseUnits.slice(1)];

  return usesSnakeCase
    ? { ...cloned, purchase_units: enrichedUnits }
    : { ...cloned, purchaseUnits: enrichedUnits };
}

export function getProcessingAuthorizePayload({
  row,
  orderPayload,
  paymentPayload,
  authorizationPayload,
}: {
  row: PaymentLedgerRow;
  orderPayload?: unknown;
  paymentPayload?: unknown;
  authorizationPayload?: unknown;
}) {
  // Keep order/custom-id shape and authorization money evidence as separate concerns. A post-capture
  // Get Order response can retain purchase-unit amount/customId while omitting authorizations; its
  // order total is not authorization proof.
  const processingBase = hasProcessingAuthorizePayload(orderPayload)
    ? orderPayload
    : hasProcessingAuthorizePayload(row.authorizePayload)
      ? row.authorizePayload
      : buildMinimalAuthorizePayload(row, paymentPayload, authorizationPayload);
  if (!hasProcessingAuthorizePayload(processingBase)) return null;

  const authorizationEvidence =
    getAuthorizationRecord(authorizationPayload) ??
    getAuthorizationRecord(row.authorizePayload) ??
    getAuthorizationRecord(orderPayload);

  return authorizationEvidence
    ? (attachPayPalAuthorizationEvidence(processingBase, authorizationEvidence) ?? processingBase)
    : processingBase;
}

export function safeJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}
