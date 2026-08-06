// src/stores/userMainProfileStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { UserProfileDataInterface } from '@/lib/types/user-profile/main-user-profile';
import { getUser } from '@/lib/funcs/userProfileFetchers/getUser';
import { getUpdatedKeys } from '@/lib/utils/getUpdatedObjKeys';
import { createBrowserObfuscatedJSONStorage } from '@/lib/crypto/browserObfuscatedStorage';

// Prevent multiple simultaneous fetches from the server (but allow future refreshes)
let inFlightUserProfilePromise: Promise<UserProfileDataInterface | null> | null = null;

const fetchUserProfileOnce = async (): Promise<UserProfileDataInterface | null> => {
  if (!inFlightUserProfilePromise) {
    inFlightUserProfilePromise = (async () => {
      try {
        return (await getUser()) ?? null;
      } catch (error) {
        console.error('Failed to fetch user profile from server:', error);
        return null;
      } finally {
        // Reset so a later call can fetch again
        inFlightUserProfilePromise = null;
      }
    })();
  }

  return inFlightUserProfilePromise;
};

const ENCRYPTION_KEY = process.env.NEXT_PUBLIC_USER_PROFILE_DATA_ENCRYPTION_KEY!;
const USER_MAIN_PROFILE_STORAGE_NAME = 'user-main-profile-storage';

interface UserMainProfileStore {
  userMainProfile: UserProfileDataInterface | null;
  setUserMainProfile: (userMainProfile: UserProfileDataInterface | null) => void;
  clearProfile: () => void;
  setProfileFromServer: () => Promise<void>;
}

const userMainProfileStorage = createBrowserObfuscatedJSONStorage<UserMainProfileStore>({
  getStorage: () => window.localStorage,
  publicKey: ENCRYPTION_KEY,
  purpose: USER_MAIN_PROFILE_STORAGE_NAME,
});

// This store persists the user profile data in obfuscated localStorage.
export const useUserMainProfileStore = create<UserMainProfileStore>()(
  persist(
    (set, get) => ({
      userMainProfile: null,

      setProfileFromServer: async () => {
        const serverData = await fetchUserProfileOnce();

        if (!serverData) return;

        const storeData = get().userMainProfile;

        // If there is no data in the store yet, just set it once
        if (!storeData) {
          set({ userMainProfile: serverData });
          return;
        }

        // Only update when there are actual changes between server and store
        const updatedKeys = getUpdatedKeys(serverData, storeData);

        if (Object.keys(updatedKeys).length > 0) {
          set({ userMainProfile: serverData });
        }
      },

      setUserMainProfile: (userMainProfile) => set({ userMainProfile }),

      clearProfile: () => set({ userMainProfile: null }),
    }),
    {
      name: USER_MAIN_PROFILE_STORAGE_NAME,
      storage: userMainProfileStorage,
      skipHydration: typeof window === 'undefined',
    },
  ),
);

let userMainProfileHydrationPromise: Promise<void> | null = null;

export function waitForUserMainProfileStoreHydration(): Promise<void> {
  if (typeof window === 'undefined' || useUserMainProfileStore.persist.hasHydrated()) {
    return Promise.resolve();
  }

  if (!userMainProfileHydrationPromise) {
    userMainProfileHydrationPromise = new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      const finish = () => {
        unsubscribe();
        resolve();
      };

      unsubscribe = useUserMainProfileStore.persist.onFinishHydration(finish);
      if (useUserMainProfileStore.persist.hasHydrated()) finish();
    }).finally(() => {
      userMainProfileHydrationPromise = null;
    });
  }

  return userMainProfileHydrationPromise;
}

export const clearUserMainProfileStore = async () => {
  const { clearProfile } = useUserMainProfileStore.getState();
  clearProfile();
  await userMainProfileStorage.removeItem(USER_MAIN_PROFILE_STORAGE_NAME);
};
