// src/components/UI/Providers/UserMainProfileStoreInitializer.tsx
'use client';

import { useEffect } from 'react';
import { waitForUserMainProfileStoreHydration } from '@/stores/userMainProfileStore';

/**
 * This component is mounted high in the tree (e.g. in app/layout.tsx).
 * It simply triggers Zustand-persist rehydration on the client once.
 */
export default function UserMainProfileStoreInitializer() {
  useEffect(() => {
    void waitForUserMainProfileStoreHydration();
  }, []);

  return null;
}
