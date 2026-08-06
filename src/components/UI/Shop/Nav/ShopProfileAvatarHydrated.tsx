'use client';

import { useEffect } from 'react';
import type { ImageProps } from 'next/image';
import MainProfileAvatar from '../../profile/UserAvatar';
import { useAuthStore } from '@/stores/authStore';
import {
  useUserMainProfileStore,
  waitForUserMainProfileStoreHydration,
} from '@/stores/userMainProfileStore';

type ShopProfileAvatarHydratedProps = Omit<ImageProps, 'src'> & {
  width: number;
  height: number;
};

export default function ShopProfileAvatarHydrated({
  width,
  height,
  className,
  ...props
}: ShopProfileAvatarHydratedProps) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const autoUpDateSession = useAuthStore((state) => state.autoUpDateSession);
  const setProfileFromServer = useUserMainProfileStore((state) => state.setProfileFromServer);

  useEffect(() => {
    let cancelled = false;

    const syncProfile = async () => {
      await waitForUserMainProfileStoreHydration();

      const session = isAuthenticated
        ? { isAuthenticated: true }
        : await autoUpDateSession().catch(() => null);

      if (!cancelled && session?.isAuthenticated) {
        await setProfileFromServer();
      }
    };

    void syncProfile();

    return () => {
      cancelled = true;
    };
  }, [autoUpDateSession, isAuthenticated, setProfileFromServer]);

  return (
    <MainProfileAvatar
      {...props}
      width={width}
      height={height}
      alt={typeof props.alt === 'string' ? props.alt : 'User avatar'}
      className={`!size-full rounded-full object-cover object-center ${className ?? ''}`}
      sizes={`${width}px`}
      quality={75}
      loading='lazy'
    />
  );
}
