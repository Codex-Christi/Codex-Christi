export const CANONICAL_ORDER_SNAPSHOT_VERSION = 'shop-alpha-order-v1' as const;
export const CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM = 'sha256' as const;

export type CanonicalMoney = {
  currency: string;
  value: string;
};

export type CanonicalOrderOption = {
  name: string;
  value: string;
};

export type CanonicalOrderLine = {
  lineId: string;
  /** Seller-store product selected in the shop. */
  productId: string;
  /** Seller-store variant selected in the shop. */
  variantId: string;
  /** Base Merchize catalog product that owns the fulfillment SKU. */
  supplierProductId: string;
  /** Base Merchize catalog variant that owns the fulfillment SKU. */
  supplierVariantId: string;
  /** Required Merchize fulfillment and shipping-catalog SKU. */
  sku: string;
  /** Optional seller/store SKU returned by Merchize; never copied from the browser. */
  sellerSku: string | null;
  title: string;
  selectedOptions: CanonicalOrderOption[];
  imageUrl: string;
  quantity: number;
  unitAmount: CanonicalMoney;
  lineAmount: CanonicalMoney;
  shippingAllocation: CanonicalMoney;
};

export type CanonicalOrderDestination = {
  countryIso3: string;
  region: string | null;
};

export type CanonicalOrderSnapshotDraft = {
  version: typeof CANONICAL_ORDER_SNAPSHOT_VERSION;
  hashAlgorithm: typeof CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM;
  createdAt: string;
  destination: CanonicalOrderDestination;
  currency: string;
  lines: CanonicalOrderLine[];
  subtotal: CanonicalMoney;
  shipping: CanonicalMoney;
  total: CanonicalMoney;
};

/**
 * Immutable payment truth for a new order. It intentionally has no tax field:
 * the current PayPal account cannot collect tax, so total is merchandise plus shipping only.
 */
export type CanonicalOrderSnapshot = CanonicalOrderSnapshotDraft & {
  hash: string;
};

export type CanonicalOrderSelection = {
  /** A lookup selector only. Provider/catalog responses remain authoritative. */
  productId: string;
  variantId: string;
  quantity: number;
};

export type CanonicalOrderResolutionInput = {
  selections: CanonicalOrderSelection[];
  destination: {
    countryIso3: string;
    region?: string | null;
  };
};
