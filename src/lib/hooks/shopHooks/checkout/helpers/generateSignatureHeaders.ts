'use server';

import { hmacSha256Hex } from '@/lib/crypto/hmacSha256';

export async function generateSignatureHeaders() {
  const API_SECRET_KEY = process.env.SHOP_CHECKOUT_OTP_VERIFICATION_API_KEY;

  if (!API_SECRET_KEY) {
    throw new Error('SHOP_CHECKOUT_OTP_VERIFICATION_API_KEY is not defined');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacSha256Hex(timestamp, API_SECRET_KEY);

  return {
    'Content-Type': 'application/json',
    'X-API-Signature': `${signature}`,
    'X-API-Timestamp': `${timestamp}`,
  };
}
