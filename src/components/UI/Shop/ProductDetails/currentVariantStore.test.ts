import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductVariantsInterface } from '@/lib/merchizeStorefront/productTypes';
import { findMatchingVariantForSelections } from './currentVariantStore';

type Variant = ProductVariantsInterface['data'][number];

function variant(id: string, color: string, size: string): Variant {
  return {
    _id: id,
    image_uris: [],
    retail_price: 25,
    is_default: false,
    title: `${color} ${size}`,
    sku: `STORE-${id}`,
    product: 'product-1',
    options: [
      {
        slug: color.toLowerCase(),
        value: color,
        name: color,
        attribute: { name: 'Color', value_type: 'color' },
      },
      {
        slug: size.toLowerCase() as 'm',
        value: size as 'M',
        name: size as 'M',
        attribute: { name: 'Size', value_type: 'size' },
      },
    ],
  };
}

test('matches only variants present in the verified selector input', () => {
  const verifiedVariants = [variant('verified-red-medium', 'Red', 'M')];

  assert.equal(
    findMatchingVariantForSelections(verifiedVariants, { color: 'Red', size: 'M' })?._id,
    'verified-red-medium',
  );
  assert.equal(
    findMatchingVariantForSelections(verifiedVariants, { color: 'Blue', size: 'M' }),
    undefined,
  );
});

test('does not return a variant until every selectable attribute is chosen', () => {
  const verifiedVariants = [variant('verified-red-medium', 'Red', 'M')];

  assert.equal(
    findMatchingVariantForSelections(verifiedVariants, { color: 'Red', size: null }),
    undefined,
  );
});

test('auto-resolves one verified variant when there are no customer-selectable attributes', () => {
  const onlyVariant: Variant = {
    ...variant('verified-single', 'Red', 'M'),
    options: [
      {
        value: 'Classic Tee',
        name: 'Classic Tee',
        attribute: { name: 'Product', value_type: 'product' },
      },
    ],
  };

  assert.equal(findMatchingVariantForSelections([onlyVariant], {})?._id, 'verified-single');
  assert.equal(
    findMatchingVariantForSelections([onlyVariant, { ...onlyVariant, _id: 'second' }], {}),
    undefined,
  );
});
