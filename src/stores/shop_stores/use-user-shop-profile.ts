import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PersistedStorageWithRehydration } from '@/lib/types/general_store_interfaces';
import { fetchUserShopProfile } from '@/lib/funcs/user-shop';
import { getUpdatedKeys } from '@/lib/utils/getUpdatedObjKeys';
import { IUserShopProfile } from '@/lib/types/user-shop-interface';
import { createBrowserObfuscatedJSONStorage } from '@/lib/crypto/browserObfuscatedStorage';

const ENCRYPTION_KEY = process.env.NEXT_PUBLIC_USER_PROFILE_DATA_ENCRYPTION_KEY!;
const USER_SHOP_PROFILE_STORAGE_NAME = 'user-shop-profile-storage';

interface UserShopProfile extends PersistedStorageWithRehydration {
  userShopProfile: IUserShopProfile | null;
  isLoading: boolean;
  setUserShopProfile: (userShopProfile: IUserShopProfile | null) => void;
  clearProfile: () => void;
  setProfileFromServer: () => Promise<void>;
}

const userShopProfileStorage = createBrowserObfuscatedJSONStorage<UserShopProfile>({
  getStorage: () => window.sessionStorage,
  publicKey: ENCRYPTION_KEY,
  purpose: USER_SHOP_PROFILE_STORAGE_NAME,
  legacyEncryptedStateFields: ['userShopProfile'],
});

export const useUserShopProfile = create<UserShopProfile>()(
  persist(
    (set, get) => {
      return {
        userShopProfile: null,
        isLoading: true,
        _hydrated: false,

        setProfileFromServer: async () => {
          const storeData = get().userShopProfile;

          try {
            const serverData = await fetchUserShopProfile();

            // If no server data, return early
            if (!serverData) {
              set({ isLoading: false });
              return;
            }

            // If no data is present in the store, fetch from server
            // This is to ensure that the store is initialized with the latest data
            if (!storeData) {
              set({ userShopProfile: serverData, isLoading: false });
              return;
            }

            // Check if the data has changed before updating the store
            const updatedKeys = getUpdatedKeys(serverData, storeData);
            const isDataDifferent = Object.values(updatedKeys).length > 0;

            if (isDataDifferent) {
              set({ userShopProfile: serverData, isLoading: false });
            } else {
              set({ isLoading: false });
            }
          } catch {
            set({ isLoading: false });
          }
        },

        setUserShopProfile: (userShopProfile: IUserShopProfile | null) => set({ userShopProfile }),

        clearProfile: () => set({ userShopProfile: null, isLoading: false }),

        hydrate: () => set({ _hydrated: true }),
      };
    },
    {
      name: USER_SHOP_PROFILE_STORAGE_NAME,
      storage: userShopProfileStorage,
      skipHydration: typeof window === 'undefined',
      onRehydrateStorage: () => async (state) => {
        state?.hydrate();
        await state?.setProfileFromServer();
      },
    },
  ),
);

export const clearUserShopProfile = async () => {
  useUserShopProfile.getState().clearProfile();
  await userShopProfileStorage.removeItem(USER_SHOP_PROFILE_STORAGE_NAME);
};
