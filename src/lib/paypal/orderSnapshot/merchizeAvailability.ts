type MerchizeProductAvailabilityEvidence = {
  is_active?: unknown;
  is_deleted?: unknown;
  is_private?: unknown;
  is_taken_down?: unknown;
  approval_status?: unknown;
  status?: unknown;
};

type MerchizeVariantAvailabilityEvidence = {
  is_active?: unknown;
  is_deleted?: unknown;
  is_hidden?: unknown;
  status?: unknown;
};

/**
 * Merchize's product response carries explicit publication state. Requiring the complete active
 * state prevents a stale, private, retired, or under-review product from reaching PayPal.
 */
export function isMerchizeStorefrontProductAvailable(
  product: MerchizeProductAvailabilityEvidence,
) {
  const status =
    typeof product.status === 'string' ? product.status.trim().toLowerCase() : null;

  return (
    product.is_active === true &&
    product.is_deleted === false &&
    product.is_private === false &&
    product.is_taken_down === false &&
    typeof product.approval_status === 'string' &&
    product.approval_status.trim().toLowerCase() === 'approved' &&
    (!status || status === 'active')
  );
}

/**
 * Membership in Merchize's current storefront all-variants response is positive availability
 * evidence. Any explicit inactive/deleted/hidden/non-active state overrides that evidence.
 */
export function isMerchizeStorefrontVariantAvailable(
  variant: MerchizeVariantAvailabilityEvidence,
) {
  const status =
    typeof variant.status === 'string' ? variant.status.trim().toLowerCase() : null;

  return (
    variant.is_active !== false &&
    variant.is_deleted !== true &&
    variant.is_hidden !== true &&
    (!status || status === 'active')
  );
}
