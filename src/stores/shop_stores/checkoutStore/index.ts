import { UserProfileDataInterface } from '@/lib/types/user-profile/main-user-profile';
import type { IUserShopProfile } from '@/lib/types/user-shop-interface';
import { normalizeCountryToIso3 } from '@/lib/utils/shop/checkout/normalizeCountryToIso3';
import { useUserMainProfileStore } from '@/stores/userMainProfileStore';
import { create } from 'zustand';
import { persist, type StorageValue } from 'zustand/middleware';
import { createCheckoutObfuscatedStorage } from './storage';

type CheckoutPickType = Pick<UserProfileDataInterface, 'first_name' | 'last_name' | 'email'>;
export interface ShopCheckoutStoreInterface extends CheckoutPickType {
  payment_method: {
    payment_method: 'credit_card' | '';
    name: string;
    card_number: string;
    expiry_date: string;
    card_holder_name: string;
    paypal_email: string;
    google_account_email: string;
  } | null;
  delivery_address: {
    shipping_address_line_1: string | null;
    shipping_address_line_2: string | null;
    shipping_city: string | null;
    shipping_state: string | null;
    shipping_country: string | null;
    zip_code: string | null;
  };
}

export interface ShopCheckoutState extends ShopCheckoutStoreInterface {
  setFirstName: (first_name: ShopCheckoutStoreInterface['first_name']) => void;
  setLastName: (last_name: ShopCheckoutStoreInterface['last_name']) => void;
  setEmail: (email: ShopCheckoutStoreInterface['email']) => void;
  setPaymentMethod: (payment_method: ShopCheckoutStoreInterface['payment_method']) => void;
  setDeliveryAddress: (delivery_address: ShopCheckoutStoreInterface['delivery_address']) => void;
  setShippingCountryISO3: (iso3: string | null) => void; // <-- NEW: single writer for country
  hydrateFromShopProfile: (profile: IUserShopProfile, fallbackEmail?: string | null) => void;
  clearCheckout: () => void;
  resetCheckoutToStoreDefaults: () => void;
  resetCheckoutToInitial: () => void;
}

type ShopCheckoutPersistedState = Pick<
  ShopCheckoutStoreInterface,
  'first_name' | 'last_name' | 'email' | 'delivery_address'
>;

const initialObj = {
  first_name: '',
  last_name: '',
  email: '',
  payment_method: null,
  delivery_address: {
    shipping_address_line_1: null,
    shipping_address_line_2: null,
    shipping_city: null,
    shipping_state: null,
    shipping_country: null,
    zip_code: null,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOr<Fallback extends '' | null>(
  value: unknown,
  fallback: Fallback,
): string | Fallback {
  return typeof value === 'string' ? value : fallback;
}

function sanitizeCheckoutStorageValue(
  value: StorageValue<ShopCheckoutPersistedState>,
): StorageValue<ShopCheckoutPersistedState> {
  const state: Record<string, unknown> = isRecord(value?.state) ? value.state : {};
  const address: Record<string, unknown> = isRecord(state.delivery_address)
    ? state.delivery_address
    : {};

  return {
    version: value?.version,
    state: {
      first_name: stringOr(state.first_name, ''),
      last_name: stringOr(state.last_name, ''),
      email: stringOr(state.email, ''),
      delivery_address: Object.fromEntries(
        Object.keys(initialObj.delivery_address).map((key) => [key, stringOr(address[key], null)]),
      ) as ShopCheckoutStoreInterface['delivery_address'],
    },
  };
}

function getProfileBackedCheckoutDefaults(): ShopCheckoutStoreInterface {
  const userProfile = useUserMainProfileStore.getState().userMainProfile;

  return {
    ...initialObj,
    first_name: userProfile?.first_name ?? '',
    last_name: userProfile?.last_name ?? '',
    email: userProfile?.email ?? '',
  };
}

export const useShopCheckoutStore = create<ShopCheckoutState>()(
  persist(
    (set) => ({
      ...getProfileBackedCheckoutDefaults(),
      setFirstName: (first_name) => set({ first_name }),
      setLastName: (last_name) => set({ last_name }),
      setEmail: (email) => set({ email }),
      setPaymentMethod: (payment_method) => set({ payment_method }),
      setDeliveryAddress: (delivery_address) => set({ delivery_address }),
      setShippingCountryISO3: (iso3) =>
        set((state) => ({
          delivery_address: { ...state.delivery_address, shipping_country: iso3 },
        })),
      hydrateFromShopProfile: (profile, fallbackEmail) => {
        const data = profile.data;
        set((state) => ({
          first_name: data.first_name ?? '',
          last_name: data.last_name ?? '',
          email: fallbackEmail ?? '',
          delivery_address: {
            shipping_address_line_1: data.shipping_address ?? '',
            shipping_address_line_2: state.delivery_address.shipping_address_line_2 ?? '',
            shipping_city: data.shipping_city ?? '',
            shipping_state: data.shipping_state ?? '',
            // Preserve the checkout/currency-selected country when it already exists.
            shipping_country:
              state.delivery_address.shipping_country ??
              normalizeCountryToIso3(data.shipping_country),
            zip_code: state.delivery_address.zip_code ?? '',
          },
        }));
      },
      clearCheckout: () => set(getProfileBackedCheckoutDefaults()),
      resetCheckoutToStoreDefaults: () => set(getProfileBackedCheckoutDefaults()),
      resetCheckoutToInitial: () => set({ ...initialObj }),
    }),
    {
      name: 'checkout-storage',
      storage: createCheckoutObfuscatedStorage<ShopCheckoutPersistedState>(
        'checkout-storage',
        sanitizeCheckoutStorageValue,
      ),
      partialize: (state): ShopCheckoutPersistedState => ({
        first_name: state.first_name,
        last_name: state.last_name,
        email: state.email,
        delivery_address: state.delivery_address,
      }),
      skipHydration: true,
    },
  ),
);
