import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchStorefrontVariantToCurrentPresets,
  parseCurrentProductLinePresetSearchResponse,
  parseStorefrontAllVariantsResponse,
  planCompatibilityIncidentMutation,
  resultFromCurrentCatalogSku,
  type CurrentProductLinePreset,
  type StorefrontVariant,
} from './productLineCompatibility';

function storefrontVariant(overrides: Partial<StorefrontVariant> = {}): StorefrontVariant {
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
      {
        name: 'Christi',
        value: 'Christi',
        slug: 'christi',
        attribute: { name: 'label', value_type: 'label' },
      },
    ],
    ...overrides,
  } as StorefrontVariant;
}

function currentPreset(
  variants: Array<{ _id: string; sku: string; options: unknown[] }>,
  overrides: Partial<CurrentProductLinePreset> = {},
): CurrentProductLinePreset {
  return {
    _id: 'supplier-product-1',
    sku: 'long_sleeve_db',
    title: 'Long Sleeve DB',
    variants,
    ...overrides,
  };
}

const matchingOptions = [
  { attribute_type: 'size', value: 'M' },
  { attribute_type: 'color', value: 'Chalky Mint' },
];

test('proves a storefront variant only through an exact current product line and options', () => {
  const result = matchStorefrontVariantToCurrentPresets(storefrontVariant(), [
    currentPreset([{ _id: 'supplier-variant-1', sku: 'SUPPLIER-SKU-9', options: matchingOptions }]),
  ]);

  assert.equal(result.status, 'available');
  assert.equal(result.reasonCode, 'EXACT_CURRENT_PRESET_MATCH');
  assert.equal(result.storefrontSku, 'STORE-SKU-1');
  assert.equal(result.supplierProductId, 'supplier-product-1');
  assert.equal(result.supplierVariantId, 'supplier-variant-1');
  assert.equal(result.supplierSku, 'SUPPLIER-SKU-9');
  assert.deepEqual(result.selectedOptions, {
    size: 'm',
    color: 'chalkymint',
    label: 'christi',
  });
});

test('does not accept an option match from a fuzzy product-line search result', () => {
  const result = matchStorefrontVariantToCurrentPresets(storefrontVariant(), [
    currentPreset(
      [{ _id: 'supplier-variant-1', sku: 'SUPPLIER-SKU-9', options: matchingOptions }],
      { sku: 'long_sleeve_db_old', title: 'Long Sleeve DB Old' },
    ),
  ]);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_MATCH_NOT_FOUND');
  assert.equal(result.evidence.exactProductLinePresetCount, 0);
});

test('requires an unambiguous exact production-option match', () => {
  const result = matchStorefrontVariantToCurrentPresets(storefrontVariant(), [
    currentPreset([
      { _id: 'supplier-variant-1', sku: 'SUPPLIER-SKU-1', options: matchingOptions },
      { _id: 'supplier-variant-2', sku: 'SUPPLIER-SKU-2', options: matchingOptions },
    ]),
  ]);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_MATCH_AMBIGUOUS');
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(
    (result.evidence.ambiguousCandidates as Array<{ supplierVariantId: string }>).map(
      (candidate) => candidate.supplierVariantId,
    ),
    ['supplier-variant-1', 'supplier-variant-2'],
  );
});

test('rejects a changed current production option while ignoring non-production label metadata', () => {
  const result = matchStorefrontVariantToCurrentPresets(storefrontVariant(), [
    currentPreset([
      {
        _id: 'supplier-variant-1',
        sku: 'SUPPLIER-SKU-1',
        options: [
          { attribute_type: 'size', value: 'M' },
          { attribute_type: 'color', value: 'White' },
        ],
      },
    ]),
  ]);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_MATCH_NOT_FOUND');
});

test('rejects an obsolete storefront production option that the current line no longer defines', () => {
  const variant = storefrontVariant({
    options: [
      ...storefrontVariant().options,
      {
        name: 'Vintage',
        value: 'Vintage',
        slug: 'vintage',
        attribute: { name: 'Material', value_type: 'material' },
      },
    ] as unknown as StorefrontVariant['options'],
  });
  const result = matchStorefrontVariantToCurrentPresets(variant, [
    currentPreset([{ _id: 'supplier-variant-1', sku: 'SUPPLIER-SKU-1', options: matchingOptions }]),
  ]);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'CURRENT_PRESET_MATCH_NOT_FOUND');
});

test('missing Product option needs exact SKU membership in a complete catalog generation', () => {
  const variant = storefrontVariant({
    options: storefrontVariant().options.filter(
      (option) => option.attribute?.value_type !== 'product',
    ) as StorefrontVariant['options'],
  });
  const identity = {
    supplierProductId: 'supplier-product-2',
    supplierVariantId: 'supplier-variant-2',
    supplierSku: 'STORE-SKU-1',
  };

  assert.equal(resultFromCurrentCatalogSku(variant, identity, true).status, 'available');
  assert.equal(
    resultFromCurrentCatalogSku(variant, null, true).reasonCode,
    'CURRENT_CATALOG_SKU_NOT_FOUND',
  );
  assert.equal(
    resultFromCurrentCatalogSku(variant, identity, false).reasonCode,
    'CURRENT_CATALOG_GENERATION_UNAVAILABLE',
  );
});

test('malformed provider preset shapes are transient errors, not empty current catalogs', () => {
  assert.throws(
    () =>
      parseCurrentProductLinePresetSearchResponse({
        success: false,
        data: { presets: [] },
      }),
    /unsuccessful/,
  );
  assert.throws(() => parseCurrentProductLinePresetSearchResponse({}), /data object/);
  assert.throws(() => parseCurrentProductLinePresetSearchResponse({ data: {} }), /presets array/);
  assert.throws(
    () => parseCurrentProductLinePresetSearchResponse({ data: { presets: [{ sku: 'line' }] } }),
    /variants array/,
  );
  assert.throws(
    () =>
      parseCurrentProductLinePresetSearchResponse({
        data: { presets: [{ sku: 'line', variants: [null] }] },
      }),
    /malformed variant/,
  );
  assert.deepEqual(parseCurrentProductLinePresetSearchResponse({ data: { presets: [] } }), []);
});

test('incident planning avoids healthy/transient clutter and advances only a reopened episode', () => {
  assert.deepEqual(
    planCompatibilityIncidentMutation(
      { status: 'available', reasonCode: 'EXACT_CURRENT_PRESET_MATCH' },
      null,
    ),
    { action: 'none' },
  );
  assert.deepEqual(
    planCompatibilityIncidentMutation(
      { status: 'unverified', reasonCode: 'CURRENT_PRESET_PROVIDER_UNAVAILABLE' },
      { status: 'unavailable', incidentEpisode: 4 },
    ),
    { action: 'none' },
  );
  assert.deepEqual(
    planCompatibilityIncidentMutation(
      { status: 'available', reasonCode: 'EXACT_CURRENT_PRESET_MATCH' },
      { status: 'unavailable', incidentEpisode: 4 },
    ),
    { action: 'resolve', incidentEpisode: 4 },
  );
  assert.deepEqual(
    planCompatibilityIncidentMutation(
      { status: 'unavailable', reasonCode: 'CURRENT_PRESET_MATCH_NOT_FOUND' },
      { status: 'resolved', incidentEpisode: 4 },
    ),
    { action: 'update', incidentEpisode: 5 },
  );
});

test('malformed all-variants payload cannot masquerade as an empty current response', () => {
  assert.throws(() => parseStorefrontAllVariantsResponse({ data: null }), /variants array/);
  assert.throws(() => parseStorefrontAllVariantsResponse({ data: [null] }), /malformed variant/);
  assert.deepEqual(parseStorefrontAllVariantsResponse({ data: [] }), []);
});
