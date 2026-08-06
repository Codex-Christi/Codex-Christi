import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProductVariantOptions } from '@/lib/merchizeStorefront/productTypes';
import { createBrowserObfuscatedJSONStorage } from '@/lib/crypto/browserObfuscatedStorage';

// Types
export type VariantOption = {
  is_preselected: boolean;
  position: number;
  hide_storefront: boolean;
  slug: string;
  value: string;
  name: string;
  attribute: {
    _id: string;
    name: 'Product' | 'Size' | 'Color'; // or string, if dynamic
    value_type: 'slide' | 'size' | 'color'; // or string, if dynamic
  };
};

type ItemDetail = {
  _id: string;
  sides?: string[]; // e.g., "front-name:Front-51LtyMNlV71"
  image_uris: string[];
  retail_price: number;
  is_default: boolean;
  sku?: string;
  sku_seller?: string;
  /** Server-verified fulfillment SKU; never accepted from browser input without revalidation. */
  supplierSku?: string;
  title: string;
  weight?: number;
  options: VariantOption[] | ProductVariantOptions;
  product?: string;
  base_cost?: number;
  image?: string;
};

export type VariantDetail = ItemDetail;

export type CartVariant = {
  variantId: string;
  quantity: number;
  title: string;
  slug: string;
  itemDetail: ItemDetail;
};

interface CartState {
  variants: CartVariant[];
  offlineOnly: boolean;
  setOfflineOnly: (value: boolean) => void;
  addToCart: (variant: CartVariant) => void;
  reduceFromCart: (variantId: string, quantity: number) => void;
  removeFromCart: (variantId: string) => void;
  clearCart: () => void;
  syncRemoteCart: () => Promise<void>;
  pushRemoteCart: () => Promise<void>;
  pullRemoteCart: () => Promise<void>;
  setVariants: (variants: CartVariant[]) => void;
  applyMetadataTransform?: (variant: CartVariant) => CartVariant;
}

// This key is public in the browser, so persisted cart encryption is obfuscation rather than a
// security boundary. Web Crypto replaces the discontinued CryptoJS implementation.
const STORAGE_OBFUSCATION_KEY = process.env.NEXT_PUBLIC_CART_KEY || 'fallback-secret';

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      variants: [],
      offlineOnly: true,

      // Manually control offline mode
      setOfflineOnly: (value) => {
        set({ offlineOnly: value });
        if (!value && typeof window !== 'undefined') {
          window.dispatchEvent(new Event('network-sync'));
        }
      },

      addToCart: (variant) => {
        const existing = get().variants.find((v) => v.variantId === variant.variantId);
        const filtered = get().applyMetadataTransform?.(variant) || variant;

        set({
          variants: existing
            ? get().variants.map((v) =>
                v.variantId === variant.variantId
                  ? { ...v, quantity: v.quantity + filtered.quantity }
                  : v,
              )
            : [filtered, ...get().variants],
        });
      },

      reduceFromCart: (variantId: string, quantity: number = 1) => {
        const existing = get().variants.find((v) => v.variantId === variantId);
        if (!existing) return;

        const newQuantity = existing.quantity - quantity;

        if (newQuantity > 0) {
          set({
            variants: get().variants.map((v) =>
              v.variantId === variantId ? { ...v, quantity: newQuantity } : v,
            ),
          });
        } else {
          // Quantity is zero or less, remove the item
          get().removeFromCart(variantId);
        }
      },

      removeFromCart: (variantId) =>
        set({
          variants: get().variants.filter((v) => v.variantId !== variantId),
        }),

      clearCart: () => set({ variants: [] }),

      setVariants: (variants) => set({ variants }),

      // Remote sync methods
      pushRemoteCart: async () => {
        if (get().offlineOnly) return;

        const body = JSON.stringify({ variants: get().variants });
        await fetch('/api/cart/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      },

      pullRemoteCart: async () => {
        if (get().offlineOnly) return;

        const res = await fetch('/api/cart');
        const remote = await res.json();
        set({ variants: remote.variants || [] });
      },

      syncRemoteCart: async () => {
        const local = get().variants;

        const res = await fetch('/api/cart');
        const remoteData = await res.json();

        const remote = remoteData.variants || [];

        // Basic merge strategy: prioritize higher quantity and preserve unique
        const merged: CartVariant[] = [];

        const map = new Map<string, CartVariant>();

        [...local, ...remote].forEach((v) => {
          const key = v.variantId;
          const existing = map.get(key);

          const transformed = get().applyMetadataTransform?.(v) || v;

          if (!existing) {
            map.set(key, transformed);
          } else {
            map.set(key, {
              ...transformed,
              quantity: Math.max(existing.quantity, transformed.quantity),
            });
          }
        });

        merged.push(...map.values());
        set({ variants: merged });
        await get().pushRemoteCart(); // update remote with merged result
      },
    }),
    {
      name: 'cart-storage',
      storage: createBrowserObfuscatedJSONStorage<{
        variants: CartVariant[];
        offlineOnly: boolean;
      }>({
        getStorage: () => window.localStorage,
        publicKey: STORAGE_OBFUSCATION_KEY,
        purpose: 'cart-storage',
      }),
      partialize: (state) => ({
        variants: state.variants,
        offlineOnly: state.offlineOnly,
      }),
      skipHydration: typeof window === 'undefined',
    },
  ),
);

// Auto-sync when coming online or toggling offlineOnly
if (typeof window !== 'undefined') {
  const store = useCartStore;

  const trySync = async () => {
    if (!store.getState().offlineOnly && navigator.onLine) {
      await store.getState().syncRemoteCart();
    }
  };

  window.addEventListener('online', trySync);
  window.addEventListener('network-sync', trySync);
}
