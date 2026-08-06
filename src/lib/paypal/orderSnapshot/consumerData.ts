import type { CanonicalOrderSnapshot } from './types';

export type CanonicalInvoiceLine = {
  name: string;
  sku: string;
  quantity: string;
  unitAmount: {
    value: string;
    currencyCode: string;
  };
  lineAmount: string;
};

export type CanonicalInvoicePricing = {
  currencyCode: string;
  items: CanonicalInvoiceLine[];
  subtotal: string;
  shipping: string;
  total: string;
};

export type CanonicalFulfillmentItem = {
  product_id: string;
  sku: string;
  merchize_sku: string;
  quantity: number;
  price: number;
  currency: string;
  image: string;
};

/**
 * Converts the sealed snapshot to receipt data without doing floating-point arithmetic or reading
 * PayPal/browser line items. The snapshot parser is responsible for validating the input first.
 */
export function getCanonicalInvoicePricing(
  snapshot: CanonicalOrderSnapshot,
): CanonicalInvoicePricing {
  return {
    currencyCode: snapshot.currency,
    items: snapshot.lines.map((line) => ({
      name: line.title,
      sku: line.sellerSku ?? line.sku,
      quantity: String(line.quantity),
      unitAmount: {
        value: line.unitAmount.value,
        currencyCode: line.unitAmount.currency,
      },
      lineAmount: line.lineAmount.value,
    })),
    subtotal: snapshot.subtotal.value,
    shipping: snapshot.shipping.value,
    total: snapshot.total.value,
  };
}

export function getCanonicalPaymentAmountReceived(snapshot: CanonicalOrderSnapshot): string {
  return `${snapshot.total.value} ${snapshot.total.currency}`;
}

/**
 * Keeps the existing Django fulfillment wire contract: product_id is the seller-store product
 * identity, while merchize_sku is the catalog-proven fulfillment SKU. Every value comes from the
 * sealed server snapshot.
 */
export function getCanonicalFulfillmentItems(
  snapshot: CanonicalOrderSnapshot,
): CanonicalFulfillmentItem[] {
  return snapshot.lines.map((line) => {
    const price = Number(line.unitAmount.value);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Canonical unit price is unsafe for fulfillment line ${line.lineId}.`);
    }

    return {
      product_id: line.productId,
      sku: line.sellerSku ?? '',
      merchize_sku: line.sku,
      quantity: line.quantity,
      price,
      currency: snapshot.currency,
      image: line.imageUrl,
    };
  });
}
