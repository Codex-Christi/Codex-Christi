import { createBrowserObfuscatedJSONStorage } from '@/lib/crypto/browserObfuscatedStorage';
import type { StorageValue } from 'zustand/middleware';

const STORAGE_OBFUSCATION_KEY = process.env.NEXT_PUBLIC_CART_KEY || 'fallback-secret';

export function createCheckoutObfuscatedStorage<S>(
  purpose: string,
  sanitize?: (value: StorageValue<S>) => StorageValue<S> | null,
) {
  return createBrowserObfuscatedJSONStorage<S>({
    getStorage: () => window.localStorage,
    publicKey: STORAGE_OBFUSCATION_KEY,
    purpose,
    sanitize,
  });
}
