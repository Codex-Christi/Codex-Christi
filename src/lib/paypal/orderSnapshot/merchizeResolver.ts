import 'server-only';

import {
  fetchBaseProduct,
  fetchProductVariants,
  merchizeAPIKey,
  merchizeBaseURL,
} from '@/app/shop/product/[id]/productDetailsSSR';
import { getDollarMultiplier } from '@/actions/shop/general/currencyConvert';
import { PAYPAL_CURRENCY_CODES } from '@/datasets/shop_general/paypal_currency_specifics';
import { getStrictCatalogVariantsBySku } from '@/lib/datasetSearchers/merchize/catalog';
import { loadExtrasBySku } from '@/lib/datasetSearchers/merchize/shipping.data';
import { firstStringValue, toMerchizeThumbnailUrl } from '@/lib/merchizeStorefront/imageUrls';
import { fetchMerchizeJson } from '@/lib/merchizeStorefront/providerErrors';
import type { ProductOption } from '@/lib/merchizeStorefront/productTypes';
import {
  CanonicalOrderResolutionError,
  resolveCanonicalOrderSnapshot,
  type CanonicalOrderResolverDependencies,
  type TrustedProviderProduct,
} from './resolver';
import { calculateStrictShippingQuoteUsd } from './strictShipping';
import type { CanonicalOrderResolutionInput } from './types';
import {
  isMerchizeStorefrontProductAvailable,
  isMerchizeStorefrontVariantAvailable,
} from './merchizeAvailability';

type LiveVariantPriceResponse = {
  data?: {
    variants?: Array<{
      _id?: unknown;
      retail_price?: unknown;
    }>;
  };
};

function normalizeSelectedOptions(options: ProductOption[]) {
  return options
    .map((option) => {
      const attributeName = option.attribute?.name;
      const name =
        typeof attributeName === 'string' && attributeName.trim()
          ? attributeName.trim()
          : option.name?.trim();
      const value = option.name?.trim() || option.value?.trim();
      return name && value ? { name, value } : null;
    })
    .filter((option): option is { name: string; value: string } => option !== null);
}

async function fetchCurrentVariantPrices(productId: string) {
  if (!merchizeBaseURL || !merchizeAPIKey) {
    throw new CanonicalOrderResolutionError(
      'LIVE_PRICE_UNAVAILABLE',
      'Merchize live-pricing credentials are unavailable.',
      503,
    );
  }

  let response: LiveVariantPriceResponse;
  try {
    response = await fetchMerchizeJson<LiveVariantPriceResponse>(
      `${merchizeBaseURL}/product/products/${productId}/variants/search`,
      {
        method: 'POST',
        headers: { 'X-API-KEY': merchizeAPIKey },
        next: { revalidate: 3600 },
      },
    );
  } catch (error) {
    throw new CanonicalOrderResolutionError(
      'LIVE_PRICE_UNAVAILABLE',
      `Current Merchize prices are unavailable for product ${productId}.`,
      503,
      { cause: error },
    );
  }

  const prices = new Map<string, number>();
  for (const candidate of response.data?.variants ?? []) {
    const variantId = typeof candidate._id === 'string' ? candidate._id.trim() : '';
    const price =
      typeof candidate.retail_price === 'number'
        ? candidate.retail_price
        : Number(candidate.retail_price);
    if (variantId && Number.isFinite(price) && price > 0) prices.set(variantId, price);
  }
  return prices;
}

async function resolveMerchizeProduct(productLookup: string): Promise<TrustedProviderProduct> {
  const [product, variants] = await Promise.all([
    fetchBaseProduct(productLookup),
    fetchProductVariants(productLookup),
  ]);
  const livePrices = await fetchCurrentVariantPrices(product._id);

  return {
    productId: product._id,
    title: product.title,
    isAvailable: isMerchizeStorefrontProductAvailable(product),
    variants: variants.map((variant) => {
      const livePrice = livePrices.get(variant._id);
      return {
        variantId: variant._id,
        productId: variant.product,
        sku: variant.sku,
        sellerSku: variant.sku_seller?.trim() || null,
        title: variant.title,
        selectedOptions: normalizeSelectedOptions(variant.options),
        imageUrl: toMerchizeThumbnailUrl(firstStringValue(variant.image_uris)),
        unitPriceUsd: livePrice ?? Number.NaN,
        priceSource: 'live' as const,
        // The current storefront all-variants response is the positive availability evidence.
        // Explicit retirement/hiding flags, when returned by Merchize, always fail closed.
        isAvailable: isMerchizeStorefrontVariantAvailable(variant),
      };
    }),
  };
}

export const merchizeCanonicalOrderResolverDependencies: CanonicalOrderResolverDependencies = {
  resolveProduct: resolveMerchizeProduct,
  resolveCatalogVariants: getStrictCatalogVariantsBySku,
  resolveCurrency: async (countryIso3) => {
    const conversion = await getDollarMultiplier(countryIso3);
    const currency = conversion.currency?.toUpperCase() ?? 'USD';
    const payPalSupportsCurrency = PAYPAL_CURRENCY_CODES.includes(
      currency as (typeof PAYPAL_CURRENCY_CODES)[number],
    );

    // Preserve checkout's existing supported local currencies. Unsupported provider currencies
    // retain the existing PayPal USD fallback instead of introducing an alpha-wide USD rule.
    return payPalSupportsCurrency
      ? { currency, multiplier: conversion.multiplier }
      : { currency: 'USD', multiplier: 1 };
  },
  resolveShipping: async ({ lines, catalogVariants, countryIso3 }) =>
    calculateStrictShippingQuoteUsd({
      lines,
      catalogRows: catalogVariants.map((variant) => variant.catalogRow),
      countryIso3,
      extrasBySku: await loadExtrasBySku(),
    }),
};

export async function resolveCanonicalOrderSnapshotFromMerchize(
  input: CanonicalOrderResolutionInput,
) {
  return resolveCanonicalOrderSnapshot(input, merchizeCanonicalOrderResolverDependencies);
}
