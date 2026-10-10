import { E } from './errors.js';
import type { Ctx } from './http.js';

export interface RateLimitResult { allowed: boolean; retryAfter?: number; remaining?: number }
/** Port: RateLimiter — التنفيذ الحالي في الذاكرة (نسخة واحدة). للتوسع الأفقي يُستبدل بتنفيذ Redis بنفس الواجهة. */
export interface RateLimiter { hit(key: string, max: number, windowMs: number): RateLimitResult; stop(): void }

export class MemoryRateLimiter implements RateLimiter {
  private now: () => number;
  private hits = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval>;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }
  hit(key: string, max: number, windowMs: number): RateLimitResult {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => x > t - windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return { allowed: false, retryAfter: Math.ceil(((arr[0] as number) + windowMs - t) / 1000) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { allowed: true, remaining: max - arr.length };
  }
  sweep(): void {
    const t = this.now();
    for (const [k, arr] of this.hits) if (!arr.length || (arr[arr.length - 1] as number) < t - 3_600_000) this.hits.delete(k);
  }
  stop(): void { clearInterval(this.timer); }
}

/** Middleware factory: limit('login', {max:5, windowMs:60000, key:(ctx)=>...}) */
export const limit = (name: string, opts: { max: number; windowMs: number; key?: (ctx: Ctx) => string }) => (ctx: Ctx): void => {
  if (ctx.app.config.disableRateLimit) return;
  const k = `${name}:${opts.key ? opts.key(ctx) : ctx.ip}`;
  const r = ctx.app.limiter.hit(k, opts.max, opts.windowMs);
  if (!r.allowed) throw E.tooMany(r.retryAfter);
};
