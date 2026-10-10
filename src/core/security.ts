import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/** تجزئة كلمة المرور (scrypt + salt عشوائي). لا تُخزَّن كلمة المرور نصًا صريحًا أبدًا. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: string | undefined;
/** يستهلك نفس الزمن تقريبًا عند عدم وجود المستخدم (لمنع تعداد الحسابات بالتوقيت). */
export async function fakeVerify(password: string): Promise<void> {
  dummyHash ||= await hashPassword('khadamat-timing-equalizer');
  await verifyPassword(password, dummyHash);
}

const b64u = (x: string) => Buffer.from(x).toString('base64url');

export interface JwtPayload { sub: string; role: string; tv: number; iss?: string; iat?: number; exp?: number }

export function signJwt(payload: Omit<JwtPayload, 'iss' | 'iat' | 'exp'>, secret: string, ttlSec: number, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ ...payload, iss: 'khadamat', iat: now, exp: now + ttlSec }))}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}

export function verifyJwt(token: string, secret: string, nowMs = Date.now()): JwtPayload | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null; // منع هجمات alg=none
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as JwtPayload;
    if (payload.iss !== 'khadamat' || typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
export const uuid = (): string => crypto.randomUUID();
