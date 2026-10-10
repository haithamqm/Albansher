/**
 * أنواع مشتركة عبر الوحدات. حرصًا على مصدر حقيقة واحد بلا ازدواج، الأنواع المُركَّبة
 * (App وDb وCtx) تُعاد تصديرها من حيث تُعرَّف فعليًا (app.ts / db/database.ts / core/http.ts)
 * بدل تكرارها هنا بتعريف مستقل قد ينحرف عنها بمرور الوقت.
 */
export type { App, Clock, SseTicket } from './app.js';
export type { Db, RunResult, Row } from './db/database.js';
export type { Ctx, Handler } from './core/http.js';

export type Role = 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
export type AdminLevel = 'SUPPORT' | 'ADMIN' | 'SUPER_ADMIN';
export type Locale = 'ar' | 'en';

export interface AuthUser {
  id: string; fullName: string; phone: string; email: string | null; role: Role; locale: Locale;
  adminLevel: AdminLevel | null; providerId: string | null; avatarFileId: string | null;
}

import type { Ctx as CtxType } from './core/http.js';
/** ctx بعد مرور middleware المصادقة (المستخدم موجود حتمًا) */
export type AuthedCtx = CtxType & { user: AuthUser };
