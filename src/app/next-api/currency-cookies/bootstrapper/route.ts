import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  CURRENCY_COOKIE,
  parseCurrencyCookie,
  serializeCurrencyCookie,
  type CookieStateV1,
} from '@/lib/utils/shop/globalFXProductPrice/cookies/currencyCookie';
import { normalizeCountryToIso3 } from '@/lib/utils/shop/checkout/normalizeCountryToIso3';

type BootstrapBody = {
  iso3?: string;
  updatedAt?: number;
  fx?: CookieStateV1['fx'];
};

export async function POST(request: Request) {
  const jar = await cookies();
  const existing = jar.get(CURRENCY_COOKIE)?.value;
  if (existing && parseCurrencyCookie(existing)) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  let body: BootstrapBody | null = null;
  try {
    body = (await request.json()) as BootstrapBody;
  } catch {}

  const iso3 = normalizeCountryToIso3(body?.iso3 ?? null) ?? 'USA';

  const payload: CookieStateV1 = {
    v: 1,
    iso3,
    fx: body?.fx,
    updatedAt: typeof body?.updatedAt === 'number' ? body.updatedAt : Date.now(),
  };

  const response = NextResponse.json({ ok: true });
  response.cookies.set(CURRENCY_COOKIE, serializeCurrencyCookie(payload), {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
