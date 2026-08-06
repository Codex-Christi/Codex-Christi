import { cookies, headers } from 'next/headers';
import { fetchUserShopProfile } from '@/lib/funcs/user-shop';
import {
  CURRENCY_COOKIE,
  parseCurrencyCookie,
} from '../globalFXProductPrice/cookies/currencyCookie';
import { normalizeCountryToIso3 } from '../checkout/normalizeCountryToIso3';

type GetDefaultISO3Options = {
  includeProfileLookup?: boolean;
};

function resolveHeaderCountry(raw: string | null): string | null {
  const value = raw?.trim().toUpperCase();
  if (!value || value === 'XX' || value === 'T1') return null;
  return normalizeCountryToIso3(value);
}

async function getCurrencyCookieISO3() {
  const jar = cookies();
  const raw = (await jar).get(CURRENCY_COOKIE)?.value;
  if (raw) {
    const parsed = parseCurrencyCookie(raw);
    if (parsed?.iso3) return parsed.iso3;
  }

  return null;
}

async function getHeaderISO3() {
  const h = headers();

  return (
    resolveHeaderCountry((await h).get('x-country-code')) ??
    resolveHeaderCountry((await h).get('cf-ipcountry'))
  );
}

async function getProfileISO3() {
  const profile = await fetchUserShopProfile();
  return normalizeCountryToIso3(profile?.data?.shipping_country ?? null);
}

export async function getDefaultISO3(options: GetDefaultISO3Options = {}): Promise<string> {
  const cookieCountry = await getCurrencyCookieISO3();
  if (cookieCountry) return cookieCountry;

  const headerCountry = await getHeaderISO3();
  if (headerCountry) return headerCountry;

  if (options.includeProfileLookup ?? true) {
    const profileCountry = await getProfileISO3();
    if (profileCountry) return profileCountry;
  }

  return 'USA';
}

export async function getDefaultStorefrontISO3(): Promise<string> {
  return getDefaultISO3({ includeProfileLookup: false });
}
