import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { seed } from './catalog.ts';
import { openDb } from './db.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = process.env.DATA_DIR ?? resolve(root, 'data');
mkdirSync(dataDir, { recursive: true });

const db = openDb(resolve(dataDir, 'review.db'));
seed(db);

const secret = process.env.SECRET ?? randomBytes(32).toString('hex');
if (!process.env.SECRET) console.warn('SECRET not set: using a random one, sign-ins reset on restart.');

const app = buildApp({
  db,
  secret,
  mediaDir: resolve(root, 'media'),
  webDir: resolve(root, 'dist/web'),
  secureCookies: process.env.NODE_ENV === 'production',
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`Video review demo on http://localhost:${port}`));
