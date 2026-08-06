import 'server-only';

import { getDollarMultiplier } from '@/actions/shop/general/currencyConvert';
import { PAYPAL_CURRENCY_CODES } from '@/datasets/shop_general/paypal_currency_specifics';
import { getStrictCatalogVariantsBySku } from '@/lib/datasetSearchers/merchize/catalog';
import { loadExtrasBySku } from '@/lib/datasetSearchers/merchize/shipping.data';
import { fetchMerchizeJson } from '@/lib/merchizeStorefront/providerErrors';
import {
  CanonicalOrderResolutionError,
  resolveCanonicalOrderSnapshot,
  type CanonicalOrderResolverDependencies,
  type TrustedProviderProduct,
} from './resolver';
import { calculateStrictShippingQuoteUsd } from './strictShipping';
import type { CanonicalOrderResolutionInput } from './types';
import { isMerchizeStorefrontProductAvailable } from './merchizeAvailability';
import { resolveProviderStorefrontProductCompatibility } from '@/lib/merchizeStorefront/currentProductLineCompatibility';
import { STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS } from '@/lib/merchizeStorefront/strictLiveProduct';
import { mapCompatibleMerchizeVariants } from './mapCompatibleMerchizeVariants';

type LiveVariantPriceResponse = {
  data?: {
    variants?: Array<{
      _id?: unknown;
      retail_price?: unknown;
    }>;
  };
};

async function fetchCurrentVariantPrices(productId: string) {
  const merchizeBaseURL = process.env.MERCHIZE_BASE_URL;
  const merchizeAPIKey = process.env.MERCHIZE_API_KEY;
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
      `${merchizeBaseURL.replace(/\/$/, '')}/product/products/${encodeURIComponent(productId)}/variants/search`,
      {
        method: 'POST',
        headers: { 'X-API-KEY': merchizeAPIKey },
        cache: 'no-store',
      },
      { timeoutMs: STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS },
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
  const providerProduct = await resolveProviderStorefrontProductCompatibility(productLookup, {
    persist: true,
  });
  const product = providerProduct.productMetaData;
  const variants = providerProduct.productVariants;
  const productIsAvailable = isMerchizeStorefrontProductAvailable(product);
  const livePrices = productIsAvailable
    ? await fetchCurrentVariantPrices(product._id)
    : new Map<string, number>();

  return {
    productId: product._id,
    title: product.title,
    isAvailable: productIsAvailable,
    variants: productIsAvailable
      ? mapCompatibleMerchizeVariants({
          variants,
          livePrices,
          compatibilityResults: providerProduct.compatibility.results,
        })
      : [],
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
