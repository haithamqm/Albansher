import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, E } from './errors.js';
export class Router {
    routes = [];
    add(method, pattern, ...handlers) {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
        this.routes.push({ method, re, keys, handlers, pattern });
    }
    get(p, ...h) { this.add('GET', p, ...h); }
    post(p, ...h) { this.add('POST', p, ...h); }
    put(p, ...h) { this.add('PUT', p, ...h); }
    patch(p, ...h) { this.add('PATCH', p, ...h); }
    delete(p, ...h) { this.add('DELETE', p, ...h); }
    match(method, pathname) {
        let pathMatched = false;
        for (const r of this.routes) {
            const m = r.re.exec(pathname);
            if (!m)
                continue;
            pathMatched = true;
            if (r.method !== method)
                continue;
            const params = {};
            r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
            return { route: r, params };
        }
        return { route: null, params: {}, pathMatched };
    }
}
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
function securityHeaders(config) {
    const h = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=(self)',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self' https://cdnjs.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
            "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://cdnjs.cloudflare.com",
            "connect-src 'self' https://nominatim.openstreetmap.org",
            "font-src 'self' data:",
            "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
        ].join('; '),
    };
    if (config.cookieSecure)
        h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    return h;
}
export function clientIp(req, trustProxy) {
    if (trustProxy) {
        const xf = req.headers['x-forwarded-for'];
        if (xf)
            return String(Array.isArray(xf) ? xf[0] : xf).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}
async function readBody(req, maxBytes) {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes)
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'حجم الطلب كبير جدًا');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > maxBytes)
            throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'حجم الطلب كبير جدًا');
        chunks.push(c);
    }
    if (!size)
        return undefined;
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json'))
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'يجب أن يكون المحتوى JSON');
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw E.badRequest('JSON غير صالح', 'INVALID_JSON');
    }
}
function serveStatic(config, urlPath, res, headers) {
    let rel = decodeURIComponent(urlPath);
    let base = config.publicDir;
    if (rel.startsWith('/shared/')) {
        base = config.sharedDir;
        rel = rel.slice('/shared'.length);
    }
    if (rel === '/' || rel === '')
        rel = '/index.html';
    if (rel === '/admin' || rel === '/admin/')
        rel = '/admin.html';
    if (rel === '/provider' || rel === '/provider/')
        rel = '/provider.html';
    if (rel === '/customer' || rel === '/customer/')
        rel = '/customer.html';
    const file = path.resolve(base, '.' + rel);
    if (!file.startsWith(base + path.sep) && file !== base)
        return false; // منع Path Traversal
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        return false;
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...headers, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
    return true;
}
export function createRequestHandler(app) {
    const { config, router, log } = app;
    const baseHeaders = securityHeaders(config);
    return async function handle(req, res) {
        const started = Date.now();
        const requestId = crypto.randomUUID();
        const url = new URL(req.url || '/', 'http://localhost');
        const ip = clientIp(req, config.trustProxy);
        const headers = { ...baseHeaders, 'X-Request-Id': requestId };
        const origin = req.headers.origin;
        if (origin && config.corsOrigins.includes(origin)) {
            Object.assign(headers, {
                'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Requested-With',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
            });
        }
        const json = (status, body, extra = {}) => {
            const payload = body === undefined ? '' : JSON.stringify(body);
            res.writeHead(status, { ...headers, ...extra, ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}) });
            res.end(payload);
        };
        let status = 500;
        try {
            if (req.method === 'OPTIONS') {
                status = 204;
                return json(204);
            }
            if (!url.pathname.startsWith('/api/')) {
                if (url.pathname === '/health') {
                    status = 200;
                    return json(200, { status: 'ok', time: new Date().toISOString() });
                }
                if (url.pathname === '/ready') {
                    app.db.get('SELECT 1 AS ok');
                    status = 200;
                    return json(200, { status: 'ready' });
                }
                if (req.method === 'GET' && serveStatic(config, url.pathname, res, headers)) {
                    status = 200;
                    return;
                }
                status = 404;
                return json(404, { error: { code: 'NOT_FOUND', message: 'الصفحة غير موجودة', requestId } });
            }
            const pathname = url.pathname.slice('/api/v1'.length) || '/';
            if (!url.pathname.startsWith('/api/v1'))
                throw E.notFound('المسار غير موجود');
            const { route, params, pathMatched } = router.match(req.method, pathname);
            if (!route)
                throw pathMatched ? new AppError(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة') : E.notFound('المسار غير موجود');
            const ctx = {
                app, req, res, params, query: Object.fromEntries(url.searchParams.entries()), ip, requestId, user: null, status: 200, headers: {}, raw: false,
                userAgent: String(req.headers['user-agent'] || '').slice(0, 300), locale: /^en/i.test(String(req.headers['accept-language'] || '')) ? 'en' : 'ar',
            };
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
                ctx.body = await readBody(req, route.pattern === '/files' ? 8 * 1024 * 1024 : 256 * 1024);
            }
            const chain = route.handlers;
            for (let i = 0; i < chain.length - 1; i++)
                await chain[i](ctx);
            const result = await chain[chain.length - 1](ctx);
            if (ctx.raw) {
                status = ctx.status;
                return;
            } // المعالج كتب الاستجابة بنفسه (SSE/ملفات)
            status = result === undefined ? 204 : ctx.status;
            return json(status, result, ctx.headers);
        }
        catch (err) {
            if (err instanceof AppError) {
                status = err.status;
                return json(err.status, { error: { code: err.code, message: err.message, details: err.details, requestId } }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
            }
            status = 500;
            log.error('unhandled_error', { requestId, err: String(err?.stack || err) });
            return json(500, { error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع، حاول لاحقًا', requestId } });
        }
        finally {
            if (url.pathname.startsWith('/api/')) {
                const duration = Date.now() - started;
                log.info('request', { requestId, method: req.method, path: url.pathname, status, ms: duration });
                if (duration >= 1000 || status >= 500) {
                    try {
                        app.db.run(`INSERT INTO system_events(level,event_type,message,request_id,method,path,status_code,duration_ms,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, status >= 500 ? 'ERROR' : 'WARNING', status >= 500 ? 'API_ERROR' : 'SLOW_API', status >= 500 ? 'فشل طلب API' : 'طلب API بطيء', requestId, req.method || null, url.pathname, status, duration, JSON.stringify({ ip }), new Date().toISOString());
                    }
                    catch { /* telemetry must never break the response */ }
                }
            }
        }
    };
}
//# sourceMappingURL=http.js.map