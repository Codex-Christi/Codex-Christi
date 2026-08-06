import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMerchizeStorefrontProductAvailable,
  isMerchizeStorefrontVariantAvailable,
} from './merchizeAvailability';

const activeProduct = {
  is_active: true,
  is_deleted: false,
  is_private: false,
  is_taken_down: false,
  approval_status: 'approved',
  status: 'active',
};

test('accepts only complete active Merchize product publication evidence', () => {
  assert.equal(isMerchizeStorefrontProductAvailable(activeProduct), true);
  assert.equal(
    isMerchizeStorefrontProductAvailable({
      is_active: true,
      is_deleted: false,
      is_private: false,
      is_taken_down: false,
      approval_status: 'approved',
    }),
    true,
  );

  for (const unavailable of [
    { ...activeProduct, is_active: false },
    { ...activeProduct, is_deleted: true },
    { ...activeProduct, is_private: true },
    { ...activeProduct, is_taken_down: true },
    { ...activeProduct, approval_status: 'under_review' },
    { ...activeProduct, status: 'draft' },
    { ...activeProduct, status: 'retired' },
    { ...activeProduct, is_active: undefined },
  ]) {
    assert.equal(isMerchizeStorefrontProductAvailable(unavailable), false);
  }
});

test('rejects variants explicitly marked hidden, inactive, deleted, draft, or retired', () => {
  assert.equal(isMerchizeStorefrontVariantAvailable({}), true);
  assert.equal(isMerchizeStorefrontVariantAvailable({ status: 'active' }), true);

  for (const unavailable of [
    { is_active: false },
    { is_deleted: true },
    { is_hidden: true },
    { status: 'draft' },
    { status: 'retired' },
  ]) {
    assert.equal(isMerchizeStorefrontVariantAvailable(unavailable), false);
  }
});
