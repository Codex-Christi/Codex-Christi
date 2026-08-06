import 'server-only';

import type { Prisma } from '@/lib/prisma/shop/merchizeFulfillmentOps/generated/merchizeFulfillmentOps/client';
import {
  parseCanonicalOrderSnapshotFromLedger,
  type CanonicalOrderSnapshotLedgerEnvelope,
} from '@/lib/paypal/orderSnapshot/canonicalize';
import { redactEmail, redactOperationalPayload } from './redaction';

type JsonRecord = Record<string, unknown>;

export type NormalizedMerchizeFulfillmentItem = {
  merchizeLineItemId: string | null;
  productId: string | null;
  merchizeSku: string | null;
  sellerSku: string | null;
  title: string | null;
  quantity: number;
  currency: string | null;
  unitPrice: string | null;
  imageUrl: string | null;
  variantSummary: string | null;
  itemPayload: Prisma.InputJsonValue;
};

export type NormalizedMerchizeOrderSnapshot = {
  merchizeOrderCode: string | null;
  merchizeIdentifier: string | null;
  merchizeStatus: string | null;
  merchizeSubStatus: string | null;
  merchizeIsEnqueued: boolean | null;
  merchizeIsDeleted: boolean | null;
  merchizeHidden: boolean | null;
  itemCount: number;
  totalQuantity: number;
  orderCurrency: string | null;
};

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
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

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

export function getPath(root: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined;
    return asRecord(current)?.[key];
  }, root);
}

function firstString(root: unknown, paths: Array<Array<string | number>>) {
  for (const path of paths) {
    const value = asString(getPath(root, path));
    if (value) return value;
  }

  return null;
}

function firstNumber(root: unknown, paths: Array<Array<string | number>>) {
  for (const path of paths) {
    const value = asNumber(getPath(root, path));
    if (value !== null) return value;
  }

  return null;
}

function firstBoolean(root: unknown, paths: Array<Array<string | number>>) {
  for (const path of paths) {
    const value = asBoolean(getPath(root, path));
    if (value !== null) return value;
  }

  return null;
}

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function toOptionalPrismaJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return toPrismaJson(value);
}

export function extractMerchizeExternalOrderNumberFromDjangoProcessResponse(
  payload: unknown,
  fallback?: string | null,
) {
  return (
    firstString(payload, [
      ['data', 'response_data', 'data', 'data', 'order_id'],
      ['data', 'response_data', 'data', 'order_id'],
      ['response_data', 'data', 'data', 'order_id'],
      ['response_data', 'data', 'order_id'],
    ]) ??
    fallback ??
    null
  );
}

export function extractMerchizeOrderIdFromExternalLookup(payload: unknown) {
  return firstString(payload, [['data', '_id']]);
}

export function summarizeProviderResponse(payload: unknown): Prisma.InputJsonValue {
  const data = asRecord(getPath(payload, ['data']));
  const summary = {
    success: getPath(payload, ['success']),
    status: getPath(payload, ['status']),
    message: asString(getPath(payload, ['message'])),
    merchizeOrderId: asString(data?._id),
    merchizeExternalOrderNumber:
      asString(data?.external_number) ?? asString(data?.order_id) ?? asString(data?.order_number),
    merchizeStatus: asString(data?.status) ?? asString(data?.order_status),
    itemCount: getCandidateItemArray(payload)?.length ?? null,
  };

  return toPrismaJson(redactOperationalPayload(summary));
}

export function summarizeProviderRequest(payload: unknown): Prisma.InputJsonValue {
  return toPrismaJson(redactOperationalPayload(payload));
}

export function buildRegistrationSummaries(
  input: CanonicalOrderSnapshotLedgerEnvelope & {
    customerEmail?: string | null;
    shippingSnapshot?: unknown;
    cartSnapshot?: unknown;
  },
) {
  const parsedSnapshot = parseCanonicalOrderSnapshotFromLedger(input);
  const shipping = asRecord(input.shippingSnapshot);
  const canonicalSnapshot = parsedSnapshot.snapshot;
  const cartItems =
    parsedSnapshot.mode === 'legacy' && Array.isArray(input.cartSnapshot) ? input.cartSnapshot : [];
  const totalQuantity = canonicalSnapshot
    ? canonicalSnapshot.lines.reduce((sum, line) => sum + line.quantity, 0)
    : cartItems.reduce((sum, item) => {
        const quantity = asNumber(asRecord(item)?.quantity) ?? 0;
        return sum + quantity;
      }, 0);

  const orderCurrency = canonicalSnapshot
    ? canonicalSnapshot.currency
    : (firstString(cartItems[0], [['itemDetail', 'currency'], ['currency']]) ??
      firstString(input.cartSnapshot, [
        [0, 'itemDetail', 'currency'],
        [0, 'currency'],
      ]));

  return {
    customerEmailRedacted: redactEmail(input.customerEmail),
    shippingCity: asString(shipping?.shipping_city),
    shippingState: canonicalSnapshot
      ? canonicalSnapshot.destination.region
      : asString(shipping?.shipping_state),
    shippingCountry: canonicalSnapshot
      ? canonicalSnapshot.destination.countryIso3
      : asString(shipping?.shipping_country),
    itemCount: canonicalSnapshot?.lines.length ?? cartItems.length,
    totalQuantity,
    orderCurrency,
  };
}

function getDataRoot(payload: unknown) {
  return asRecord(getPath(payload, ['data'])) ?? asRecord(payload);
}

function getCandidateItemArray(payload: unknown): unknown[] | null {
  const candidates = [
    ['data', 'items'],
    ['data', 'line_items'],
    ['data', 'order_items'],
    ['data', 'orderItems'],
    ['data', 'products'],
    ['data', 'order', 'items'],
    ['data', 'order', 'line_items'],
    ['items'],
    ['line_items'],
    ['order_items'],
    ['orderItems'],
    ['products'],
  ];

  for (const path of candidates) {
    const value = getPath(payload, path);
    if (Array.isArray(value)) return value;
  }

  return null;
}

function buildVariantSummary(item: unknown) {
  const attributes =
    getPath(item, ['attributes']) ??
    getPath(item, ['variant_attributes']) ??
    getPath(item, ['options']) ??
    getPath(item, ['variant', 'attributes']);

  if (!Array.isArray(attributes)) return firstString(item, [['variant'], ['variant_title']]);

  const parts = attributes
    .map((attribute) => {
      const record = asRecord(attribute);
      const name = asString(record?.name) ?? asString(record?.label);
      const value =
        asString(record?.value_text) ??
        asString(record?.value) ??
        asString(record?.text) ??
        asString(record?.value_code);

      if (!name && !value) return null;
      if (!name) return value;
      if (!value) return name;
      return `${name}: ${value}`;
    })
    .filter(Boolean);

  return parts.length ? parts.join(' / ') : null;
}

function normalizeItem(item: unknown, index: number): NormalizedMerchizeFulfillmentItem {
  const quantity = firstNumber(item, [['quantity'], ['qty'], ['count']]) ?? 1;
  const unitPrice = firstNumber(item, [['price'], ['unit_price'], ['unitPrice'], ['retail_price']]);

  return {
    merchizeLineItemId:
      firstString(item, [['_id'], ['id'], ['line_item_id'], ['lineItemId']]) ?? `item-${index}`,
    productId: firstString(item, [
      ['product_id'],
      ['productId'],
      ['product', '_id'],
      ['product', 'id'],
    ]),
    merchizeSku: firstString(item, [
      ['merchize_sku'],
      ['merchizeSku'],
      ['variant', 'sku'],
      ['sku'],
    ]),
    sellerSku: firstString(item, [['sku_seller'], ['seller_sku'], ['sellerSku']]),
    title: firstString(item, [['title'], ['name'], ['product_name'], ['product', 'title']]),
    quantity,
    currency: firstString(item, [['currency'], ['price_currency'], ['money', 'currency']]),
    unitPrice: unitPrice === null ? null : String(unitPrice),
    imageUrl: firstString(item, [
      ['image'],
      ['image_url'],
      ['imageUrl'],
      ['thumbnail'],
      ['product', 'image'],
    ]),
    variantSummary: buildVariantSummary(item),
    itemPayload: toPrismaJson(item),
  };
}

export function extractNormalizedFulfillmentItems(args: {
  detailPayload: unknown;
  lookupPayload: unknown;
}): NormalizedMerchizeFulfillmentItem[] {
  const detailItems = getCandidateItemArray(args.detailPayload);
  const lookupItems = getCandidateItemArray(args.lookupPayload);
  const items = detailItems?.length ? detailItems : (lookupItems ?? []);

  return items.map(normalizeItem);
}

export function extractNormalizedOrderSnapshot(args: {
  lookupPayload: unknown;
  detailPayload: unknown;
  items: NormalizedMerchizeFulfillmentItem[];
}): NormalizedMerchizeOrderSnapshot {
  const detailData = getDataRoot(args.detailPayload);
  const lookupData = getDataRoot(args.lookupPayload);
  const root = detailData ?? lookupData;
  const totalQuantity = args.items.reduce((sum, item) => sum + item.quantity, 0);
  const orderCurrency =
    firstString(root, [['currency'], ['order_currency'], ['payment', 'currency']]) ??
    args.items.find((item) => item.currency)?.currency ??
    null;

  return {
    merchizeOrderCode: firstString(root, [
      ['order_id'],
      ['order_code'],
      ['order_number'],
      ['external_number'],
      ['code'],
    ]),
    merchizeIdentifier: firstString(root, [['identifier']]),
    merchizeStatus: firstString(root, [
      ['status'],
      ['order_status'],
      ['fulfillment_status'],
      ['processing_status'],
    ]),
    merchizeSubStatus: firstString(root, [['sub_status'], ['subStatus'], ['substatus']]),
    merchizeIsEnqueued: firstBoolean(root, [['is_enqueued'], ['isEnqueued']]),
    merchizeIsDeleted: firstBoolean(root, [['is_deleted'], ['isDeleted']]),
    merchizeHidden: firstBoolean(root, [['hidden'], ['is_hidden'], ['isHidden']]),
    itemCount: args.items.length,
    totalQuantity,
    orderCurrency,
  };
}
