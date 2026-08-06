// Tiny cookie: no price maps.
export const CURRENCY_COOKIE = 'cc_currency_v1';

export type CookieStateV1 = {
  v: 1;
  iso3: string; // e.g. 'USA'
  fx?: {
    multiplier: number;
    currency: string;
    currency_symbol?: string;
    ts?: number; // client timestamp when fetched
  };
  updatedAt: number; // epoch ms
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseFx(value: unknown): CookieStateV1['fx'] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isFiniteNumber(value.multiplier) || typeof value.currency !== 'string') {
    return null;
  }

  return {
    multiplier: value.multiplier,
    currency: value.currency,
    currency_symbol: typeof value.currency_symbol === 'string' ? value.currency_symbol : undefined,
    ts: isFiniteNumber(value.ts) ? value.ts : undefined,
  };
}

export function parseCurrencyCookie(raw: string): CookieStateV1 | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    if (value.v !== 1 || typeof value.iso3 !== 'string' || !isFiniteNumber(value.updatedAt)) {
      return null;
    }

    const iso3 = value.iso3.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(iso3)) return null;

    const fx = parseFx(value.fx);
    if (fx === null) return null;

    return {
      v: 1,
      iso3,
      fx,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

export function serializeCurrencyCookie(value: CookieStateV1): string {
  return JSON.stringify(value);
}
