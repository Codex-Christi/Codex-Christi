import { cookies } from 'next/headers';
import {
  CURRENCY_COOKIE,
  parseCurrencyCookie,
  type CookieStateV1,
} from '../cookies/currencyCookie';

const FALLBACK: CookieStateV1 = { v: 1, iso3: 'USA', updatedAt: 0 };

export async function readCurrencyCookieServer(): Promise<CookieStateV1> {
  const jar = await cookies();
  const raw = jar.get(CURRENCY_COOKIE)?.value;
  if (!raw) return { ...FALLBACK };

  const parsed = parseCurrencyCookie(raw);
  if (parsed) return parsed;
  return { ...FALLBACK };
}
