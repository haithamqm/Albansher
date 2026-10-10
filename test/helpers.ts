import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { seedBase } from '../src/db/seed.js';
import type { EnvOverrides } from '../src/config.js';
import type { App } from '../src/types.js';

export interface ApiResponse { status: number; body: any; text: string; headers: Headers; cookie: string | null }
export interface ApiOpts { token?: string; body?: unknown; cookie?: string | null; headers?: Record<string, string>; raw?: boolean }
export type Api = (method: string, url: string, opts?: ApiOpts) => Promise<ApiResponse>;
export interface TestApp { app: App; api: Api; base: string; close: () => Promise<void> }

export async function startApp(extra: EnvOverrides = {}): Promise<TestApp> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khadamat-test-'));
  const app = createApp({ DB_PATH: ':memory:', UPLOAD_DIR: uploadDir, LOG_LEVEL: 'silent', JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DISABLE_SCHEDULER: 'true', DISABLE_RATE_LIMIT: 'true', ROUTING_URL: 'mock://straight-line',
    ADMIN_PHONE: '+967700000000', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'AdminPass123', __skipDotEnv: true, ...extra });
  await seedBase(app.db, app.config);
  await new Promise<void>((res) => { app.server.listen(0, '127.0.0.1', res); });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const api: Api = async (method, url, { token, body, cookie, headers = {}, raw } = {}) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: json, text, headers: res.headers, cookie: setCookie ? (setCookie.split(';')[0] as string) : null };
  };
  return { app, api, base, close: () => app.close() };
}

let counter = 0;
export const uniquePhone = (): string => `+9677${String(Date.now()).slice(-6)}${String(++counter).padStart(2, '0')}`;

export async function registerUser(api: Api, over: Record<string, unknown> = {}): Promise<ApiResponse & { creds: Record<string, any> }> {
  const role = String(over.role || 'CUSTOMER'); const body = { fullName: 'مستخدم تجريبي', phone: uniquePhone(), password: 'Passw0rd123', role, ...(role === 'PROVIDER' ? { email: `provider-${Date.now()}-${counter}@test.local` } : {}), ...over };
  const r = await api('POST', '/api/v1/auth/register', { body });
  return { ...r, creds: body };
}

export async function loginAdmin(api: Api): Promise<string> {
  const r = await api('POST', '/api/v1/auth/login', { body: { identifier: 'admin@test.local', password: 'AdminPass123' } });
  return r.body.accessToken as string;
}
