import {
  ProductVariantsInterface,
  ColorAttribute,
  SizeAttribute,
  LabelAttribute,
} from '@/lib/merchizeStorefront/productTypes';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { shallow } from 'zustand/shallow';

// 🧠 Types
export type Variant = ProductVariantsInterface['data'][0];
export type Variants = ProductVariantsInterface['data'];

// keep the raw option type around for label setters etc.
export type VariantSelectionState = Record<string, string | null>;

const SELECTABLE_VARIANT_ATTRIBUTES = ['size', 'color', 'label'] as const;
const SELECTABLE_VARIANT_ATTRIBUTE_SET = new Set<string>(SELECTABLE_VARIANT_ATTRIBUTES);

interface CurrentVariantStore {
  matchingVariant: Variant | null;
  setMatchingVariant: (variant: Variant | null) => void;

  // currentVariantOptions is keyed by normalized attribute name (e.g. 'size', 'color', 'label')
  currentVariantOptions: VariantSelectionState;
  setColor: (color: ColorAttribute | null, variant?: Variant) => void;
  setSize: (size: SizeAttribute | null, variant?: Variant) => void;
  setLabel: (label: LabelAttribute | null, variant?: Variant) => void;
  resetVariantOptions: () => void;

  findMatchingVariant: (variants: Variants) => Variant | undefined;
}

// Helpers
const normalizeAttrName = (name?: string | null): string => (name ?? '').trim().toLowerCase();

type WithOptionalValue = { value?: string | number | null };

const extractValue = (option: WithOptionalValue | null | undefined): string | null => {
  if (!option) return null;
  const raw = option.value;
  if (raw === undefined || raw === null) return null;
  return String(raw);
};

const buildVariantValueMap = (variant: Variant): Record<string, string | undefined> => {
  const map: Record<string, string | undefined> = {};

  variant?.options?.forEach((opt) => {
    const key = normalizeAttrName(opt?.attribute?.name);
    const value = opt?.value;
    if (key) {
      map[key] = value;
    }
  });

  return map;
};

export function getRequiredVariantAttributes(variants: Variants) {
  const attributes = new Set<string>();

  variants.forEach((variant) => {
    variant?.options?.forEach((opt) => {
      const name = normalizeAttrName(opt?.attribute?.name);
      if (SELECTABLE_VARIANT_ATTRIBUTE_SET.has(name)) attributes.add(name);
    });
  });

  return SELECTABLE_VARIANT_ATTRIBUTES.filter((attribute) => attributes.has(attribute));
}

export function hasRequiredVariantSelections(
  requiredAttributes: readonly string[],
  selections: VariantSelectionState,
) {
  return requiredAttributes.every((attr) => {
    const value = selections[attr];
    return typeof value === 'string' && value.length > 0;
  });
}

export function findMatchingVariantForSelections(
  variants: Variants,
  selections: VariantSelectionState,
): Variant | undefined {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;

  const requiredAttributes = getRequiredVariantAttributes(variants);
  if (!requiredAttributes.length) {
    return variants.length === 1 ? variants[0] : undefined;
  }
  if (!hasRequiredVariantSelections(requiredAttributes, selections)) {
    return undefined;
  }

  return variants.find((variant) => {
    const map = buildVariantValueMap(variant);

    return requiredAttributes.every((attrName) => {
      const selected = selections[attrName];
      if (!selected) return false;

      const variantVal = map[attrName];
      return (variantVal ?? '').toLowerCase() === selected.toLowerCase();
    });
  });
}

export const useCurrentVariant = create<CurrentVariantStore>()(
  subscribeWithSelector((set, get) => ({
    matchingVariant: null,

    // initialise known keys, but store is flexible enough to accept others as needed
    currentVariantOptions: {
      size: null,
      color: null,
      label: null,
    },

    setMatchingVariant: (variant: Variant | null) =>
      set((s) => (s.matchingVariant === variant ? s : { ...s, matchingVariant: variant })),

    // Note: `variant` parameter is optional and currently unused, but kept for backwards compatibility
    setColor: (color: ColorAttribute | null) =>
      set((state) => ({
        currentVariantOptions: {
          ...state.currentVariantOptions,
          color: extractValue(color as unknown as WithOptionalValue),
        },
      })),

    setSize: (size: SizeAttribute | null) =>
      set((state) => ({
        currentVariantOptions: {
          ...state.currentVariantOptions,
          size: extractValue(size as unknown as WithOptionalValue),
        },
      })),

    setLabel: (label: LabelAttribute | null) =>
      set((state) => ({
        currentVariantOptions: {
          ...state.currentVariantOptions,
          label: extractValue(label as unknown as WithOptionalValue),
        },
      })),

    resetVariantOptions: () =>
      set({
        currentVariantOptions: {
          size: null,
          color: null,
          label: null,
        },
        matchingVariant: null,
      }),

    findMatchingVariant: (variants: Variants) => {
      if (!Array.isArray(variants) || variants.length === 0) {
        set((s) => ({ ...s, matchingVariant: null }));
        return undefined;
      }

      const selections = get().currentVariantOptions;
      const matched = findMatchingVariantForSelections(variants, selections);

      set((s) => ({ ...s, matchingVariant: matched ?? null }));
      return matched;
    },
  })),
);

// 🔄 Auto-match when options change (with shallow equality to prevent noisy triggers)
export function setupVariantAutoMatching(variants: Variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    useCurrentVariant.getState().setMatchingVariant(null);
    return () => {};
  }

  const requiredAttributes = getRequiredVariantAttributes(variants);

  const syncMatchingVariant = (currentOptions: VariantSelectionState) => {
    const state = useCurrentVariant.getState();

    if (!requiredAttributes.length) {
      state.setMatchingVariant(variants.length === 1 ? variants[0] : null);
      return;
    }

    // If no active selection or not all required attributes are selected yet,
    // we do not attempt a match and clear any previous match.
    if (!hasRequiredVariantSelections(requiredAttributes, currentOptions)) {
      if (state.matchingVariant !== null) {
        state.setMatchingVariant(null);
      }
      return;
    }

    state.findMatchingVariant(variants);
  };

  const unsubscribe = useCurrentVariant.subscribe(
    (s) => s.currentVariantOptions,
    syncMatchingVariant,
    { equalityFn: shallow },
  );

  // A dynamic consumer can mount after the customer already selected an option.
  syncMatchingVariant(useCurrentVariant.getState().currentVariantOptions);

  return unsubscribe;
}
