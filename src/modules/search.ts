import { s, parse } from '../core/validate.js';
import { limit } from '../core/rateLimit.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';

export function registerSearchRoutes(app: App, r: Router): void {
  r.post('/search/intent', limit('search', { max: 60, windowMs: 60_000 }), async (ctx: Ctx) => {
    const { text } = parse<{ text: string }>(s.obj({ text: s.str({ min: 2, max: 300 }) }), ctx.body);
    return app.intentParser.parse(text, { catalog: app.catalog, locale: ctx.locale });
  });
}
