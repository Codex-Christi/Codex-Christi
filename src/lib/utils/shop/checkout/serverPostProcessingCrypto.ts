import 'server-only';
import { decryptServerTextWithLegacyCryptoJs, encryptServerText } from '@/lib/crypto/serverAesGcm';

export type PostProcessingCipherPurpose = 'receipt' | 'payment-save' | 'fulfillment';

function getCheckoutServerPostProcSecret() {
  const secret = process.env.SHOP_CHECKOUT_SERVER_ACTIONS_POST_PROCESSING_CRYPTO_SECRET;
  if (!secret) {
    throw new Error('SHOP_CHECKOUT_SERVER_ACTIONS_POST_PROCESSING_CRYPTO_SECRET is not configured');
  }
  return secret;
}

function getCipherOptions(purpose: PostProcessingCipherPurpose) {
  return {
    secret: getCheckoutServerPostProcSecret(),
    purpose: `checkout-post-processing/${purpose}`,
  };
}

export function encryptForPostProcessingServerAction(
  text: string,
  purpose: PostProcessingCipherPurpose,
): string {
  return encryptServerText(text, getCipherOptions(purpose));
}

export function decryptForPostProcessingServerAction(
  data: string,
  purpose: PostProcessingCipherPurpose,
) {
  return decryptServerTextWithLegacyCryptoJs(data, getCipherOptions(purpose));
}

// Backward-compatible alias for older imports.
export const deryptForPostProcessingServerAction = decryptForPostProcessingServerAction;
