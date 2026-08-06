import type { ProductVariantsInterface } from './productTypes';

export type StorefrontVariant = ProductVariantsInterface['data'][number];

export type CurrentProductLineVariant = {
  _id?: unknown;
  sku?: unknown;
  options?: unknown;
};

export type CurrentProductLinePreset = {
  _id?: unknown;
  sku?: unknown;
  title?: unknown;
  variants?: unknown;
};

export type ProductLineCompatibilityReasonCode =
  | 'EXACT_CURRENT_PRESET_MATCH'
  | 'EXACT_CURRENT_PRESET_AND_CATALOG_MATCH'
  | 'EXACT_CURRENT_CATALOG_SKU_MATCH'
  | 'STOREFRONT_PRODUCT_EXPLICITLY_UNAVAILABLE'
  | 'STOREFRONT_VARIANT_NO_LONGER_RETURNED'
  | 'STOREFRONT_VARIANT_EXPLICITLY_UNAVAILABLE'
  | 'CURRENT_PRESET_MATCH_NOT_FOUND'
  | 'CURRENT_PRESET_MATCH_AMBIGUOUS'
  | 'CURRENT_PRESET_IDENTITY_INCOMPLETE'
  | 'CURRENT_PRESET_PROVIDER_UNAVAILABLE'
  | 'CURRENT_CATALOG_GENERATION_UNAVAILABLE'
  | 'CURRENT_CATALOG_SKU_NOT_FOUND'
  | 'CURRENT_PRESET_CATALOG_SKU_NOT_FOUND'
  | 'CURRENT_PRESET_CATALOG_PRODUCT_ID_MISMATCH'
  | 'CURRENT_PRESET_CATALOG_VARIANT_ID_MISMATCH'
  | 'CURRENT_CATALOG_LOOKUP_UNAVAILABLE';

export type ProductLineCompatibilityStatus = 'available' | 'unavailable' | 'unverified';

export type ProductLineSupplierIdentity = {
  supplierProductId: string;
  supplierVariantId: string;
  supplierSku: string;
};

export type StorefrontVariantCompatibilityResult = {
  status: ProductLineCompatibilityStatus;
  reasonCode: ProductLineCompatibilityReasonCode;
  storefrontProductId: string;
  storefrontVariantId: string;
  storefrontSku: string | null;
  productLineName: string | null;
  selectedOptions: Record<string, string>;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  supplierSku: string | null;
  candidateCount: number;
  evidence: Record<string, unknown>;
};

type ParsedStorefrontVariant = {
  productLineName: string | null;
  selectedOptions: Map<string, string>;
};

type ParsedCurrentCandidate = {
  supplierProductId: string | null;
  supplierVariantId: string | null;
  supplierSku: string | null;
  selectedOptions: Map<string, string>;
};

const MAX_EVIDENCE_OPTIONS = 16;
const MAX_EVIDENCE_CANDIDATES = 12;
const MAX_EVIDENCE_TEXT_LENGTH = 160;
const MAX_VARIANT_OPTIONS = 32;
const MAX_PROVIDER_PRESETS_PER_LINE = 100;
const MAX_PROVIDER_VARIANTS_PER_LINE = 10_000;
const NON_PRODUCTION_STOREFRONT_OPTION_KEYS = new Set(['label']);

export const MANUAL_REPAIR_PRODUCT_LINE_REASON_CODES = new Set<ProductLineCompatibilityReasonCode>([
  'STOREFRONT_VARIANT_EXPLICITLY_UNAVAILABLE',
  'CURRENT_PRESET_MATCH_NOT_FOUND',
  'CURRENT_PRESET_MATCH_AMBIGUOUS',
  'CURRENT_CATALOG_SKU_NOT_FOUND',
  'CURRENT_PRESET_CATALOG_SKU_NOT_FOUND',
  'CURRENT_PRESET_CATALOG_PRODUCT_ID_MISMATCH',
  'CURRENT_PRESET_CATALOG_VARIANT_ID_MISMATCH',
]);

export const TRANSIENT_PRODUCT_LINE_REASON_CODES = new Set<ProductLineCompatibilityReasonCode>([
  'CURRENT_PRESET_IDENTITY_INCOMPLETE',
  'CURRENT_PRESET_PROVIDER_UNAVAILABLE',
  'CURRENT_CATALOG_GENERATION_UNAVAILABLE',
  'CURRENT_CATALOG_LOOKUP_UNAVAILABLE',
]);

export function isManualRepairProductLineReason(reasonCode: ProductLineCompatibilityReasonCode) {
  return MANUAL_REPAIR_PRODUCT_LINE_REASON_CODES.has(reasonCode);
}

export function isTransientProductLineReason(reasonCode: ProductLineCompatibilityReasonCode) {
  return TRANSIENT_PRODUCT_LINE_REASON_CODES.has(reasonCode);
}

export type CompatibilityIncidentMutationPlan =
  | { action: 'none' }
  | { action: 'create'; incidentEpisode: 1 }
  | { action: 'update'; incidentEpisode: number }
  | { action: 'resolve'; incidentEpisode: number };

export function planCompatibilityIncidentMutation(
  result: Pick<StorefrontVariantCompatibilityResult, 'status' | 'reasonCode'>,
  existing: { status: string; incidentEpisode: number } | null,
): CompatibilityIncidentMutationPlan {
  if (isTransientProductLineReason(result.reasonCode)) return { action: 'none' };

  if (result.status === 'available') {
    return existing && ['unavailable', 'unverified'].includes(existing.status)
      ? { action: 'resolve', incidentEpisode: existing.incidentEpisode }
      : { action: 'none' };
  }

  if (result.status !== 'unavailable' || !isManualRepairProductLineReason(result.reasonCode)) {
    return { action: 'none' };
  }
  if (!existing) return { action: 'create', incidentEpisode: 1 };

  return {
    action: 'update',
    incidentEpisode:
      existing.status === 'available' || existing.status === 'resolved'
        ? existing.incidentEpisode + 1
        : existing.incidentEpisode,
  };
}

export function normalizeProductLineCompatibilityToken(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function parseCurrentProductLinePresetSearchResponse(
  value: unknown,
): CurrentProductLinePreset[] {
  if (!value || typeof value !== 'object') {
    throw new Error('Merchize current product-line search returned an invalid response.');
  }
  if ((value as { success?: unknown }).success === false) {
    throw new Error('Merchize current product-line search reported an unsuccessful response.');
  }
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    throw new Error('Merchize current product-line search omitted its data object.');
  }
  const presets = (data as { presets?: unknown }).presets;
  if (!Array.isArray(presets)) {
    throw new Error('Merchize current product-line search omitted its presets array.');
  }
  if (presets.length > MAX_PROVIDER_PRESETS_PER_LINE) {
    throw new Error('Merchize current product-line search exceeded its bounded preset count.');
  }

  let variantCount = 0;
  const parsed = presets.map((preset) => {
    if (!preset || typeof preset !== 'object') {
      throw new Error('Merchize current product-line search returned a malformed preset.');
    }
    const typedPreset = preset as CurrentProductLinePreset;
    if (
      [typedPreset._id, typedPreset.sku, typedPreset.title].some(
        (candidate) => typeof candidate === 'string' && candidate.length > MAX_EVIDENCE_TEXT_LENGTH,
      )
    ) {
      throw new Error('Merchize current product-line preset exceeded its bounded identity length.');
    }
    const variants = typedPreset.variants;
    if (!Array.isArray(variants)) {
      throw new Error('Merchize current product-line preset omitted its variants array.');
    }
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object') {
        throw new Error('Merchize current product-line search returned a malformed variant.');
      }
      const typedVariant = variant as CurrentProductLineVariant;
      if (
        [typedVariant._id, typedVariant.sku].some(
          (candidate) =>
            typeof candidate === 'string' && candidate.length > MAX_EVIDENCE_TEXT_LENGTH,
        )
      ) {
        throw new Error(
          'Merchize current product-line variant exceeded its bounded identity length.',
        );
      }
      const options = typedVariant.options;
      if (!Array.isArray(options)) {
        throw new Error('Merchize current product-line variant omitted its options array.');
      }
      if (options.length > MAX_VARIANT_OPTIONS) {
        throw new Error('Merchize current product-line variant exceeded its bounded option count.');
      }
      for (const option of options) {
        if (!option || typeof option !== 'object') {
          throw new Error('Merchize current product-line variant returned a malformed option.');
        }
        if (
          Object.values(option as Record<string, unknown>).some(
            (candidate) =>
              typeof candidate === 'string' && candidate.length > MAX_EVIDENCE_TEXT_LENGTH,
          )
        ) {
          throw new Error('Merchize current product-line option exceeded its bounded text length.');
        }
      }
    }
    variantCount += variants.length;
    if (variantCount > MAX_PROVIDER_VARIANTS_PER_LINE) {
      throw new Error('Merchize current product-line search exceeded its bounded variant count.');
    }
    return preset as CurrentProductLinePreset;
  });

  return parsed;
}

export function parseStorefrontAllVariantsResponse(value: unknown): StorefrontVariant[] {
  if (!value || typeof value !== 'object') {
    throw new Error('Merchize all-variants returned an invalid response.');
  }
  if ((value as { success?: unknown }).success === false) {
    throw new Error('Merchize all-variants reported an unsuccessful response.');
  }
  const variants = (value as { data?: unknown }).data;
  if (!Array.isArray(variants)) {
    throw new Error('Merchize all-variants response omitted its variants array.');
  }

  const parsed = variants.map((variant) => {
    if (!variant || typeof variant !== 'object') {
      throw new Error('Merchize all-variants returned a malformed variant.');
    }
    const candidate = variant as Partial<StorefrontVariant>;
    if (
      !nonEmptyString(candidate._id) ||
      !nonEmptyString(candidate.product) ||
      typeof candidate.sku !== 'string' ||
      !Array.isArray(candidate.options)
    ) {
      throw new Error('Merchize all-variants returned incomplete variant identity.');
    }
    return candidate as StorefrontVariant;
  });
  assertStorefrontVariantCompatibilityInputBounds(parsed);
  return parsed;
}

export function assertStorefrontVariantCompatibilityInputBounds(variants: StorefrontVariant[]) {
  for (const variant of variants) {
    if (variant.options.length > MAX_VARIANT_OPTIONS) {
      throw new Error('Storefront variant exceeded its bounded option count.');
    }
    const strings: unknown[] = [variant._id, variant.product, variant.sku, variant.title];
    for (const option of variant.options) {
      strings.push(
        option.name,
        option.value,
        option.slug,
        option.attribute?.name,
        option.attribute?.value_type,
      );
    }
    if (
      strings.some(
        (candidate) => typeof candidate === 'string' && candidate.length > MAX_EVIDENCE_TEXT_LENGTH,
      )
    ) {
      throw new Error('Storefront variant exceeded its bounded identity or option length.');
    }
  }
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedText(value: unknown) {
  return nonEmptyString(value)?.slice(0, MAX_EVIDENCE_TEXT_LENGTH) ?? null;
}

export function summarizeStorefrontVariantOptions(variant: StorefrontVariant) {
  return (Array.isArray(variant.options) ? variant.options : [])
    .slice(0, MAX_EVIDENCE_OPTIONS)
    .map((option) => ({
      attributeName: boundedText(option?.attribute?.name),
      attributeType: boundedText(option?.attribute?.value_type),
      name: boundedText(option?.name),
      value: boundedText(option?.value),
      slug: boundedText(option?.slug),
    }));
}

export function parseStorefrontVariantCompatibilityInput(
  variant: StorefrontVariant,
): ParsedStorefrontVariant {
  const selectedOptions = new Map<string, string>();
  let productLineName: string | null = null;

  for (const option of Array.isArray(variant.options) ? variant.options : []) {
    const attributeName = nonEmptyString(option?.attribute?.name);
    const valueType = nonEmptyString(option?.attribute?.value_type);
    const key = normalizeProductLineCompatibilityToken(attributeName ?? valueType);
    if (!key) continue;

    if (key === 'product' || normalizeProductLineCompatibilityToken(valueType) === 'product') {
      productLineName = nonEmptyString(option.name) ?? nonEmptyString(option.value);
      continue;
    }

    const rawValue =
      key === 'color'
        ? (nonEmptyString(option.slug) ??
          nonEmptyString(option.name) ??
          nonEmptyString(option.value))
        : (nonEmptyString(option.slug) ??
          nonEmptyString(option.value) ??
          nonEmptyString(option.name));
    const normalizedValue = normalizeProductLineCompatibilityToken(rawValue);
    if (normalizedValue) selectedOptions.set(key, normalizedValue);
  }

  return { productLineName, selectedOptions };
}

function parseCurrentVariantOptions(variant: CurrentProductLineVariant) {
  const selectedOptions = new Map<string, string>();
  if (!Array.isArray(variant.options)) return selectedOptions;

  for (const rawOption of variant.options) {
    if (!rawOption || typeof rawOption !== 'object') continue;
    const option = rawOption as Record<string, unknown>;
    const attribute =
      option.attribute && typeof option.attribute === 'object'
        ? (option.attribute as Record<string, unknown>)
        : null;
    const key = normalizeProductLineCompatibilityToken(
      option.attribute_type ?? attribute?.name ?? attribute?.value_type,
    );
    const value = normalizeProductLineCompatibilityToken(option.value ?? option.name);
    if (key && value && key !== 'product' && !NON_PRODUCTION_STOREFRONT_OPTION_KEYS.has(key)) {
      selectedOptions.set(key, value);
    }
  }

  return selectedOptions;
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function exactProductLinePresets(
  presets: CurrentProductLinePreset[],
  productLineName: string | null,
) {
  const target = normalizeProductLineCompatibilityToken(productLineName);
  if (!target) return [];

  // The search endpoint can be fuzzy. Only an exact normalized match against the provider's
  // product-line SKU or title is allowed to become positive availability evidence.
  return presets.filter((preset) =>
    [preset.sku, preset.title].some(
      (identity) => normalizeProductLineCompatibilityToken(identity) === target,
    ),
  );
}

function parseCurrentCandidates(presets: CurrentProductLinePreset[]) {
  const candidates: ParsedCurrentCandidate[] = [];

  for (const preset of presets) {
    const supplierProductId = nonEmptyString(preset._id);
    if (!Array.isArray(preset.variants)) continue;

    for (const rawVariant of preset.variants) {
      if (!rawVariant || typeof rawVariant !== 'object') continue;
      const variant = rawVariant as CurrentProductLineVariant;
      const supplierVariantId = nonEmptyString(variant._id);
      const supplierSku = nonEmptyString(variant.sku);
      candidates.push({
        supplierProductId,
        supplierVariantId,
        supplierSku,
        selectedOptions: parseCurrentVariantOptions(variant),
      });
    }
  }

  return candidates;
}

function candidateEvidence(candidate: ParsedCurrentCandidate) {
  return {
    supplierProductId: boundedText(candidate.supplierProductId),
    supplierVariantId: boundedText(candidate.supplierVariantId),
    supplierSku: boundedText(candidate.supplierSku),
    selectedOptions: Object.fromEntries(
      [...candidate.selectedOptions]
        .slice(0, MAX_EVIDENCE_OPTIONS)
        .map(([key, value]) => [boundedText(key), boundedText(value)]),
    ),
  };
}

function baseResult(
  variant: StorefrontVariant,
  parsed: ParsedStorefrontVariant,
): Pick<
  StorefrontVariantCompatibilityResult,
  | 'storefrontProductId'
  | 'storefrontVariantId'
  | 'storefrontSku'
  | 'productLineName'
  | 'selectedOptions'
> {
  return {
    storefrontProductId: nonEmptyString(variant.product) ?? '',
    storefrontVariantId: nonEmptyString(variant._id) ?? '',
    storefrontSku: nonEmptyString(variant.sku),
    productLineName: parsed.productLineName,
    selectedOptions: Object.fromEntries(parsed.selectedOptions),
  };
}

export function matchStorefrontVariantToCurrentPresets(
  variant: StorefrontVariant,
  presets: CurrentProductLinePreset[],
): StorefrontVariantCompatibilityResult {
  const parsed = parseStorefrontVariantCompatibilityInput(variant);
  const common = baseResult(variant, parsed);
  const matchingPresets = exactProductLinePresets(presets, parsed.productLineName);
  const currentCandidates = parseCurrentCandidates(matchingPresets);
  const targetProductionOptions = new Map(
    [...parsed.selectedOptions].filter(([key]) => !NON_PRODUCTION_STOREFRONT_OPTION_KEYS.has(key)),
  );
  const candidates = currentCandidates.filter((candidate) =>
    mapsEqual(targetProductionOptions, candidate.selectedOptions),
  );
  const commonEvidence = {
    returnedPresetCount: presets.length,
    exactProductLinePresetCount: matchingPresets.length,
    currentProductLineVariantCount: currentCandidates.length,
    storefrontOptions: summarizeStorefrontVariantOptions(variant),
    ignoredNonProductionOptionKeys: [...parsed.selectedOptions.keys()].filter((key) =>
      NON_PRODUCTION_STOREFRONT_OPTION_KEYS.has(key),
    ),
  };

  if (candidates.length === 0) {
    return {
      ...common,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_MATCH_NOT_FOUND',
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: 0,
      evidence: {
        ...commonEvidence,
        currentCandidateSample: currentCandidates
          .slice(0, MAX_EVIDENCE_CANDIDATES)
          .map(candidateEvidence),
        currentCandidateSampleTruncated: currentCandidates.length > MAX_EVIDENCE_CANDIDATES,
      },
    };
  }

  if (candidates.length > 1) {
    return {
      ...common,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_MATCH_AMBIGUOUS',
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: candidates.length,
      evidence: {
        ...commonEvidence,
        ambiguousCandidates: candidates.slice(0, MAX_EVIDENCE_CANDIDATES).map(candidateEvidence),
        ambiguousCandidatesTruncated: candidates.length > MAX_EVIDENCE_CANDIDATES,
      },
    };
  }

  const match = candidates[0];
  if (!match.supplierProductId || !match.supplierVariantId || !match.supplierSku) {
    return {
      ...common,
      status: 'unverified',
      reasonCode: 'CURRENT_PRESET_IDENTITY_INCOMPLETE',
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: 1,
      evidence: {
        ...commonEvidence,
        incompleteCandidate: candidateEvidence(match),
      },
    };
  }

  return {
    ...common,
    status: 'available',
    reasonCode: 'EXACT_CURRENT_PRESET_MATCH',
    supplierProductId: match.supplierProductId,
    supplierVariantId: match.supplierVariantId,
    supplierSku: match.supplierSku,
    candidateCount: 1,
    evidence: commonEvidence,
  };
}

function presetSupplierIdentityEvidence(result: StorefrontVariantCompatibilityResult) {
  return {
    supplierProductId: result.supplierProductId,
    supplierVariantId: result.supplierVariantId,
    supplierSku: result.supplierSku,
  };
}

/**
 * A current product-line preset proves that an option combination exists, but it does not prove
 * that the returned supplier identity belongs to the latest complete supplier-catalog generation.
 * Both independent sources must agree exactly before a Product-backed storefront variant is sold.
 */
export function crossCheckCurrentPresetMatchAgainstCatalog(
  result: StorefrontVariantCompatibilityResult,
  catalogIdentity: ProductLineSupplierIdentity | null,
  generationAvailable: boolean,
): StorefrontVariantCompatibilityResult {
  if (result.status !== 'available' || result.reasonCode !== 'EXACT_CURRENT_PRESET_MATCH') {
    return result;
  }

  const expectedIdentity = presetSupplierIdentityEvidence(result);
  const evidence = {
    ...result.evidence,
    presetSupplierIdentity: expectedIdentity,
    currentCatalogIdentity: catalogIdentity,
  };

  if (!generationAvailable) {
    return {
      ...result,
      status: 'unverified',
      reasonCode: 'CURRENT_CATALOG_GENERATION_UNAVAILABLE',
      evidence,
    };
  }

  if (!catalogIdentity) {
    return {
      ...result,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_CATALOG_SKU_NOT_FOUND',
      evidence,
    };
  }

  if (catalogIdentity.supplierSku !== result.supplierSku) {
    return {
      ...result,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_CATALOG_SKU_NOT_FOUND',
      evidence,
    };
  }

  if (catalogIdentity.supplierProductId !== result.supplierProductId) {
    return {
      ...result,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_CATALOG_PRODUCT_ID_MISMATCH',
      evidence,
    };
  }

  if (catalogIdentity.supplierVariantId !== result.supplierVariantId) {
    return {
      ...result,
      status: 'unavailable',
      reasonCode: 'CURRENT_PRESET_CATALOG_VARIANT_ID_MISMATCH',
      evidence,
    };
  }

  return {
    ...result,
    reasonCode: 'EXACT_CURRENT_PRESET_AND_CATALOG_MATCH',
    supplierProductId: catalogIdentity.supplierProductId,
    supplierVariantId: catalogIdentity.supplierVariantId,
    supplierSku: catalogIdentity.supplierSku,
    evidence,
  };
}

export function markCurrentPresetCatalogLookupUnavailable(
  result: StorefrontVariantCompatibilityResult,
): StorefrontVariantCompatibilityResult {
  if (result.status !== 'available' || result.reasonCode !== 'EXACT_CURRENT_PRESET_MATCH') {
    return result;
  }

  return {
    ...result,
    status: 'unverified',
    reasonCode: 'CURRENT_CATALOG_LOOKUP_UNAVAILABLE',
    evidence: {
      ...result.evidence,
      presetSupplierIdentity: presetSupplierIdentityEvidence(result),
      currentCatalogIdentity: null,
    },
  };
}

export function resultFromCurrentCatalogSku(
  variant: StorefrontVariant,
  supplierIdentity: ProductLineSupplierIdentity | null,
  generationAvailable: boolean,
): StorefrontVariantCompatibilityResult {
  const parsed = parseStorefrontVariantCompatibilityInput(variant);
  const common = baseResult(variant, parsed);

  if (!generationAvailable) {
    return {
      ...common,
      status: 'unverified',
      reasonCode: 'CURRENT_CATALOG_GENERATION_UNAVAILABLE',
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: 0,
      evidence: { storefrontOptions: summarizeStorefrontVariantOptions(variant) },
    };
  }

  if (!supplierIdentity) {
    return {
      ...common,
      status: 'unavailable',
      reasonCode: 'CURRENT_CATALOG_SKU_NOT_FOUND',
      supplierProductId: null,
      supplierVariantId: null,
      supplierSku: null,
      candidateCount: 0,
      evidence: { storefrontOptions: summarizeStorefrontVariantOptions(variant) },
    };
  }

  return {
    ...common,
    status: 'available',
    reasonCode: 'EXACT_CURRENT_CATALOG_SKU_MATCH',
    supplierProductId: supplierIdentity.supplierProductId,
    supplierVariantId: supplierIdentity.supplierVariantId,
    supplierSku: supplierIdentity.supplierSku,
    candidateCount: 1,
    evidence: { storefrontOptions: summarizeStorefrontVariantOptions(variant) },
  };
}
