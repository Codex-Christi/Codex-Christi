'use client';

import loadingToast from '@/lib/loading-toast';
import errorToast from '@/lib/error-toast';
import { clearUserMainProfileStore } from '@/stores/userMainProfileStore';
import { toast } from 'sonner';

type LogoutResult = {
  status: boolean;
  error?: string;
};

export const logoutUser = async (): Promise<boolean | LogoutResult> => {
  const loadingToastID = loadingToast({
    message: 'Please wait a moment...',
  });

  try {
    await clearUserMainProfileStore();
    toast.dismiss(loadingToastID);
    window.location.assign('/next-api/logout');

    return true;
  } catch (err: unknown) {
    toast.dismiss(loadingToastID);

    const apiErrorMessage =
      err instanceof Error ? err.message : 'Something went wrong. Please try again.';

    errorToast({
      message: apiErrorMessage,
    });

    return {
      status: false,
      error: apiErrorMessage,
    };
  }
};
