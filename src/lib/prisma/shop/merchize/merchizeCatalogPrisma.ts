// src/lib/prisma/shop/merchize/merchizeCatalogPrisma.ts
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/merchizeCatalog/client';
import fs from 'fs';
import path from 'path';

// Keep this default in sync with prisma.config.ts and the Docker /app/data volume.
const DEFAULT_DB_URL = `file:${path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  'data',
  'db',
  'shop',
  'merchizeCatalog.db',
)}`;

function resolveDbUrl(): ':memory:' | (string & {}) {
  const url = process.env.MERCHIZE_OFFLINE_CATALOG_DATABASE_URL ?? DEFAULT_DB_URL;
  if (url === ':memory:' || url === 'file::memory:') return url as ':memory:' | (string & {});
  if (!url.startsWith('file:')) {
    throw new Error('MERCHIZE_OFFLINE_CATALOG_DATABASE_URL must be a SQLite file: URL.');
  }

  const filePath = url.slice('file:'.length);
  return (
    path.isAbsolute(filePath)
      ? url
      : `file:${path.resolve(/*turbopackIgnore: true*/ process.cwd(), filePath)}`
  ) as string & {};
}

function ensureCatalogDbDirectory(dbUrl: ':memory:' | (string & {})) {
  // Ensure the parent folder exists so SQLite can create or open the catalog file.
  if (!dbUrl.startsWith('file:') || dbUrl === 'file::memory:') return;
  const dir = path.dirname(dbUrl.slice('file:'.length));

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('Failed to ensure Merchize catalog DB directory exists:', err);
  }
}

declare global {
  // Re-use the client between HMR reloads in dev
  var merchizeCatalogPrisma: PrismaClient | undefined;
}

let merchizeCatalogPrismaSingleton: PrismaClient | undefined;

function supportsCurrentCatalogSchema(client: PrismaClient) {
  // A generated Prisma client can survive a Next.js hot reload through globalThis. If the schema
  // changed while `next dev` was running, discard that pre-generation client so newly added model
  // delegates are available without requiring a manual server restart.
  return (
    typeof (client as unknown as Record<string, unknown>).storefrontVariantCompatibility ===
    'object'
  );
}

export function getMerchizeCatalogPrisma() {
  const cachedClient = globalThis.merchizeCatalogPrisma ?? merchizeCatalogPrismaSingleton;
  if (cachedClient && supportsCurrentCatalogSchema(cachedClient)) return cachedClient;

  if (cachedClient) {
    globalThis.merchizeCatalogPrisma = undefined;
    merchizeCatalogPrismaSingleton = undefined;
    void cachedClient.$disconnect().catch((error) => {
      console.warn('Failed to disconnect an outdated Merchize catalog Prisma client:', error);
    });
  }

  try {
    const dbUrl = resolveDbUrl();
    ensureCatalogDbDirectory(dbUrl);

    // New API: pass an options object with `url`, not a Database instance.
    const adapter = new PrismaBetterSqlite3({ url: dbUrl });
    const prisma = new PrismaClient({ adapter });

    merchizeCatalogPrismaSingleton = prisma;

    if (process.env.NODE_ENV !== 'production') {
      globalThis.merchizeCatalogPrisma = prisma;
    }

    return prisma;
  } catch (err) {
    console.error('Error initializing PrismaClient (Merchize catalog):', err);
    throw err;
  }
}

export const merchizeCatalogPrisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getMerchizeCatalogPrisma();
    const value = Reflect.get(client, property, receiver);

    return typeof value === 'function' ? value.bind(client) : value;
  },
});
