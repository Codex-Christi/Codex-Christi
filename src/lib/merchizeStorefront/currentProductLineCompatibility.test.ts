import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCurrentProductLineCompatibility,
  type CurrentProductLineCompatibilityDependencies,
} from './currentProductLineCompatibility';
import {
  isManualRepairProductLineReason,
  type CurrentProductLinePreset,
  type ProductLineSupplierIdentity,
  type StorefrontVariant,
} from './productLineCompatibility';

const EXPECTED_IDENTITY: ProductLineSupplierIdentity = {
  supplierProductId: 'supplier-product-1',
  supplierVariantId: 'supplier-variant-1',
  supplierSku: 'SUPPLIER-SKU-9',
};

function storefrontVariant(): StorefrontVariant {
  return {
    _id: 'storefront-variant-1',
    product: 'storefront-product-1',
    sku: 'STORE-SKU-1',
    title: 'Medium / Chalky Mint',
    retail_price: 29,
    image_uris: [],
    is_default: false,
    options: [
      {
        name: 'long_sleeve_db',
        value: 'long_sleeve_db',
        attribute: { name: 'Product', value_type: 'product' },
      },
      {
        name: 'M',
        value: 'M',
        slug: 'm',
        attribute: { name: 'Size', value_type: 'size' },
      },
      {
        name: 'Chalky Mint',
        value: 'Chalky Mint',
        slug: 'chalky-mint',
        attribute: { name: 'Color', value_type: 'color' },
      },
    ],
  } as StorefrontVariant;
}

function currentPreset(): CurrentProductLinePreset {
  return {
    _id: EXPECTED_IDENTITY.supplierProductId,
    sku: 'long_sleeve_db',
    title: 'Long Sleeve DB',
    variants: [
      {
        _id: EXPECTED_IDENTITY.supplierVariantId,
        sku: EXPECTED_IDENTITY.supplierSku,
        options: [
          { attribute_type: 'size', value: 'M' },
          { attribute_type: 'color', value: 'Chalky Mint' },
        ],
      },
    ],
  };
}

async function resolveWithCatalog(
  resolveCurrentCatalogVariants: CurrentProductLineCompatibilityDependencies['resolveCurrentCatalogVariants'],
) {
  const requestedCatalogSkus: string[][] = [];
  const resolution = await resolveCurrentProductLineCompatibility([storefrontVariant()], {
    persist: false,
    dependencies: {
      async fetchCurrentPresets() {
        return [currentPreset()];
      },
      async resolveCurrentCatalogVariants(skus) {
        requestedCatalogSkus.push(skus);
        return resolveCurrentCatalogVariants(skus);
      },
    },
  });
  return { resolution, requestedCatalogSkus };
}

test('keeps a preset-backed variant sellable only when the completed catalog identity matches exactly', async () => {
  const { resolution, requestedCatalogSkus } = await resolveWithCatalog(async () => ({
    generationAvailable: true,
    variants: [EXPECTED_IDENTITY],
  }));

  assert.deepEqual(requestedCatalogSkus, [[EXPECTED_IDENTITY.supplierSku]]);
  assert.equal(resolution.results[0].status, 'available');
  assert.equal(resolution.results[0].reasonCode, 'EXACT_CURRENT_PRESET_AND_CATALOG_MATCH');
  assert.equal(resolution.sellableVariants.length, 1);
});

test('blocks and diagnoses a preset-backed variant whose supplier SKU is absent from the completed catalog', async () => {
  const { resolution } = await resolveWithCatalog(async () => ({
    generationAvailable: true,
    variants: [],
  }));

  const result = resolution.results[0];
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_CATALOG_SKU_NOT_FOUND');
  assert.equal(isManualRepairProductLineReason(result.reasonCode), true);
  assert.deepEqual(result.evidence.presetSupplierIdentity, EXPECTED_IDENTITY);
  assert.equal(result.evidence.currentCatalogIdentity, null);
  assert.equal(resolution.sellableVariants.length, 0);
});

test('blocks and diagnoses a preset/catalog supplier product ID mismatch', async () => {
  const catalogIdentity = {
    ...EXPECTED_IDENTITY,
    supplierProductId: 'different-supplier-product',
  };
  const { resolution } = await resolveWithCatalog(async () => ({
    generationAvailable: true,
    variants: [catalogIdentity],
  }));

  const result = resolution.results[0];
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_CATALOG_PRODUCT_ID_MISMATCH');
  assert.equal(isManualRepairProductLineReason(result.reasonCode), true);
  assert.deepEqual(result.evidence.currentCatalogIdentity, catalogIdentity);
  assert.equal(resolution.sellableVariants.length, 0);
});

test('blocks and diagnoses a preset/catalog supplier variant ID mismatch', async () => {
  const catalogIdentity = {
    ...EXPECTED_IDENTITY,
    supplierVariantId: 'different-supplier-variant',
  };
  const { resolution } = await resolveWithCatalog(async () => ({
    generationAvailable: true,
    variants: [catalogIdentity],
  }));

  const result = resolution.results[0];
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_CATALOG_VARIANT_ID_MISMATCH');
  assert.equal(isManualRepairProductLineReason(result.reasonCode), true);
  assert.deepEqual(result.evidence.currentCatalogIdentity, catalogIdentity);
  assert.equal(resolution.sellableVariants.length, 0);
});

test('fails closed as unverified when no completed supplier-catalog generation is available', async () => {
  const { resolution } = await resolveWithCatalog(async () => ({
    generationAvailable: false,
    variants: [],
  }));

  assert.equal(resolution.results[0].status, 'unverified');
  assert.equal(resolution.results[0].reasonCode, 'CURRENT_CATALOG_GENERATION_UNAVAILABLE');
  assert.equal(resolution.sellableVariants.length, 0);
});

test('fails closed as unverified when the completed-catalog lookup throws', async () => {
  const { resolution } = await resolveWithCatalog(async () => {
    throw new Error('catalog unavailable');
  });

  assert.equal(resolution.results[0].status, 'unverified');
  assert.equal(resolution.results[0].reasonCode, 'CURRENT_CATALOG_LOOKUP_UNAVAILABLE');
  assert.deepEqual(resolution.results[0].evidence.presetSupplierIdentity, EXPECTED_IDENTITY);
  assert.equal(resolution.sellableVariants.length, 0);
});
