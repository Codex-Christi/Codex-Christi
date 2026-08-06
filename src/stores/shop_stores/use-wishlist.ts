import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PersistedStorageWithRehydration } from '@/lib/types/general_store_interfaces';
import { fetchUserWishlist, addToWishlist, removeFromWishlist } from '@/lib/funcs/user-wishlist';
import { getUpdatedKeys } from '@/lib/utils/getUpdatedObjKeys';
import { createBrowserObfuscatedJSONStorage } from '@/lib/crypto/browserObfuscatedStorage';

interface IWishlist {
  status: number;
  success: boolean;
  message: string;
  data: Record<string, string | number | boolean>[];
}

const ENCRYPTION_KEY = process.env.NEXT_PUBLIC_USER_PROFILE_DATA_ENCRYPTION_KEY!;
const WISHLIST_STORAGE_NAME = 'user-wishlist';

// ✅ Define the shape of your Zustand store
interface WishlistStore extends PersistedStorageWithRehydration {
  wishlist: IWishlist | null;
  isLoading: boolean;
  getWishlist: () => Promise<void>;
  addWishlistItem: (id: string) => Promise<void>;
  removeWishlistItem: (id: string) => Promise<void>;
  setWishlist: (wishlist: IWishlist | null) => void;
  clearWishlist: () => void;
}

const wishlistStorage = createBrowserObfuscatedJSONStorage<WishlistStore>({
  getStorage: () => window.sessionStorage,
  publicKey: ENCRYPTION_KEY,
  purpose: WISHLIST_STORAGE_NAME,
  legacyEncryptedStateFields: ['wishlist'],
});

export const useWishlist = create<WishlistStore>()(
  persist(
    (set, get) => ({
      wishlist: null,
      isLoading: true,
      _hydrated: false,

      getWishlist: async () => {
        const storeData = get().wishlist;

        try {
          const serverData = await fetchUserWishlist();

          if (!serverData) {
            set({ isLoading: false });
            return;
          }

          if (!storeData) {
            set({ wishlist: serverData, isLoading: false });
            return;
          }

          const updatedKeys = getUpdatedKeys(serverData, storeData);
          const isDataDifferent = Object.values(updatedKeys).length > 0;

          set({ wishlist: isDataDifferent ? serverData : storeData, isLoading: false });
        } catch {
          set({ isLoading: false });
        }
      },

      addWishlistItem: async (productId: string) => {
        const data = await addToWishlist([productId]);
        if (data?.success) await get().getWishlist();
      },

      removeWishlistItem: async (productId: string) => {
        const data = await removeFromWishlist([productId]);
        if (data?.success) await get().getWishlist();
      },

      setWishlist: (wishlist: IWishlist | null) => set({ wishlist }),

      clearWishlist: () => set({ wishlist: null, isLoading: false }),

      hydrate: () => set({ _hydrated: true }),
    }),
    {
      name: WISHLIST_STORAGE_NAME,
      storage: wishlistStorage,
      skipHydration: typeof window === 'undefined',
      onRehydrateStorage: () => (state) => {
        state?.hydrate();
      },
    },
  ),
);

export const clearWishlistStorage = async () => {
  useWishlist.getState().clearWishlist();
  await wishlistStorage.removeItem(WISHLIST_STORAGE_NAME);
};
