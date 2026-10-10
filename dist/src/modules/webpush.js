import crypto from 'node:crypto';
const text = (v) => Buffer.from(v);
const b64u = (v) => {
    const bytes = typeof v === 'string' ? Buffer.from(v) : Buffer.from(v);
    return bytes.toString('base64url');
};
const fromB64u = (v) => Buffer.from(v, 'base64url');
function hkdfExtract(salt, ikm) {
    return crypto.createHmac('sha256', salt).update(ikm).digest();
}
function hkdfExpand(prk, info, len) {
    const out = [];
    let prev = Buffer.from([]);
    for (let i = 1; Buffer.concat(out).length < len; i++) {
        prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
        out.push(prev);
    }
    return Buffer.concat(out).subarray(0, len);
}
function derToJose(der) {
    let p = 0;
    if (der[p++] !== 0x30)
        throw new Error('Invalid ECDSA signature');
    let len = der[p++];
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++)
            len = len * 256 + der[p++];
    }
    if (der[p++] !== 0x02)
        throw new Error('Invalid ECDSA signature');
    const rLen = der[p++];
    let r = der.subarray(p, p + rLen);
    p += rLen;
    if (der[p++] !== 0x02)
        throw new Error('Invalid ECDSA signature');
    const sLen = der[p++];
    let s = der.subarray(p, p + sLen);
    while (r.length > 32 && r[0] === 0)
        r = r.subarray(1);
    while (s.length > 32 && s[0] === 0)
        s = s.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - r.length), r, Buffer.alloc(32 - s.length), s]);
}
function publicUncompressed(key) {
    const jwk = key.export({ format: 'jwk' });
    return Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
}
function privateJwk(key) { return key.export({ format: 'jwk' }); }
function createVapidKeys() {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { publicKey: b64u(publicUncompressed(pair.publicKey)), privateKey: JSON.stringify(privateJwk(pair.privateKey)) };
}
function encryptPayload(subscription, payload) {
    const clientPublic = fromB64u(subscription.p256dh);
    if (clientPublic.length !== 65 || clientPublic[0] !== 4)
        throw new Error('Invalid subscription public key');
    const auth = fromB64u(subscription.auth);
    if (auth.length < 8)
        throw new Error('Invalid subscription auth secret');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const serverPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(clientPublic);
    const authInfo = Buffer.concat([text('WebPush: info\0'), clientPublic, serverPublic]);
    const ikm = hkdfExpand(hkdfExtract(auth, shared), authInfo, 32);
    const salt = crypto.randomBytes(16);
    const prk = hkdfExtract(salt, ikm);
    const cek = hkdfExpand(prk, text('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdfExpand(prk, text('Content-Encoding: nonce\0'), 12);
    const padded = Buffer.concat([payload, Buffer.from([2])]);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
    const recordSize = Buffer.alloc(4);
    recordSize.writeUInt32BE(4096, 0);
    const body = Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, encrypted]);
    return { body, serverPublic: b64u(serverPublic) };
}
function vapidJwt(endpoint, privateKeyJwkJson, publicKey, subject) {
    const url = new URL(endpoint);
    const key = crypto.createPrivateKey({ key: JSON.parse(privateKeyJwkJson), format: 'jwk' });
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const payload = b64u(JSON.stringify({ aud: `${url.protocol}//${url.host}`, exp: now + 12 * 3600, sub: subject }));
    const input = `${header}.${payload}`;
    const signature = derToJose(crypto.sign('sha256', Buffer.from(input), key));
    return `${input}.${b64u(signature)}`;
}
export function createWebPushService(app) {
    let keys = null;
    const load = () => {
        if (keys)
            return keys;
        const pub = app.settings.get('push.vapid_public_key');
        const priv = app.settings.get('push.vapid_private_key');
        if (pub && priv)
            keys = { publicKey: pub, privateKey: priv };
        else {
            keys = createVapidKeys();
            app.settings.set('push.vapid_public_key', keys.publicKey);
            app.settings.set('push.vapid_private_key', keys.privateKey);
        }
        return keys;
    };
    return {
        publicKey() { return load().publicKey; },
        async send(userId, notification) {
            const k = load();
            const rows = app.db.all('SELECT id,endpoint,p256dh,auth FROM notification_subscriptions WHERE user_id=?', userId);
            if (!rows.length)
                return;
            const payload = Buffer.from(JSON.stringify({ title: notification.title, body: notification.body, data: notification.data || {} }));
            for (const row of rows) {
                if (!row.p256dh || !row.auth)
                    continue;
                try {
                    const enc = encryptPayload({ p256dh: row.p256dh, auth: row.auth }, payload);
                    const jwt = vapidJwt(row.endpoint, k.privateKey, k.publicKey, app.settings.get('push.subject'));
                    const response = await fetch(row.endpoint, {
                        method: 'POST',
                        headers: {
                            Authorization: `vapid t=${jwt}, k=${k.publicKey}`,
                            'Content-Type': 'application/octet-stream',
                            'Content-Encoding': 'aes128gcm',
                            TTL: '300',
                        },
                        body: enc.body,
                    });
                    if (response.status === 404 || response.status === 410)
                        app.db.run('DELETE FROM notification_subscriptions WHERE id=?', row.id);
                    else if (!response.ok)
                        app.log.warn('webpush_delivery_failed', { status: response.status, subscriptionId: row.id });
                }
                catch (err) {
                    app.log.warn('webpush_delivery_error', { subscriptionId: row.id, err: String(err) });
                }
            }
        },
    };
}
//# sourceMappingURL=webpush.js.map