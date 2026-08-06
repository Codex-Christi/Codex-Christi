'use client';

import Cookies from 'js-cookie';
import {
  CURRENCY_COOKIE,
  parseCurrencyCookie,
  serializeCurrencyCookie,
  type CookieStateV1,
} from '../cookies/currencyCookie';

export function readCurrencyCookieClient(): CookieStateV1 | null {
  try {
    const raw = Cookies.get(CURRENCY_COOKIE);
    if (!raw) return null;
    return parseCurrencyCookie(raw);
  } catch {
    return null;
  }
}

export function writeCurrencyCookieClient(state: CookieStateV1): void {
  try {
    Cookies.set(CURRENCY_COOKIE, serializeCurrencyCookie(state), {
      sameSite: 'lax',
      expires: 30,
      path: '/',
      secure: process.env.NODE_ENV === 'production',
    });
  } catch (e) {
    console.error('[currency] client cookie write failed', e);
  }
}
