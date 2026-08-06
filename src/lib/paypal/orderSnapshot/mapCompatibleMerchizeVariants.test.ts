import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductVariantsInterface } from '@/lib/merchizeStorefront/productTypes';
import type { StorefrontVariantCompatibilityResult } from '@/lib/merchizeStorefront/productLineCompatibility';
import { mapCompatibleMerchizeVariants } from './mapCompatibleMerchizeVariants';

const variants = [
  {
    _id: 'storefront-variant-1',
    product: 'storefront-product-1',
    sku: 'STOREFRONT-SKU-1',
    sku_seller: 'OLD-SELLER-SKU',
    title: 'Medium / White',
    retail_price: 25,
    image_uris: [],
    is_default: true,
    options: [
      {
        name: 'M',
        value: 'M',
        slug: 'm',
        attribute: { name: 'Size', value_type: 'size' },
      },
    ],
  },
  {
    _id: 'storefront-variant-2',
    product: 'storefront-product-1',
    sku: 'STOREFRONT-SKU-2',
    title: 'Large / Removed',
    retail_price: 25,
    image_uris: [],
    is_default: false,
    options: [
      {
        name: 'L',
        value: 'L',
        slug: 'l',
        attribute: { name: 'Size', value_type: 'size' },
      },
    ],
  },
] as ProductVariantsInterface['data'];

function compatibility(
  variantId: string,
  status: StorefrontVariantCompatibilityResult['status'],
  supplierSku: string | null,
): StorefrontVariantCompatibilityResult {
  return {
    status,
    reasonCode:
      status === 'available' ? 'EXACT_CURRENT_PRESET_MATCH' : 'CURRENT_PRESET_MATCH_NOT_FOUND',
    storefrontProductId: 'storefront-product-1',
    storefrontVariantId: variantId,
    storefrontSku: `STOREFRONT-${variantId}`,
    productLineName: 'line',
    selectedOptions: { size: 'm' },
    supplierProductId: status === 'available' ? 'supplier-product-1' : null,
    supplierVariantId: status === 'available' ? 'supplier-variant-1' : null,
    supplierSku,
    candidateCount: status === 'available' ? 1 : 0,
    evidence: {},
  };
}

test('checkout maps only compatible variants and keeps supplier and storefront SKUs separate', () => {
  const result = mapCompatibleMerchizeVariants({
    variants,
    livePrices: new Map([['storefront-variant-1', 27.5]]),
    compatibilityResults: [
      compatibility('storefront-variant-1', 'available', 'SUPPLIER-SKU-9'),
      compatibility('storefront-variant-2', 'unavailable', null),
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].supplierProductId, 'supplier-product-1');
  assert.equal(result[0].supplierVariantId, 'supplier-variant-1');
  assert.equal(result[0].sku, 'SUPPLIER-SKU-9');
  assert.equal(result[0].sellerSku, 'STOREFRONT-SKU-1');
  assert.equal(result[0].unitPriceUsd, 27.5);
});

test('checkout excludes an available result that lacks supplier SKU proof', () => {
  const result = mapCompatibleMerchizeVariants({
    variants: variants.slice(0, 1),
    livePrices: new Map([['storefront-variant-1', 27.5]]),
    compatibilityResults: [compatibility('storefront-variant-1', 'available', null)],
  });

  assert.deepEqual(result, []);
});

test('checkout excludes available results with incomplete supplier identity proof', () => {
  const incomplete = compatibility('storefront-variant-1', 'available', 'SUPPLIER-SKU-9');
  incomplete.supplierVariantId = null;

  const result = mapCompatibleMerchizeVariants({
    variants: variants.slice(0, 1),
    livePrices: new Map([['storefront-variant-1', 27.5]]),
    compatibilityResults: [incomplete],
  });

  assert.deepEqual(result, []);
});
