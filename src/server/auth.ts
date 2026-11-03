import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, Buffer.from(salt, 'hex'), 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

// Tokens are "<payload>.<expiry>.<signature>"; payload must not contain dots.
export function makeToken(secret: string, payload: string, expiresAt: number): string {
  const body = `${payload}.${expiresAt}`;
  return `${body}.${sign(secret, body)}`;
}

export function readToken(secret: string, token: string | undefined, now: number): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 3) return null;
  const sig = parts.pop() as string;
  const body = parts.join('.');
  const expected = sign(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const exp = Number(parts.pop());
  if (!Number.isFinite(exp) || exp < now) return null;
  return parts.join('.');
}
