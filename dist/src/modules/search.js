import { s, parse } from '../core/validate.js';
import { limit } from '../core/rateLimit.js';
export function registerSearchRoutes(app, r) {
    r.post('/search/intent', limit('search', { max: 60, windowMs: 60_000 }), async (ctx) => {
        const { text } = parse(s.obj({ text: s.str({ min: 2, max: 300 }) }), ctx.body);
        return app.intentParser.parse(text, { catalog: app.catalog, locale: ctx.locale });
    });
}
//# sourceMappingURL=search.js.map