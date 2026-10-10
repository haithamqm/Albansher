export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const parseJson = (v, fallback = null) => {
    if (v === null || v === undefined)
        return fallback;
    if (typeof v !== 'string')
        return v;
    try {
        return JSON.parse(v);
    }
    catch {
        return fallback;
    }
};
/** يختار الترجمة المناسبة من JSON {ar,en} */
export const tr = (v, locale = 'ar') => {
    const o = parseJson(v, {}) || {};
    return o[locale] || o.ar || o.en || '';
};
export function normalizeAr(s) {
    return String(s || '').toLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
export function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
/** ترقيم بالمؤشر (cursor) على (created_at DESC, id DESC) */
export function pageParams(query, defLimit = 20, max = 100) {
    const limit = Math.min(Math.max(Number.parseInt(String(query.limit ?? ''), 10) || defLimit, 1), max);
    let cursor = null;
    if (query.cursor) {
        try {
            const [createdAt, id] = Buffer.from(String(query.cursor), 'base64url').toString().split('|');
            if (createdAt && id)
                cursor = { createdAt, id };
        }
        catch { /* ignore */ }
    }
    return { limit, cursor };
}
export function cursorSql(alias, cursor) {
    if (!cursor)
        return { sql: '', params: [] };
    return { sql: ` AND (${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`, params: [cursor.createdAt, cursor.createdAt, cursor.id] };
}
export function finishPage(rows, limit) {
    const has = rows.length > limit;
    const items = has ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: has && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null };
}
//# sourceMappingURL=util.js.map