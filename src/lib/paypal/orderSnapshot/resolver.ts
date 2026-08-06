import { z } from 'zod';
import {
  CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
  CANONICAL_ORDER_SNAPSHOT_VERSION,
  type CanonicalOrderLine,
  type CanonicalOrderOption,
  type CanonicalOrderResolutionInput,
  type CanonicalOrderSelection,
  type CanonicalOrderSnapshot,
} from './types';
import { currencyExponent, finalizeCanonicalOrderSnapshot, moneyFromMinor } from './canonicalize';
import type { CatalogItem } from '@/lib/datasetSearchers/merchize/catalog';
import type { StrictShippingQuoteUsd } from './strictShipping';

export const CANONICAL_ORDER_RESOLUTION_LIMITS = Object.freeze({
  maxSelectionCount: 25,
  maxIdentifierLength: 128,
  maxLineQuantity: 25,
  maxTotalQuantity: 100,
  maxConcurrentProductResolutions: 4,
});

const selectionSchema = z
  .object({
    productId: z
      .string()
      .trim()
      .min(1)
      .max(CANONICAL_ORDER_RESOLUTION_LIMITS.maxIdentifierLength),
    variantId: z
      .string()
      .trim()
      .min(1)
      .max(CANONICAL_ORDER_RESOLUTION_LIMITS.maxIdentifierLength),
    quantity: z
      .number()
      .int()
      .positive()
      .max(CANONICAL_ORDER_RESOLUTION_LIMITS.maxLineQuantity)
      .safe(),
  })
  .strict();
const resolutionInputSchema = z
  .object({
    selections: z
      .array(selectionSchema)
      .min(1)
      .max(CANONICAL_ORDER_RESOLUTION_LIMITS.maxSelectionCount),
    destination: z
      .object({
        countryIso3: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/),
        region: z.string().trim().min(1).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export type CanonicalOrderResolutionErrorCode =
  | 'INVALID_ORDER_SELECTION'
  | 'PRODUCT_UNAVAILABLE'
  | 'VARIANT_UNAVAILABLE'
  | 'VARIANT_PRODUCT_MISMATCH'
  | 'MISSING_TRUSTED_SKU'
  | 'MISSING_CATALOG_VARIANT'
  | 'LIVE_PRICE_UNAVAILABLE'
  | 'INVALID_CURRENCY_RESOLUTION'
  | 'UNSAFE_SHIPPING_FALLBACK'
  | 'INVALID_SHIPPING_QUOTE'
  | 'MISSING_PRODUCT_IMAGE';

export class CanonicalOrderResolutionError extends Error {
  readonly code: CanonicalOrderResolutionErrorCode;
  readonly status: 400 | 409 | 503;

  constructor(
    code: CanonicalOrderResolutionErrorCode,
    message: string,
    status: 400 | 409 | 503 = 409,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CanonicalOrderResolutionError';
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type TrustedProviderVariant = {
  variantId: string;
  productId: string;
  sku: string;
  sellerSku: string | null;
  title: string;
  selectedOptions: CanonicalOrderOption[];
  imageUrl: string;
  unitPriceUsd: number;
  priceSource: 'live';
  /** Derived only from the current trusted storefront/provider response. */
  isAvailable: boolean;
};

export type TrustedProviderProduct = {
  productId: string;
  title: string;
  variants: TrustedProviderVariant[];
  /** False for inactive, deleted, private, taken-down, or unapproved products. */
  isAvailable: boolean;
};

export type TrustedCatalogVariant = {
  sku: string;
  supplierProductId: string;
  supplierVariantId: string;
  catalogRow: CatalogItem;
};

export type TrustedCurrencyResolution = {
  /** Final PayPal-compatible order currency, preserving the existing supported-currency behavior. */
  currency: string;
  /** USD-to-order-currency multiplier. USD fallback is represented as 1. */
  multiplier: number;
};

export type CanonicalOrderShippingQuote =
  | StrictShippingQuoteUsd
  | {
      source: 'FLAT_7';
      totalUsdCents: number;
      allocationsUsdCents: Record<string, number>;
      rowFallbackSkus: string[];
    };

export type CanonicalOrderResolverDependencies = {
  resolveProduct: (productLookup: string) => Promise<TrustedProviderProduct>;
  resolveCatalogVariants: (skus: string[]) => Promise<TrustedCatalogVariant[]>;
  resolveCurrency: (countryIso3: string) => Promise<TrustedCurrencyResolution>;
  resolveShipping: (input: {
    lines: Array<{ lineId: string; sku: string; quantity: number }>;
    catalogVariants: TrustedCatalogVariant[];
    countryIso3: string;
    region: string | null;
  }) => Promise<CanonicalOrderShippingQuote>;
  now?: () => Date;
};

type ResolvedLineSeed = {
  lineId: string;
  product: TrustedProviderProduct;
  variant: TrustedProviderVariant;
  quantity: number;
};

function parseInput(value: CanonicalOrderResolutionInput): CanonicalOrderResolutionInput {
  try {
    const parsed = resolutionInputSchema.parse(value);
    return {
      selections: parsed.selections,
      destination: {
        countryIso3: parsed.destination.countryIso3,
        region: parsed.destination.region ?? null,
      },
    };
  } catch (error) {
    throw new CanonicalOrderResolutionError(
      'INVALID_ORDER_SELECTION',
      'Checkout selections require product and variant IDs plus positive integer quantities.',
      400,
      { cause: error },
    );
  }
}

/**
 * Compatibility bridge for the current Zustand cart payload. It deliberately copies only the
 * seller-product lookup ID, variant ID, and quantity; browser title/SKU/price/options are ignored.
 */
export function extractCanonicalOrderSelectionsFromCart(cart: unknown): CanonicalOrderSelection[] {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new CanonicalOrderResolutionError(
      'INVALID_ORDER_SELECTION',
      'Checkout cart must contain at least one item.',
      400,
    );
  }

  try {
    return cart.map((item) => {
      if (!item || typeof item !== 'object') throw new TypeError('Cart item must be an object.');
      const record = item as Record<string, unknown>;
      const itemDetail =
        record.itemDetail && typeof record.itemDetail === 'object'
          ? (record.itemDetail as Record<string, unknown>)
          : null;
      return selectionSchema.parse({
        productId: itemDetail?.product,
        variantId: record.variantId,
        quantity: record.quantity,
      });
    });
  } catch (error) {
    throw new CanonicalOrderResolutionError(
      'INVALID_ORDER_SELECTION',
      'Checkout cart contains an invalid product, variant, or quantity.',
      400,
      { cause: error },
    );
  }
}

function groupSelections(selections: CanonicalOrderSelection[]) {
  const grouped = new Map<string, CanonicalOrderSelection>();
  for (const selection of selections) {
    const key = `${selection.productId}\u0000${selection.variantId}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...selection });
      continue;
    }

    const quantity = existing.quantity + selection.quantity;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity > CANONICAL_ORDER_RESOLUTION_LIMITS.maxLineQuantity
    ) {
      throw new CanonicalOrderResolutionError(
        'INVALID_ORDER_SELECTION',
        'Combined line quantity exceeds the checkout limit.',
        400,
      );
    }
    existing.quantity = quantity;
  }

  const groupedSelections = [...grouped.values()].sort(
    (a, b) => a.productId.localeCompare(b.productId) || a.variantId.localeCompare(b.variantId),
  );
  const totalQuantity = groupedSelections.reduce((sum, selection) => sum + selection.quantity, 0);
  if (totalQuantity > CANONICAL_ORDER_RESOLUTION_LIMITS.maxTotalQuantity) {
    throw new CanonicalOrderResolutionError(
      'INVALID_ORDER_SELECTION',
      'Combined cart quantity exceeds the checkout limit.',
      400,
    );
  }

  return groupedSelections;
}

function assertTrustedProduct(product: TrustedProviderProduct, lookup: string) {
  if (!product.productId?.trim() || !product.title?.trim() || !Array.isArray(product.variants)) {
    throw new CanonicalOrderResolutionError(
      'PRODUCT_UNAVAILABLE',
      `Server product data is unavailable for ${lookup}.`,
      503,
    );
  }
  if (!product.isAvailable) {
    throw new CanonicalOrderResolutionError(
      'PRODUCT_UNAVAILABLE',
      `The selected product is no longer available: ${lookup}.`,
      409,
    );
  }
}

function resolveLineSeeds(
  selections: CanonicalOrderSelection[],
  productByLookup: ReadonlyMap<string, TrustedProviderProduct>,
) {
  const seedsByTrustedVariant = new Map<string, ResolvedLineSeed>();

  for (const selection of selections) {
    const product = productByLookup.get(selection.productId);
    if (!product) {
      throw new CanonicalOrderResolutionError(
        'PRODUCT_UNAVAILABLE',
        `Server product data is unavailable for ${selection.productId}.`,
        503,
      );
    }

    const variant = product.variants.find(
      (candidate) => candidate.variantId === selection.variantId,
    );
    if (!variant) {
      throw new CanonicalOrderResolutionError(
        'VARIANT_UNAVAILABLE',
        `Variant ${selection.variantId} is not offered by the selected server product.`,
      );
    }
    if (!variant.isAvailable) {
      throw new CanonicalOrderResolutionError(
        'VARIANT_UNAVAILABLE',
        `Variant ${variant.variantId} is no longer available.`,
      );
    }
    if (variant.productId !== product.productId) {
      throw new CanonicalOrderResolutionError(
        'VARIANT_PRODUCT_MISMATCH',
        `Variant ${variant.variantId} does not belong to its server-resolved product.`,
      );
    }
    if (!variant.sku?.trim()) {
      throw new CanonicalOrderResolutionError(
        'MISSING_TRUSTED_SKU',
        `Variant ${variant.variantId} has no server-resolved Merchize SKU.`,
      );
    }
    if (
      variant.priceSource !== 'live' ||
      !Number.isFinite(variant.unitPriceUsd) ||
      variant.unitPriceUsd <= 0
    ) {
      throw new CanonicalOrderResolutionError(
        'LIVE_PRICE_UNAVAILABLE',
        `A current server price is unavailable for variant ${variant.variantId}.`,
        503,
      );
    }
    if (!variant.imageUrl?.trim()) {
      throw new CanonicalOrderResolutionError(
        'MISSING_PRODUCT_IMAGE',
        `A trusted product image is unavailable for variant ${variant.variantId}.`,
      );
    }

    const lineId = `${product.productId}:${variant.variantId}`;
    const existing = seedsByTrustedVariant.get(lineId);
    if (existing) {
      const quantity = existing.quantity + selection.quantity;
      if (
        !Number.isSafeInteger(quantity) ||
        quantity > CANONICAL_ORDER_RESOLUTION_LIMITS.maxLineQuantity
      ) {
        throw new CanonicalOrderResolutionError(
          'INVALID_ORDER_SELECTION',
          'Combined line quantity exceeds the checkout limit.',
          400,
        );
      }
      existing.quantity = quantity;
    } else {
      seedsByTrustedVariant.set(lineId, { lineId, product, variant, quantity: selection.quantity });
    }
  }

  return [...seedsByTrustedVariant.values()].sort((a, b) => a.lineId.localeCompare(b.lineId));
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
) {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

function unitUsdToMinor(unitPriceUsd: number, resolution: TrustedCurrencyResolution) {
  const factor = currencyExponent(resolution.currency) === 0 ? 1 : 100;
  const minor = Math.round(unitPriceUsd * resolution.multiplier * factor);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new CanonicalOrderResolutionError(
      'LIVE_PRICE_UNAVAILABLE',
      'The resolved unit price cannot be represented safely in the order currency.',
      503,
    );
  }
  return minor;
}

function shippingToMinor(totalUsdCents: number, resolution: TrustedCurrencyResolution) {
  const rawMajor = (totalUsdCents / 100) * resolution.multiplier;
  const minor =
    currencyExponent(resolution.currency) === 0
      ? Math.round(rawMajor)
      : Math.ceil(totalUsdCents * resolution.multiplier - Number.EPSILON);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new CanonicalOrderResolutionError(
      'INVALID_SHIPPING_QUOTE',
      'The shipping total cannot be represented safely in the order currency.',
      503,
    );
  }
  return minor;
}

function allocateMinor(total: number, weights: number[]) {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    weightTotal <= 0 ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)
  ) {
    throw new CanonicalOrderResolutionError(
      'INVALID_SHIPPING_QUOTE',
      'Shipping allocations are incomplete or unsafe.',
      503,
    );
  }

  const exact = weights.map((weight) => (total * weight) / weightTotal);
  const values = exact.map(Math.floor);
  let remainder = total - values.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
    values[order[index % order.length].index] += 1;
  }
  return values;
}

function validateCurrencyResolution(resolution: TrustedCurrencyResolution) {
  const currency = resolution.currency?.trim().toUpperCase();
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !Number.isFinite(resolution.multiplier) ||
    resolution.multiplier <= 0
  ) {
    throw new CanonicalOrderResolutionError(
      'INVALID_CURRENCY_RESOLUTION',
      'The server could not resolve a safe checkout currency conversion.',
      503,
    );
  }
  return { currency, multiplier: resolution.multiplier };
}

/**
 * Builds the authoritative order from server-resolved provider/catalog data. Browser product IDs
 * are only lookup selectors: the returned variant/product relationship, SKU, live price, and
 * catalog identity are all proven again before the snapshot is finalized.
 */
export async function resolveCanonicalOrderSnapshot(
  rawInput: CanonicalOrderResolutionInput,
  dependencies: CanonicalOrderResolverDependencies,
): Promise<CanonicalOrderSnapshot> {
  const input = parseInput(rawInput);
  const selections = groupSelections(input.selections);
  const productLookups = [...new Set(selections.map((selection) => selection.productId))];
  const resolvedProducts = await mapWithConcurrency(
    productLookups,
    CANONICAL_ORDER_RESOLUTION_LIMITS.maxConcurrentProductResolutions,
    async (lookup) => {
      try {
        const product = await dependencies.resolveProduct(lookup);
        assertTrustedProduct(product, lookup);
        return [lookup, product] as const;
      } catch (error) {
        if (error instanceof CanonicalOrderResolutionError) throw error;
        throw new CanonicalOrderResolutionError(
          'PRODUCT_UNAVAILABLE',
          `Server product data is unavailable for ${lookup}.`,
          503,
          { cause: error },
        );
      }
    },
  );
  const lineSeeds = resolveLineSeeds(selections, new Map(resolvedProducts));

  const uniqueSkus = [...new Set(lineSeeds.map((line) => line.variant.sku))].sort();
  let catalogVariants: TrustedCatalogVariant[];
  try {
    catalogVariants = await dependencies.resolveCatalogVariants(uniqueSkus);
  } catch (error) {
    throw new CanonicalOrderResolutionError(
      'MISSING_CATALOG_VARIANT',
      'One or more server-resolved SKUs are absent from the Merchize catalog.',
      409,
      { cause: error },
    );
  }
  const catalogBySku = new Map(catalogVariants.map((variant) => [variant.sku, variant]));
  for (const sku of uniqueSkus) {
    const catalog = catalogBySku.get(sku);
    if (
      !catalog ||
      catalog.catalogRow.SKU_variant !== sku ||
      !catalog.supplierProductId?.trim() ||
      !catalog.supplierVariantId?.trim()
    ) {
      throw new CanonicalOrderResolutionError(
        'MISSING_CATALOG_VARIANT',
        `Server SKU ${sku} could not be proven against the Merchize catalog.`,
      );
    }
  }

  const currency = validateCurrencyResolution(
    await dependencies.resolveCurrency(input.destination.countryIso3),
  );
  const shippingQuote = await dependencies.resolveShipping({
    lines: lineSeeds.map((line) => ({
      lineId: line.lineId,
      sku: line.variant.sku,
      quantity: line.quantity,
    })),
    catalogVariants,
    countryIso3: input.destination.countryIso3,
    region: input.destination.region ?? null,
  });
  if (shippingQuote.source === 'FLAT_7') {
    throw new CanonicalOrderResolutionError(
      'UNSAFE_SHIPPING_FALLBACK',
      'Checkout cannot use an unverified flat shipping fallback.',
      503,
    );
  }
  if (!Number.isSafeInteger(shippingQuote.totalUsdCents) || shippingQuote.totalUsdCents < 0) {
    throw new CanonicalOrderResolutionError(
      'INVALID_SHIPPING_QUOTE',
      'Server shipping evidence contains an invalid total.',
      503,
    );
  }

  const allocationWeights = lineSeeds.map((line) => {
    const allocation = shippingQuote.allocationsUsdCents[line.lineId];
    if (!Number.isSafeInteger(allocation) || allocation < 0) {
      throw new CanonicalOrderResolutionError(
        'INVALID_SHIPPING_QUOTE',
        `Server shipping evidence is incomplete for ${line.lineId}.`,
        503,
      );
    }
    return allocation;
  });
  if (allocationWeights.reduce((sum, value) => sum + value, 0) !== shippingQuote.totalUsdCents) {
    throw new CanonicalOrderResolutionError(
      'INVALID_SHIPPING_QUOTE',
      'Server shipping allocations do not equal the shipping total.',
      503,
    );
  }
  const shippingMinor = shippingToMinor(shippingQuote.totalUsdCents, currency);
  const shippingAllocations = allocateMinor(shippingMinor, allocationWeights);

  const lines: CanonicalOrderLine[] = lineSeeds.map((line, index) => {
    const catalog = catalogBySku.get(line.variant.sku)!;
    const unitMinor = unitUsdToMinor(line.variant.unitPriceUsd, currency);
    const lineMinor = BigInt(unitMinor) * BigInt(line.quantity);
    return {
      lineId: line.lineId,
      productId: line.product.productId,
      variantId: line.variant.variantId,
      supplierProductId: catalog.supplierProductId,
      supplierVariantId: catalog.supplierVariantId,
      sku: catalog.sku,
      sellerSku: line.variant.sellerSku?.trim() || null,
      title: line.product.title.trim(),
      selectedOptions: [...line.variant.selectedOptions]
        .map((option) => ({ name: option.name.trim(), value: option.value.trim() }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value)),
      imageUrl: line.variant.imageUrl.trim(),
      quantity: line.quantity,
      unitAmount: moneyFromMinor(currency.currency, unitMinor),
      lineAmount: moneyFromMinor(currency.currency, lineMinor),
      shippingAllocation: moneyFromMinor(currency.currency, shippingAllocations[index]),
    };
  });

  const subtotalMinor = lines.reduce(
    (sum, line) => sum + BigInt(line.lineAmount.value.replace('.', '')),
    BigInt(0),
  );
  const totalMinor = subtotalMinor + BigInt(shippingMinor);
  const now = dependencies.now?.() ?? new Date();

  return finalizeCanonicalOrderSnapshot({
    version: CANONICAL_ORDER_SNAPSHOT_VERSION,
    hashAlgorithm: CANONICAL_ORDER_SNAPSHOT_HASH_ALGORITHM,
    createdAt: now.toISOString(),
    destination: {
      countryIso3: input.destination.countryIso3,
      region: input.destination.region ?? null,
    },
    currency: currency.currency,
    lines,
    subtotal: moneyFromMinor(currency.currency, subtotalMinor),
    shipping: moneyFromMinor(currency.currency, shippingMinor),
    total: moneyFromMinor(currency.currency, totalMinor),
  });
}
