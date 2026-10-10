import { s, parse } from '../core/validate.js';
import { E } from '../core/errors.js';
import { uuid } from '../core/security.js';
import { iso } from '../core/util.js';
import { limit } from '../core/rateLimit.js';
import { auth } from './auth.middleware.js';
import type { App } from '../app.js';
import type { Ctx, Router } from '../core/http.js';

const MAX_BYTES = 5 * 1024 * 1024;
const PUBLIC_PURPOSES = ['avatar', 'work_photo', 'service_icon'];
const PURPOSES = ['avatar', 'order_attachment', 'provider_document', 'work_photo', 'service_icon'] as const;

interface FileRow { id: string; owner_id: string; storage_key: string; mime: string; size: number; purpose: string }

/** فحص التوقيع الحقيقي للملف (Magic bytes) — لا نثق بالنوع الذي يعلنه العميل */
function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 5 && buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  // WebM/Opus recordings produced by MediaRecorder.
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  // Ogg/Opus recordings on browsers that prefer OGG containers.
  if (buf.length > 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  return null;
}

export function registerFileRoutes(app: App, r: Router): void {
  const { db } = app;

  r.post('/files', auth, limit('upload', { max: 40, windowMs: 3600_000, key: (c: Ctx) => c.user?.id || c.ip }), (ctx: Ctx) => {
    const b = parse<{ purpose: typeof PURPOSES[number]; name?: string; dataBase64: string }>(s.obj({ purpose: s.oneOf(PURPOSES), name: s.str({ max: 120, optional: true }), dataBase64: s.str({ min: 8, trim: false }) }), ctx.body);
    const buf = Buffer.from(b.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw E.unprocessable('الملف فارغ', 'EMPTY_FILE');
    if (buf.length > MAX_BYTES) throw E.unprocessable('حجم الملف يتجاوز 5MB', 'FILE_TOO_LARGE');
    const mime = sniff(buf);
    const allowed = (b.purpose === 'provider_document') ? ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] : b.purpose === 'order_attachment' ? ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/webm', 'audio/ogg'] : ['image/jpeg', 'image/png', 'image/webp'];
    if (!mime || !allowed.includes(mime)) throw E.unprocessable('نوع الملف غير مدعوم', 'UNSUPPORTED_FILE_TYPE');
    if (b.purpose === 'service_icon' && ctx.user!.role !== 'ADMIN') throw E.forbidden();
    const id = uuid();
    app.storage.save(id, buf);
    db.run('INSERT INTO files(id,owner_id,storage_key,original_name,mime,size,purpose,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.user!.id, id, (b.name || '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120) || null, mime, buf.length, b.purpose, iso(app.clock.now()));
    ctx.status = 201;
    return { file: { id, mime, size: buf.length, purpose: b.purpose, url: `/api/v1/files/${id}` } };
  });

  r.get('/files/:id', (ctx: Ctx) => {
    const f = db.get<FileRow>('SELECT * FROM files WHERE id = ?', ctx.params['id']);
    if (!f) throw E.notFound('الملف غير موجود');
    if (!PUBLIC_PURPOSES.includes(f.purpose)) {
      auth(ctx); // الملفات الخاصة تتطلب تسجيل الدخول
      const u = ctx.user!;
      let ok = u.role === 'ADMIN' || f.owner_id === u.id;
      if (!ok && u.role === 'PROVIDER' && f.purpose === 'order_attachment') {
        ok = !!db.get(`SELECT 1 FROM orders o, json_each(o.attachments) je WHERE je.value = ? AND (o.provider_id = ? OR EXISTS (SELECT 1 FROM order_assignments a WHERE a.order_id = o.id AND a.provider_id = ? AND a.status IN ('OFFERED','ACCEPTED')))`, f.id, u.providerId, u.providerId) || !!db.get(`SELECT 1 FROM order_messages m JOIN orders o ON o.id=m.order_id, json_each(m.attachments) je WHERE je.value=? AND (o.provider_id=? OR EXISTS (SELECT 1 FROM order_assignments a WHERE a.order_id=o.id AND a.provider_id=? AND a.status IN ('OFFERED','ACCEPTED')))`, f.id, u.providerId, u.providerId);
      }
      if (!ok) throw E.forbidden();
    }
    ctx.raw = true;
    ctx.res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': String(f.size), 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
      'Cache-Control': PUBLIC_PURPOSES.includes(f.purpose) ? 'public, max-age=3600' : 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    ctx.res.end(app.storage.read(f.storage_key));
  });
}
