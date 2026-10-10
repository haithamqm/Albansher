import { E } from './errors.js';
export class MemoryRateLimiter {
    now;
    hits = new Map();
    timer;
    constructor(now = () => Date.now()) {
        this.now = now;
        this.timer = setInterval(() => this.sweep(), 60_000);
        this.timer.unref?.();
    }
    hit(key, max, windowMs) {
        const t = this.now();
        const arr = (this.hits.get(key) || []).filter((x) => x > t - windowMs);
        if (arr.length >= max) {
            this.hits.set(key, arr);
            return { allowed: false, retryAfter: Math.ceil((arr[0] + windowMs - t) / 1000) };
        }
        arr.push(t);
        this.hits.set(key, arr);
        return { allowed: true, remaining: max - arr.length };
    }
    sweep() {
        const t = this.now();
        for (const [k, arr] of this.hits)
            if (!arr.length || arr[arr.length - 1] < t - 3_600_000)
                this.hits.delete(k);
    }
    stop() { clearInterval(this.timer); }
}
/** Middleware factory: limit('login', {max:5, windowMs:60000, key:(ctx)=>...}) */
export const limit = (name, opts) => (ctx) => {
    if (ctx.app.config.disableRateLimit)
        return;
    const k = `${name}:${opts.key ? opts.key(ctx) : ctx.ip}`;
    const r = ctx.app.limiter.hit(k, opts.max, opts.windowMs);
    if (!r.allowed)
        throw E.tooMany(r.retryAfter);
};
//# sourceMappingURL=rateLimit.js.map