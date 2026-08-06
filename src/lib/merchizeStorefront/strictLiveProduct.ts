import { fetchMerchizeJson } from './providerErrors';
import {
  parseStorefrontAllVariantsResponse,
  type StorefrontVariant,
} from './productLineCompatibility';
import { assertBasicStorefrontProductData } from './snapshot';
import type { BasicProductInterface } from './productTypes';

export const STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS = 15_000;
const MAX_STOREFRONT_LOOKUP_LENGTH = 128;

export type StrictLiveStorefrontProductDetails = {
  product: BasicProductInterface['data'];
  variants: StorefrontVariant[];
};

function getStorefrontCredentials() {
  const baseUrl = process.env.MERCHIZE_BASE_URL;
  const apiKey = process.env.MERCHIZE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('Merchize storefront credentials are unavailable.');
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

function normalizeProductLookup(value: string) {
  const lookup = typeof value === 'string' ? value.trim() : '';
  if (!lookup || lookup.length > MAX_STOREFRONT_LOOKUP_LENGTH) {
    throw new Error('Merchize storefront product identity is invalid.');
  }
  return lookup;
}

async function fetchStrictLiveStorefrontProduct(productLookup: string) {
  const lookup = normalizeProductLookup(productLookup);
  const { baseUrl, apiKey } = getStorefrontCredentials();
  const response = await fetchMerchizeJson<BasicProductInterface>(
    `${baseUrl}/product/products/${encodeURIComponent(lookup)}`,
    { headers: { 'X-API-KEY': apiKey }, cache: 'no-store' },
    { timeoutMs: STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS },
  );
  const product = assertBasicStorefrontProductData(response.data, `Merchize product ${lookup}`);
  if (product._id !== lookup && product.slug !== lookup) {
    throw new Error(`Merchize product response identity did not match ${lookup}.`);
  }
  return product;
}

async function fetchStrictLiveStorefrontVariants(productLookup: string) {
  const lookup = normalizeProductLookup(productLookup);
  const { baseUrl, apiKey } = getStorefrontCredentials();
  const response = await fetchMerchizeJson<unknown>(
    `${baseUrl}/product/products/${encodeURIComponent(lookup)}/all-variants`,
    { headers: { 'X-API-KEY': apiKey }, cache: 'no-store' },
    { timeoutMs: STRICT_STOREFRONT_PROVIDER_TIMEOUT_MS },
  );
  return parseStorefrontAllVariantsResponse(response);
}

/**
 * Authoritative storefront read for availability and checkout. This path intentionally never
 * reads or falls back to the durable display snapshot.
 */
export async function fetchStrictLiveStorefrontProductDetails(
  productLookup: string,
): Promise<StrictLiveStorefrontProductDetails> {
  const [product, variants] = await Promise.all([
    fetchStrictLiveStorefrontProduct(productLookup),
    fetchStrictLiveStorefrontVariants(productLookup),
  ]);

  if (variants.some((variant) => variant.product !== product._id)) {
    throw new Error('Merchize all-variants response returned a mismatched product identity.');
  }
  if (new Set(variants.map((variant) => variant._id)).size !== variants.length) {
    throw new Error('Merchize all-variants response returned duplicate variant identities.');
  }

  return { product, variants };
}
