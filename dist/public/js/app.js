"use strict";
const root = document.getElementById('app');
const page = root.dataset.page || 'customer';
const state = { token: null, user: null, cats: [], orders: [], services: [], temporaryServices: [], campaigns: [], popularity: [], config: { currency: 'YER' } };
const currencyLabel = () => String(state.config?.currency || 'YER');
const A11Y_KEYS = { largeText: 'khadamat_a11y_large_text', highContrast: 'khadamat_a11y_high_contrast', reduceMotion: 'khadamat_a11y_reduce_motion' };
function applyAccessibilityPreferences() {
    const b = document.body;
    b.classList.toggle('a11y-large-text', localStorage.getItem(A11Y_KEYS.largeText) === '1');
    b.classList.toggle('a11y-high-contrast', localStorage.getItem(A11Y_KEYS.highContrast) === '1');
    b.classList.toggle('a11y-reduce-motion', localStorage.getItem(A11Y_KEYS.reduceMotion) === '1');
}
function setAccessibilityPreference(key, enabled) { localStorage.setItem(A11Y_KEYS[key], enabled ? '1' : '0'); applyAccessibilityPreferences(); }
applyAccessibilityPreferences();
const SESSION_KEY = 'khadamat_session_v7';
let leafletPromise = null;
async function ensureLeaflet() {
    if (window.L)
        return window.L;
    if (leafletPromise)
        return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
        const cssId = 'leaflet-css-v66';
        if (!document.getElementById(cssId)) {
            const link = document.createElement('link');
            link.id = cssId;
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);
        }
        const load = (src) => new Promise((ok, bad) => { const script = document.createElement('script'); script.src = src; script.async = true; script.onload = () => ok(window.L); script.onerror = () => bad(new Error('MAP_CDN_FAILED')); document.head.appendChild(script); });
        const timer = window.setTimeout(() => reject(new Error('MAP_LOAD_TIMEOUT')), 8000);
        load('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js').catch(() => load('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js')).then(L => { window.clearTimeout(timer); if (L)
            resolve(L);
        else
            reject(new Error('MAP_NOT_AVAILABLE')); }).catch(e => { window.clearTimeout(timer); reject(e); });
    }).catch(e => { leafletPromise = null; throw e; });
    return leafletPromise;
}
let customerPollTimer;
let providerPollTimer;
let providerHeartbeatTimer;
let notificationPollTimer;
let lastProviderOfferIds = new Set();
const acceptingOffers = new Set();
let eventSource;
let liveRefreshTimer;
const stopPollers = () => { if (customerPollTimer !== undefined) {
    clearInterval(customerPollTimer);
    customerPollTimer = undefined;
} if (providerPollTimer !== undefined) {
    clearInterval(providerPollTimer);
    providerPollTimer = undefined;
} if (providerHeartbeatTimer !== undefined) {
    clearInterval(providerHeartbeatTimer);
    providerHeartbeatTimer = undefined;
} if (notificationPollTimer !== undefined) {
    clearInterval(notificationPollTimer);
    notificationPollTimer = undefined;
} if (liveRefreshTimer !== undefined) {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = undefined;
} if (eventSource) {
    eventSource.close();
    eventSource = undefined;
} if (offerCountdownTimer !== undefined) {
    clearInterval(offerCountdownTimer);
    offerCountdownTimer = undefined;
} };
let realtime;
let providerLocationWatch;
let providerLocationLastSent = 0;
let realtimeRetry;
let offerCountdownTimer;
let notificationModalTimer;
let notificationModalRefreshing = false;
const stopRealtime = () => { if (realtime) {
    realtime.close();
    realtime = undefined;
} if (realtimeRetry !== undefined) {
    clearTimeout(realtimeRetry);
    realtimeRetry = undefined;
} };
function b64ToUint8(v) { const pad = '='.repeat((4 - v.length % 4) % 4); const raw = atob(v.replace(/-/g, '+').replace(/_/g, '/') + pad); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
async function registerWebPushSubscription() {
    if (!state.user || !('serviceWorker' in navigator) || !('PushManager' in window))
        return false;
    const reg = await navigator.serviceWorker.register('/sw.js');
    const keyPayload = await api('/notifications/vapid-public-key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub)
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(keyPayload.publicKey) });
    const json = sub.toJSON();
    if (json.endpoint)
        await api('/notifications/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth, platform: 'WEB' }) });
    localStorage.setItem('khadamat_push_enabled', '1');
    return true;
}
async function enableSystemNotifications() {
    if (!('Notification' in window))
        throw new Error('المتصفح لا يدعم إشعارات الجهاز');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
        throw new Error('لم يتم السماح بإشعارات الجهاز');
    localStorage.setItem('khadamat_system_notifications', '1');
    await registerWebPushSubscription();
    return true;
}
function maybeSystemNotification(title, body) {
    try {
        if (localStorage.getItem('khadamat_push_enabled') === '1')
            return;
        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible')
            new Notification(title, { body, tag: 'khadamat-notification' });
    }
    catch { }
}
function toast(title, body) { let box = document.getElementById('liveToasts'); if (!box) {
    box = document.createElement('div');
    box.id = 'liveToasts';
    box.style.cssText = 'position:fixed;right:14px;left:14px;bottom:82px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:520px;margin-right:auto;margin-left:auto;pointer-events:none;';
    document.body.appendChild(box);
} const el = document.createElement('div'); el.style.cssText = 'width:min(100%,460px);background:#fff;border:1px solid #d9e1ea;border-radius:14px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.14);font-family:Arial,sans-serif;cursor:pointer;pointer-events:auto;direction:rtl;text-align:right'; el.innerHTML = `<b>${esc(title)}</b><div style="margin-top:4px;color:#667085;font-size:13px">${esc(body)}</div>`; el.onclick = () => el.remove(); box.appendChild(el); setTimeout(() => el.remove(), 7000); }
// V72 UX: keep errors inside the app instead of browser-native blocking dialogs.
const nativeAlert = window.alert.bind(window);
window.alert = (message) => {
    try {
        toast('تنبيه', String(message ?? 'حدث خطأ غير متوقع'));
    }
    catch {
        nativeAlert(String(message ?? 'حدث خطأ غير متوقع'));
    }
};
function updateConnectionBanner() {
    const id = 'connectionBanner';
    let el = document.getElementById(id);
    if (navigator.onLine) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.setAttribute('role', 'status');
        el.innerHTML = '<span>📴</span><div><b>أنت غير متصل بالإنترنت</b><small>يمكنك متابعة ما يدعم العمل دون اتصال، وسيتم إرسال الطلبات والرسائل المحفوظة عند عودة الاتصال.</small></div>';
        document.body.appendChild(el);
    }
}
window.addEventListener('offline', updateConnectionBanner);
window.addEventListener('online', () => { updateConnectionBanner(); toast('عاد الاتصال', 'جارٍ مزامنة البيانات والطلبات المحفوظة.'); });
updateConnectionBanner();
async function startRealtime() {
    stopRealtime();
    if (!state.user || !state.token)
        return;
    try {
        const j = await api('/events/ticket', { method: 'POST', body: '{}' });
        const es = new EventSource('/api/v1/events?ticket=' + encodeURIComponent(j.ticket));
        realtime = es;
        es.addEventListener('notification', async (ev) => {
            try {
                const n = JSON.parse(ev.data || '{}');
                toast(n.title || 'إشعار جديد', n.body || '');
                maybeSystemNotification(n.title || 'إشعار جديد', n.body || '');
                if (document.getElementById('notificationList'))
                    await refreshOpenNotifications();
                const chatIsOpen = !!document.getElementById('chatMessages');
                if (n.type === 'NEW_OFFER' && page === 'provider' && !chatIsOpen) {
                    await provider();
                }
                if (n.type === 'CHAT_MESSAGE' && n.orderId && chatIsOpen) {
                    window.dispatchEvent(new CustomEvent('khadamat:chat', { detail: { orderId: n.orderId } }));
                }
                if (page === 'provider') {
                    if (['NEW_OFFER', 'PROVIDER_VERIFIED', 'PROVIDER_REJECTED', 'PROVIDER_SUSPENDED', 'PROVIDER_REACTIVATED', 'NEW_RATING', 'COMPLAINT_OPENED', 'COMPLAINT_REPLIED', 'COMPLAINT_CLOSED', 'CHAT_MESSAGE'].includes(n.type) && !(n.type === 'CHAT_MESSAGE' && chatIsOpen))
                        await provider();
                }
                else if (page === 'customer') {
                    if (['ORDER_RECEIVED', 'ORDER_ACCEPTED', 'PROVIDER_ON_THE_WAY', 'SERVICE_STARTED', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'NO_PROVIDER_FOUND', 'NEW_QUOTE', 'QUOTE_ACCEPTED', 'COMPLAINT_OPENED', 'COMPLAINT_REPLIED', 'COMPLAINT_CLOSED', 'CHAT_MESSAGE'].includes(n.type) && !(n.type === 'CHAT_MESSAGE' && chatIsOpen))
                        await customer();
                }
            }
            catch { }
        });
        es.addEventListener('chat_message', (ev) => { try {
            const d = JSON.parse(ev.data || '{}');
            if (d?.orderId)
                window.dispatchEvent(new CustomEvent('khadamat:chat-message', { detail: d }));
        }
        catch { } });
        es.addEventListener('complaint_message', (ev) => { try {
            const d = JSON.parse(ev.data || '{}');
            if (d?.complaintId)
                window.dispatchEvent(new CustomEvent('khadamat:complaint-message', { detail: d }));
        }
        catch { } });
        es.addEventListener('trip_location', (ev) => { try {
            const d = JSON.parse(ev.data || '{}');
            if (d?.orderId)
                window.dispatchEvent(new CustomEvent('khadamat:trip-location', { detail: d }));
        }
        catch { } });
        es.addEventListener('sync', async (ev) => { try {
            const data = JSON.parse(ev.data || '{}');
            if (data?.scope === 'catalog' || data?.scope === 'settings' || data?.scope === 'users' || data?.scope === 'provider' || data?.scope === 'addresses' || data?.scope === 'orders' || data?.scope === 'admin') {
                if (page === 'provider')
                    await provider();
                else if (page === 'customer')
                    await customer();
                else if (page === 'admin')
                    await admin();
            }
        }
        catch { } });
        es.onerror = () => { es.close(); realtime = undefined; if (state.user && state.token) {
            realtimeRetry = window.setTimeout(() => { startRealtime().catch(() => { }); }, 4000);
        } };
    }
    catch {
        realtimeRetry = window.setTimeout(() => { startRealtime().catch(() => { }); }, 5000);
    }
}
const perfApiStats = [];
function recordApiTiming(path, ms, status) { if (perfApiStats.length >= 200)
    perfApiStats.shift(); perfApiStats.push({ path, ms, status, at: new Date().toISOString() }); }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function applyFieldPlaceholders(scope = document) { const map = { fullName: 'مثال: محمد أحمد', phone: 'مثال: 777123456', email: 'مثال: name@example.com', password: 'أدخل كلمة المرور', identifier: 'رقم الهاتف أو البريد الإلكتروني', displayName: 'مثال: مؤسسة الصيانة الحديثة', specialty: 'مثال: كهرباء وتكييف', bio: 'اكتب نبذة مختصرة عن خبرتك وخدماتك', contactPhone: 'مثال: 777123456', description: 'اكتب ما تحتاجه بالتفصيل', notes: 'أي ملاحظات أو تفاصيل إضافية', recipientName: 'اسم المستفيد', recipientPhone: 'هاتف المستفيد', label: 'مثال: المنزل', address: 'مثال: شارع 30 بجوار...', ar: 'الاسم بالعربية', en: 'الاسم بالإنجليزية' }; scope.querySelectorAll('input,textarea').forEach(el => { if (el.placeholder)
    return; const key = el.name || el.id; if (map[key])
    el.placeholder = map[key]; }); }
const newIdempotencyKey = () => { try {
    return crypto.randomUUID();
}
catch {
    return 'order-' + Date.now() + '-' + Math.random().toString(36).slice(2);
} };
const MESSAGE_OUTBOX = 'khadamat_message_outbox_v1';
function readMessageOutbox() { try {
    return JSON.parse(localStorage.getItem(MESSAGE_OUTBOX) || '[]');
}
catch {
    return [];
} }
function writeMessageOutbox(items) { localStorage.setItem(MESSAGE_OUTBOX, JSON.stringify(items.slice(-100))); }
function queueChatMessage(orderId, payload, key) { const q = readMessageOutbox(); if (!q.some((x) => x.orderId === orderId && x.key === key))
    q.push({ orderId, payload, key, queuedAt: Date.now() }); writeMessageOutbox(q); }
async function flushMessageOutbox() { if (!navigator.onLine || !state.token)
    return; const q = readMessageOutbox(); if (!q.length)
    return; const left = []; let sent = 0; for (const item of q) {
    try {
        await api('/orders/' + encodeURIComponent(item.orderId) + '/messages', { method: 'POST', headers: { 'Idempotency-Key': item.key }, body: JSON.stringify(item.payload) });
        sent++;
    }
    catch {
        left.push(item);
    }
} writeMessageOutbox(left); if (sent)
    toast('تمت مزامنة الرسائل', `تم إرسال ${sent} رسالة محفوظة بعد عودة الاتصال.`); }
const uniqueOrders = (items) => { const seen = new Set(); return items.filter(x => { const id = String(x?.id || ''); if (!id || seen.has(id))
    return false; seen.add(id); return true; }); };
const uniqueBy = (items, key) => { const seen = new Set(); return items.filter(x => { const k = key(x); if (!k || seen.has(k))
    return false; seen.add(k); return true; }); };
const OFFLINE_QUEUE = 'khadamat_order_queue_v1';
function queueOrder(body, key, image) { const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE) || '[]'); q.push({ body, key, image: image || null, createdAt: Date.now() }); localStorage.setItem(OFFLINE_QUEUE, JSON.stringify(q.slice(-10))); }
async function flushOrderQueue() { if (!navigator.onLine || !state.token)
    return; const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE) || '[]'); if (!q.length)
    return; const left = []; for (const item of q) {
    try {
        let body = { ...item.body };
        if (item.image && !body.attachmentFileIds?.length) {
            const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'order_attachment', name: item.image.name, dataBase64: item.image.dataBase64 }) });
            body.attachmentFileIds = [up.file.id];
        }
        await api('/orders', { method: 'POST', headers: { 'Idempotency-Key': item.key }, body: JSON.stringify(body) });
    }
    catch {
        left.push(item);
    }
} localStorage.setItem(OFFLINE_QUEUE, JSON.stringify(left)); if (q.length !== left.length)
    toast('تمت المزامنة', 'تم إرسال الطلبات المحفوظة بعد عودة الإنترنت.'); }
window.addEventListener('online', () => { flushOrderQueue().catch(() => { }); flushMessageOutbox().catch(() => { }); });
async function api(path, opts = {}, retry = true) { const started = performance.now(); const h = new Headers(opts.headers || {}); h.set('Content-Type', 'application/json'); if (state.token)
    h.set('Authorization', `Bearer ${state.token}`); let r; try {
    r = await fetch('/api/v1' + path, { ...opts, headers: h });
}
catch (e) {
    recordApiTiming(path, performance.now() - started, 0);
    throw e;
} const j = await r.json().catch(() => ({})); recordApiTiming(path, performance.now() - started, r.status); if (r.status === 401 && retry && path !== '/auth/refresh' && sessionStorage.getItem(SESSION_KEY)) {
    try {
        const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'khadamat' }, body: '{}' });
        const rj = await refreshed.json().catch(() => ({}));
        if (refreshed.ok && rj.accessToken) {
            saveSession(rj);
            return api(path, opts, false);
        }
    }
    catch { }
    sessionStorage.removeItem(SESSION_KEY);
    state.token = null;
    state.user = null;
    throw new Error('انتهت الجلسة، يرجى تسجيل الدخول من جديد');
} if (!r.ok) {
    const err = new Error(j?.error?.message || 'حدث خطأ');
    err.code = j?.error?.code;
    err.details = j?.error?.details || [];
    throw err;
} return j; }
function saveSession(j) { state.token = j.accessToken; state.user = j.user; sessionStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: j.accessToken, user: j.user })); }
async function openPrivateFile(path) {
    const win = window.open('about:blank', '_blank');
    if (!win) {
        alert('اسمح بفتح النوافذ المنبثقة لعرض الملف.');
        return;
    }
    win.document.write('<p style="font-family:Arial;padding:24px">جارٍ فتح الملف...</p>');
    try {
        let r = await fetch(path, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
        if (r.status === 401) {
            try {
                const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'khadamat' }, body: '{}' });
                const j = await refreshed.json().catch(() => ({}));
                if (refreshed.ok && j.accessToken) {
                    saveSession(j);
                    r = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
                }
            }
            catch { }
        }
        if (!r.ok)
            throw new Error(r.status === 401 ? 'انتهت الجلسة، يرجى تسجيل الدخول من جديد' : 'تعذر فتح الملف');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        win.location.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    catch (e) {
        win.document.body.innerHTML = `<div style="font-family:Arial;padding:24px"><h3>تعذر فتح الملف</h3><p>${esc(e.message)}</p></div>`;
    }
}
function restoreSession() { try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw)
        return false;
    const j = JSON.parse(raw);
    if (!j?.accessToken || !j?.user) {
        sessionStorage.removeItem(SESSION_KEY);
        return false;
    }
    state.token = j.accessToken;
    state.user = j.user;
    return true;
}
catch {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
} }
async function logout() { stopRealtime(); try {
    if (state.token)
        await api('/auth/logout', { method: 'POST', body: '{}' });
}
catch { } state.token = null; state.user = null; sessionStorage.removeItem(SESSION_KEY); location.replace('/'); }
const STATUS_AR = { PENDING: 'قيد المراجعة', SEARCHING: 'جارٍ البحث عن مقدم خدمة', ASSIGNED: 'تم ترشيح مقدم خدمة', ACCEPTED: 'تم قبول الطلب', ON_THE_WAY: 'مقدم الخدمة في الطريق', IN_PROGRESS: 'الخدمة قيد التنفيذ', COMPLETED: 'مكتمل', CANCELLED: 'ملغي', DISPUTED: 'متنازع عليه' };
const statusAr = (s) => STATUS_AR[String(s)] || String(s || 'غير محدد');
const VERIFY_AR = { PENDING: 'قيد التحقق', VERIFIED: 'موثق', REJECTED: 'مرفوض', SUSPENDED: 'موقوف' };
const verifyAr = (s) => VERIFY_AR[String(s)] || String(s || 'غير محدد');
const docTypeAr = (v) => ({ ID: 'الهوية', LICENSE: 'الترخيص', COMMERCIAL_REG: 'السجل التجاري', CERTIFICATE: 'الشهادة', PHOTO_WORK: 'صور الأعمال' }[v] || v);
const docStatusAr = (v) => ({ PENDING: 'قيد المراجعة', APPROVED: 'مقبول', REJECTED: 'مرفوض' }[v] || v);
const formatDateTime = (v) => { if (!v)
    return '—'; const d = new Date(v); if (Number.isNaN(d.getTime()))
    return String(v); return new Intl.DateTimeFormat('ar-YE', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d); };
async function refreshNotificationBadge() { try {
    const j = await api('/notifications?limit=1');
    const el = document.getElementById('notificationCount');
    if (el)
        el.textContent = j.unreadCount ? `(${j.unreadCount})` : '';
    const btn = document.getElementById('notificationsBtn');
    if (btn) {
        btn.classList.toggle('attention', Number(j.unreadCount || 0) > 0);
        btn.title = j.unreadCount ? `لديك ${j.unreadCount} إشعار غير مقروء` : 'الإشعارات';
    }
}
catch { } }
function startNotificationPolling() { if (notificationPollTimer !== undefined)
    clearInterval(notificationPollTimer); if (!state.user || !state.token)
    return; refreshNotificationBadge().catch(() => { }); notificationPollTimer = window.setInterval(() => { refreshNotificationBadge().catch(() => { }); if (page === 'provider')
    refreshProviderNotificationSurface().catch(() => { }); }, 5000); }
async function refreshProviderNotificationSurface() { if (page !== 'provider' || !state.user || !state.token)
    return; try {
    const j = await api('/notifications?limit=5');
    const unread = (j.notifications || []).filter((n) => !n.read);
    const latest = unread[0];
    if (latest?.type === 'NEW_OFFER') {
        const id = String(latest.id || '');
        if (id && !sessionStorage.getItem('khadamat_seen_notif_' + id)) {
            sessionStorage.setItem('khadamat_seen_notif_' + id, '1');
            toast(latest.title || 'طلب جديد', latest.body || '');
        }
    }
}
catch { } }
function notificationAction(n) {
    const d = n.data || {};
    if (n.type === 'NEW_QUOTE' && d.orderId && d.quoteId) {
        if (d.quoteStatus && d.quoteStatus !== 'SUBMITTED')
            return `<div class="notification-action notification-action-done"><b>تم التعامل مع عرض السعر</b><span class="status">${esc(d.quoteStatusAr || d.quoteStatus)}</span><div class="notification-actions"><button class="btn secondary notification-view-quotes" data-order-id="${esc(d.orderId)}" type="button">عرض التفاصيل</button></div></div>`;
        return `<div class="notification-action"><b>إجراء مطلوب منك</b><span>راجع عرض السعر ثم اختر قبول العرض أو رفضه.</span><div class="notification-actions"><button class="btn notification-accept-quote" data-order-id="${esc(d.orderId)}" data-quote-id="${esc(d.quoteId)}" type="button">قبول العرض</button><button class="btn danger notification-reject-quote" data-order-id="${esc(d.orderId)}" data-quote-id="${esc(d.quoteId)}" type="button">رفض العرض</button><button class="btn secondary notification-view-quotes" data-order-id="${esc(d.orderId)}" type="button">عرض التفاصيل</button></div></div>`;
    }
    if (['CHAT_MESSAGE'].includes(n.type) && page === 'provider' && d.orderId)
        return `<div class="notification-action"><span>💬 افتح الطلب ثم تابع المحادثة مع العميل مباشرة.</span><div class="notification-actions"><button class="btn notification-provider-chat" data-order-id="${esc(d.orderId)}" type="button">💬 فتح المحادثة</button><button class="btn secondary notification-provider-order" data-order-id="${esc(d.orderId)}" type="button">متابعة الطلب</button></div></div>`;
    if (n.type === 'NEW_OFFER' && page === 'provider' && d.orderId)
        return `<div class="notification-action"><span>📦 لديك طلب جديد يمكنك مراجعته حتى لو لديك طلب قيد التنفيذ، ما دمت مفعّل استقبال الطلبات.</span><div class="notification-actions"><button class="btn notification-provider-order" data-order-id="${esc(d.orderId)}" type="button">فتح الطلب</button></div></div>`;
    if (['PROVIDER_VERIFIED', 'PROVIDER_REJECTED'].includes(n.type) && page === 'provider')
        return `<div class="notification-action"><button class="btn secondary notification-provider-action" type="button">فتح لوحة مقدم الخدمة</button></div>`;
    if (n.type === 'ORDER_COMPLETED' && page === 'customer' && d.orderId)
        return `<div class="notification-action"><button class="btn notification-order-action" data-order-id="${esc(d.orderId)}" type="button">⭐ فتح التقييم</button><button class="btn secondary notification-view-order" data-order-id="${esc(d.orderId)}" type="button">عرض الطلب</button></div>`;
    return '';
}
async function fetchNotifications() { const j = await api('/notifications?limit=100'); return j.notifications || []; }
async function enrichQuoteNotifications(ns) {
    if (page !== 'customer')
        return ns;
    const quoteNs = ns.filter((n) => n.type === 'NEW_QUOTE' && n.data?.orderId && n.data?.quoteId);
    await Promise.all(quoteNs.map(async (n) => { try {
        const j = await api('/orders/' + encodeURIComponent(n.data.orderId) + '/quotes');
        const q = (j.quotes || []).find((x) => x.id === n.data.quoteId);
        if (q) {
            n.data.quoteStatus = q.status;
            n.data.quoteStatusAr = { SUBMITTED: 'بانتظار قرارك', ACCEPTED: 'تم قبول العرض', REJECTED: 'تم رفض العرض', EXPIRED: 'انتهت صلاحية العرض', WITHDRAWN: 'سحب مقدم الخدمة العرض' }[q.status] || q.status;
        }
    }
    catch { } }));
    return ns;
}
async function renderNotificationList(ns) { const el = document.getElementById('notificationList'); if (!el)
    return; await enrichQuoteNotifications(ns); el.innerHTML = ns.length ? ns.map((n) => `<div class="notification-card ${n.read ? 'is-read' : ''}" data-notification="${esc(n.id)}"><div class="notification-card-head"><span class="notification-dot ${n.read ? '' : 'unread'}"></span><b>${esc(n.title)}</b><small class="muted">${esc(formatDateTime(n.createdAt))}</small></div><p class="muted">${esc(n.body)}</p>${notificationAction(n)}</div>`).join('') : '<div class="card empty">لا توجد إشعارات.</div>'; bindNotificationActions(); }
async function refreshOpenNotifications() { if (!document.getElementById('notificationList') || notificationModalRefreshing)
    return; notificationModalRefreshing = true; try {
    await renderNotificationList(await fetchNotifications());
    await refreshNotificationBadge();
}
catch { }
finally {
    notificationModalRefreshing = false;
} }
function bindNotificationActions() {
    document.querySelectorAll('[data-notification]').forEach(x => x.addEventListener('click', async (e) => { if (e.target.closest('button'))
        return; try {
        await api('/notifications/' + encodeURIComponent(x.dataset.notification || '') + '/read', { method: 'POST', body: '{}' });
        x.classList.add('is-read');
        x.querySelector('.notification-dot')?.classList.remove('unread');
        await refreshNotificationBadge();
    }
    catch { } }));
    document.querySelectorAll('.notification-accept-quote').forEach(x => x.addEventListener('click', async () => { const b = x; b.disabled = true; try {
        await api('/orders/' + encodeURIComponent(b.dataset.orderId || '') + '/quotes/' + encodeURIComponent(b.dataset.quoteId || '') + '/accept', { method: 'POST', body: '{}' });
        const row = b.closest('[data-notification]');
        if (row)
            row.innerHTML = '<div class="notification-success-state"><span>✓</span><div><b>تم قبول عرض السعر</b><small>تم تحديث الطلب وسيظهر أي تقدم جديد تلقائيًا.</small></div></div>';
        await api('/notifications/' + encodeURIComponent(b.closest('[data-notification]')?.getAttribute('data-notification') || '') + '/read', { method: 'POST', body: '{}' });
        await refreshNotificationBadge();
        await customer();
    }
    catch (e) {
        b.disabled = false;
        alert(e.message);
    } }));
    document.querySelectorAll('.notification-reject-quote').forEach(x => x.addEventListener('click', async () => { const b = x; b.disabled = true; try {
        await api('/orders/' + encodeURIComponent(b.dataset.orderId || '') + '/quotes/' + encodeURIComponent(b.dataset.quoteId || '') + '/reject', { method: 'POST', body: '{}' });
        await api('/notifications/' + encodeURIComponent(b.closest('[data-notification]')?.getAttribute('data-notification') || '') + '/read', { method: 'POST', body: '{}' });
        await refreshOpenNotifications();
    }
    catch (e) {
        b.disabled = false;
        alert(e.message);
    } }));
    document.querySelectorAll('.notification-view-quotes').forEach(x => x.addEventListener('click', async () => { const b = x; closeModal(); await openOrderQuotes(b.dataset.orderId || ''); }));
    document.querySelectorAll('.notification-order-action').forEach(x => x.addEventListener('click', async () => { const b = x; const orderId = b.dataset.orderId || ''; if (!orderId)
        return; closeModal(); try {
        await openRating(orderId);
    }
    catch (e) {
        alert(e.message);
    } }));
    document.querySelectorAll('.notification-view-order').forEach(x => x.addEventListener('click', async () => { const b = x; const orderId = b.dataset.orderId || ''; if (!orderId)
        return; closeModal(); try {
        await openOrder(orderId);
    }
    catch (e) {
        alert(e.message);
    } }));
    document.querySelectorAll('.notification-provider-action').forEach(x => x.addEventListener('click', () => { closeModal(); provider(); }));
}
function bindProviderNotificationActions() {
    document.querySelectorAll('.provider-inline-notification').forEach(x => x.addEventListener('click', async (e) => {
        if (e.target.closest('button'))
            return;
        const id = x.dataset.providerNotification || '';
        if (id)
            await api('/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST', body: '{}' }).catch(() => { });
        const orderId = x.querySelector('[data-order-id]')?.dataset.orderId;
        if (orderId) {
            await openProviderOrder(orderId);
        }
    }));
    document.querySelectorAll('.notification-provider-order').forEach(x => x.addEventListener('click', async () => { const b = x; const orderId = b.dataset.orderId || ''; if (!orderId)
        return; const row = b.closest('[data-notification],[data-provider-notification]'); const nid = row?.dataset.notification || row?.dataset.providerNotification || ''; if (nid)
        await api('/notifications/' + encodeURIComponent(nid) + '/read', { method: 'POST', body: '{}' }).catch(() => { }); await openProviderOrder(orderId); }));
    document.querySelectorAll('.notification-provider-chat').forEach(x => x.addEventListener('click', async () => { const b = x; const orderId = b.dataset.orderId || ''; if (!orderId)
        return; const row = b.closest('.provider-inline-notification'); const nid = row?.dataset.providerNotification || ''; if (nid)
        await api('/notifications/' + encodeURIComponent(nid) + '/read', { method: 'POST', body: '{}' }).catch(() => { }); await openOrderChat(orderId); }));
}
async function openNotifications() { try {
    const ns = await fetchNotifications();
    showModal(`<div class="service-picker-head notification-modal-head"><div><h2>الإشعارات</h2><p class="muted">تتحدث هذه النافذة تلقائيًا عند وصول أي تحديث جديد.</p></div><div class="row"><button class="btn secondary" id="enableSystemNotifications" type="button">🔔 تفعيل تنبيهات الجهاز</button><button class="btn secondary" id="readAllNotifications" type="button">✓ تحديد الكل كمقروء</button></div></div><div id="notificationLiveState" class="notification-live-state"><span class="live-pulse"></span> التحديث المباشر مفعل</div><div id="notificationList"></div>`);
    await renderNotificationList(ns);
    document.getElementById('enableSystemNotifications')?.addEventListener('click', async () => { const b = document.getElementById('enableSystemNotifications'); b.disabled = true; try {
        await enableSystemNotifications();
        toast('تم التفعيل', 'ستصل الإشعارات حتى عند انتقال التطبيق للخلفية، وفق دعم المتصفح والجهاز.');
    }
    catch (e) {
        alert(e.message);
    }
    finally {
        b.disabled = false;
    } });
    document.getElementById('readAllNotifications')?.addEventListener('click', async () => { await api('/notifications/read-all', { method: 'POST', body: '{}' }); await refreshOpenNotifications(); });
    if (notificationModalTimer)
        clearInterval(notificationModalTimer);
    notificationModalTimer = window.setInterval(() => refreshOpenNotifications(), 3000);
    await refreshNotificationBadge();
}
catch (e) {
    alert(e.message);
} }
function openAbout() {
    showModal(`<article class="about-app">
    <div class="about-app-head"><div><span class="admin-shell-title">معلومات التطبيق</span><h2>حول تطبيق البنشر الذكي</h2><p class="muted">البنشر الذكي — بنشر وصيانة المركبات</p></div><span class="about-app-mark">🛞</span></div>
    <section class="about-app-section">
      <p><strong>البنشر الذكي</strong> منصة لطلب خدمات البنشر وصيانة المركبات بطريقة واضحة، بدلًا من البحث الطويل عن مقدم الخدمة أو الاتصال بعدة ورش.</p>
      <p>يمكنك اختيار خدمة المركبة، وإرسال موقعك ووصف العطل، ومتابعة الطلب والتواصل مع مقدم الخدمة حتى إتمامه.</p>
    </section>
    <section class="about-app-section"><h3>من إنشاء المهندس هيثم القاضي</h3><p>هذا التطبيق من عمل وتطوير <strong>المهندس هيثم القاضي</strong>، وقد تم تصميمه لربط أصحاب المركبات بمقدمي خدمات البنشر والصيانة وتنظيم الطلبات من لحظة الإرسال حتى الإنجاز.</p></section>
    <section class="about-app-section"><h3>عن البنشر الذكي</h3><p>منصة لطلب خدمات البنشر وصيانة المركبات وإدارة الطلبات ومتابعتها.</p><div class="about-app-services"><span>🛞 <b>إصلاح البنشر</b></span><span>🔧 <b>تبديل الإطارات</b></span><span>🔋 <b>البطارية</b></span><span>🛢️ <b>الزيت والفلاتر</b></span><span>🚚 <b>السطحة</b></span><span>⚡ <b>كهرباء السيارات</b></span></div><p class="muted">تعمل المنصة بالقوائم والبحث التقليدي، دون ذكاء اصطناعي.</p></section>
    <section class="about-app-section"><h3>كيف يعمل التطبيق؟</h3><p>بدلًا من أن تبحث بنفسك عن شخص يقدم الخدمة التي تحتاجها، كل ما عليك هو تحديد الخدمة وإرسال طلبك.</p><p>يقوم التطبيق بتنظيم الطلب وربطه بمقدم الخدمة المناسب، مع إمكانية متابعة حالة الطلب إلى أن يتم إنجازه.</p><p class="about-app-slogan">لا تبحث عن مقدم الخدمة... اطلب الخدمة فقط.</p></section>
    <section class="about-app-section"><h3>هدفنا</h3><p>تسهيل وصول أصحاب المركبات إلى فنيي البنشر والصيانة، ومساعدة مقدمي الخدمة على استقبال الطلبات وإدارتها بوضوح.</p><p>نركز على خدمات المركبات، ونحافظ على خطوات واضحة دون الاعتماد على الذكاء الاصطناعي.</p></section>
    <section class="about-app-contact"><h3>للتواصل والاستفسارات</h3><div class="about-contact-row"><span>📧 <b>البريد الإلكتروني:</b></span><a dir="ltr" href="mailto:HaithamPro77@gmail.com">HaithamPro77@gmail.com</a></div><div class="about-contact-row"><span>📱 <b>واتساب:</b></span><a dir="ltr" href="https://wa.me/967711000121" target="_blank" rel="noopener">00967711000121</a></div><div class="about-contact-row"><span>☎️ <b>رقم التواصل:</b></span><a dir="ltr" href="tel:+967778100022">00967778100022</a></div></section>
    <footer class="about-app-footer"><strong>البنشر الذكي</strong><span>خدمة مركبتك أقرب إليك.</span><small>من إنشاء وتطوير المهندس هيثم القاضي</small></footer>
  </article>`);
}
function roleHome(role) { return role === 'PROVIDER' ? '/provider.html' : role === 'ADMIN' ? '/admin' : '/customer'; }
function redirectToRole(role) { const target = roleHome(role); if (location.pathname !== target)
    location.replace(target); }
function shell(content, title = 'البنشر الذكي') { const home = state.user ? roleHome(state.user.role) : '/'; root.innerHTML = `<main class="shell ${page === 'admin' ? 'admin-page admin-shell' : ''} ${page === 'customer' ? 'customer-shell' : ''} ${page === 'provider' ? 'provider-shell' : ''}"><div class="top app-topbar"><a class="brand brand-lockup" href="${home}" aria-label="البنشر الذكي"><span class="brand-mark">🛞</span><span><strong>البنشر الذكي</strong><small>بنشر وصيانة مركباتك أينما كنت</small></span></a><div class="row top-actions"><button class="btn secondary small about-btn" id="aboutBtn" type="button">حول التطبيق</button>${state.user ? `<button class="btn secondary small account-btn" id="accountBtn" type="button">حسابي</button><button class="btn secondary small notification-top-btn" id="notificationsBtn" type="button">🔔 <span id="notificationCount"></span></button><button class="btn secondary small logout-btn" id="logout">خروج</button>` : ''}</div></div>${content}</main>`; document.getElementById('aboutBtn')?.addEventListener('click', openAbout); document.getElementById('logout')?.addEventListener('click', logout); document.getElementById('notificationsBtn')?.addEventListener('click', openNotifications); document.getElementById('accountBtn')?.addEventListener('click', openAccount); if (state.user)
    refreshNotificationBadge().catch(() => { }); applyFieldPlaceholders(root); }
async function openAccount() {
    try {
        const j = await api('/auth/me');
        const u = j.user || state.user || {};
        const isProvider = u.role === 'PROVIDER';
        const large = localStorage.getItem(A11Y_KEYS.largeText) === '1', contrast = localStorage.getItem(A11Y_KEYS.highContrast) === '1', reduce = localStorage.getItem(A11Y_KEYS.reduceMotion) === '1';
        showModal(`<h2>حسابي</h2><form id="accountForm">${isProvider ? `<div class="account-avatar-editor">${u.avatarUrl ? `<img class="account-avatar-preview" src="${esc(u.avatarUrl)}" alt="صورتي">` : '<div class="account-avatar-preview avatar-empty">👤</div>'}<div><b>الصورة الشخصية</b><p class="muted">JPG أو PNG أو WebP، بحد أقصى 5MB.</p><input id="providerAvatarFile" type="file" accept="image/jpeg,image/png,image/webp"></div></div>` : ''}<div class="grid"><div class="field"><label>الاسم</label><input name="fullName" value="${esc(u.fullName || '')}" disabled></div><div class="field"><label>الهاتف</label><input name="phone" value="${esc(u.phone || '')}" disabled></div><div class="field"><label>البريد الإلكتروني</label><input name="email" value="${esc(u.email || '')}" disabled></div></div>${isProvider ? `<div class="field"><label>اسم النشاط</label><input name="displayName" value="${esc(u.provider?.displayName || '')}" maxlength="80"></div><div class="field"><label>نبذة</label><textarea name="bio" maxlength="1000">${esc(u.provider?.bio || '')}</textarea></div>` : ''}<div class="account-accessibility card"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><b>سهولة الاستخدام</b><p class="muted">إعدادات اختيارية مفيدة لكبار السن ومن يحتاج نصًا أكبر أو حركة أقل.</p></div><span class="status">تُحفظ على هذا الجهاز</span></div><div class="a11y-options"><label><input type="checkbox" id="a11yLargeText" ${large ? 'checked' : ''}> تكبير النص والأزرار</label><label><input type="checkbox" id="a11yHighContrast" ${contrast ? 'checked' : ''}> تباين أعلى</label><label><input type="checkbox" id="a11yReduceMotion" ${reduce ? 'checked' : ''}> تقليل الحركة</label></div></div><button class="btn">حفظ التغييرات</button><p id="accountMsg" class="muted"></p></form>`);
        document.getElementById('a11yLargeText')?.addEventListener('change', (e) => setAccessibilityPreference('largeText', e.currentTarget.checked));
        document.getElementById('a11yHighContrast')?.addEventListener('change', (e) => setAccessibilityPreference('highContrast', e.currentTarget.checked));
        document.getElementById('a11yReduceMotion')?.addEventListener('change', (e) => setAccessibilityPreference('reduceMotion', e.currentTarget.checked));
        document.getElementById('accountForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const msg = document.getElementById('accountMsg');
            try {
                if (isProvider) {
                    const avatar = document.getElementById('providerAvatarFile')?.files?.[0];
                    let avatarFileId;
                    if (avatar) {
                        if (avatar.size > 5 * 1024 * 1024)
                            throw new Error('حجم الصورة يتجاوز 5MB');
                        const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة الصورة')); fr.readAsDataURL(avatar); });
                        const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'avatar', name: avatar.name, dataBase64: data }) });
                        avatarFileId = up.file.id;
                    }
                    await api('/provider/profile', { method: 'PATCH', body: JSON.stringify({ displayName: String(f.get('displayName') || ''), bio: String(f.get('bio') || '') }) });
                    if (avatarFileId) {
                        const me = await api('/me/profile', { method: 'PATCH', body: JSON.stringify({ avatarFileId }) });
                        state.user = me.user;
                        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: state.token, user: state.user }));
                    }
                }
                else {
                    await api('/me/profile', { method: 'PATCH', body: JSON.stringify({ fullName: String(f.get('fullName') || '') }) });
                }
                msg.textContent = 'تم حفظ التغييرات بنجاح';
                msg.className = 'success';
            }
            catch (x) {
                msg.textContent = x.message;
                msg.className = 'error';
            }
        });
    }
    catch (e) {
        alert(e.message);
    }
}
function authBox(forcedRole = null) {
    let selected = forcedRole;
    let mode = 'login';
    let customerOtpPhone = '';
    let customerOtpSent = false;
    const authenticate = async (j) => { saveSession(j); startRealtime().catch(() => { }); startNotificationPolling(); if ('Notification' in window && Notification.permission === 'granted')
        registerWebPushSubscription().catch(() => { }); const target = roleHome(j.user.role); const next = `${target}${target.includes('?') ? '&' : '?'}auth=success`; window.location.replace(next); };
    const draw = () => {
        const selectedLabel = selected === 'CUSTOMER' ? 'حساب عميل' : selected === 'PROVIDER' ? 'حساب مقدم خدمة' : selected === 'ADMIN' ? 'حساب إدارة' : '';
        const isAdmin = selected === 'ADMIN';
        const isProvider = selected === 'PROVIDER';
        shell(`<div class="hero"><h1>مرحبًا بك في البنشر الذكي</h1><p class="muted">${selected === 'CUSTOMER' ? 'تسجيل العميل سريع: رقم الهاتف ← رمز واتساب ← دخول. لا نطلب منك استبيانًا طويلًا.' : forcedRole ? 'هذه واجهة مستقلة للحساب المحدد. بعد تسجيل الدخول ستبقى داخل واجهتك فقط.' : 'اختر نوع الحساب أولًا. بعد تسجيل الدخول ستظهر لك واجهة حسابك فقط.'}</p></div>
      <div class="card account-type-card">${forcedRole ? `<div class="auth-fixed-role"><span class="auth-role-icon">${forcedRole === 'CUSTOMER' ? '👤' : forcedRole === 'PROVIDER' ? '🛠️' : '⚙️'}</span><div><b>${selectedLabel}</b><small class="muted">مسار مستقل</small></div></div>` : `<h2>ما نوع الحساب الذي تريد استخدامه؟</h2><div class="grid auth-role-grid">
        <button class="card auth-role-choice ${selected === 'CUSTOMER' ? 'selected' : ''}" type="button" data-role="CUSTOMER"><span class="auth-role-icon">👤</span><b>عميل</b><small>أطلب خدمات البنشر والصيانة وأتابع طلباتي.</small></button>
        <button class="card auth-role-choice ${selected === 'PROVIDER' ? 'selected' : ''}" type="button" data-role="PROVIDER"><span class="auth-role-icon">🛠️</span><b>مقدم خدمة</b><small>أقدم خدمات البنشر والصيانة وأستقبل الطلبات المناسبة لي.</small></button>
        <button class="card auth-role-choice ${selected === 'ADMIN' ? 'selected' : ''}" type="button" data-role="ADMIN"><span class="auth-role-icon">⚙️</span><b>الإدارة</b><small>دخول الإدارة للحسابات المعتمدة فقط، بدون إنشاء حساب عام.</small></button>
      </div>`}${selected ? `<div class="auth-selected-head"><b>${selectedLabel}</b>${!isAdmin && selected !== 'CUSTOMER' ? `<div class="nav"><button class="btn ${mode === 'login' ? '' : 'secondary'}" id="tabLogin">دخول</button><button class="btn ${mode === 'register' ? '' : 'secondary'}" id="tabReg">حساب جديد</button></div>` : ''}</div><div id="authForm"></div>` : '<div class="notice">اختر نوع الحساب للمتابعة.</div>'}</div>`);
        if (!forcedRole)
            document.querySelectorAll('[data-role]').forEach(x => x.addEventListener('click', () => { selected = x.dataset.role; mode = 'login'; customerOtpSent = false; draw(); }));
        if (!selected)
            return;
        if (selected === 'CUSTOMER') {
            const host = document.getElementById('authForm');
            host.innerHTML = customerOtpSent ? `<form id="customerOtpForm" novalidate><div class="field"><label>رمز التحقق</label><input id="customerOtp" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" placeholder="••••" required><small class="muted">أرسلنا الرمز عبر واتساب إلى ${esc(customerOtpPhone.replace(/^(.{4}).*(.{2})$/, '$1••••$2'))}. الصق الرمز هنا عند وصوله.</small></div><button class="btn" type="submit">تحقق ودخول</button><button class="btn secondary" type="button" id="changeOtpPhone">تغيير الرقم</button><p id="msg"></p></form>` :
                `<form id="customerPhoneForm" novalidate><div class="field"><label>رقم الهاتف</label><input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="مثال: +9677xxxxxxxx" required></div><button class="btn" type="submit">إرسال رمز التحقق عبر واتساب</button><p class="muted">رقم الهاتف للتوثيق فقط، ولن يظهر لمقدم الخدمة.</p><p id="msg"></p></form>`;
            if (customerOtpSent) {
                const f = document.getElementById('customerOtpForm');
                document.getElementById('changeOtpPhone')?.addEventListener('click', () => { customerOtpSent = false; draw(); });
                f.addEventListener('submit', async (e) => { e.preventDefault(); const btn = f.querySelector('button[type=submit]'); btn.disabled = true; const msg = document.getElementById('msg'); try {
                    const code = String(new FormData(f).get('code') || '').trim();
                    const j = await api('/auth/whatsapp/verify', { method: 'POST', body: JSON.stringify({ phone: customerOtpPhone, code }) });
                    await authenticate(j);
                }
                catch (x) {
                    btn.disabled = false;
                    msg.textContent = x.message;
                    msg.className = 'error';
                } });
                setTimeout(() => document.getElementById('customerOtp')?.focus(), 50);
            }
            else {
                const f = document.getElementById('customerPhoneForm');
                f.addEventListener('submit', async (e) => { e.preventDefault(); const btn = f.querySelector('button[type=submit]'); btn.disabled = true; const msg = document.getElementById('msg'); try {
                    customerOtpPhone = String(new FormData(f).get('phone') || '').trim();
                    const j = await api('/auth/whatsapp/request', { method: 'POST', body: JSON.stringify({ phone: customerOtpPhone }) });
                    customerOtpPhone = customerOtpPhone;
                    customerOtpSent = true;
                    draw();
                    const input = document.getElementById('customerOtp');
                    if (j.devCode && input) {
                        input.value = j.devCode;
                    }
                }
                catch (x) {
                    btn.disabled = false;
                    msg.textContent = x.message;
                    msg.className = 'error';
                } });
            }
            return;
        }
        document.getElementById('tabLogin')?.addEventListener('click', () => { mode = 'login'; draw(); });
        document.getElementById('tabReg')?.addEventListener('click', () => { mode = 'register'; draw(); });
        const formHost = document.getElementById('authForm');
        if (!formHost)
            return;
        const providerReg = isProvider && mode === 'register';
        formHost.innerHTML = mode === 'login' ? `<form id="form" autocomplete="on" novalidate><div class="field"><label>الهاتف أو البريد الإلكتروني</label><input name="identifier" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" inputmode="email" ${isAdmin ? 'value="admin@albanshar.app"' : ''} required></div><div class="field"><label>كلمة المرور</label><input name="password" type="password" autocomplete="current-password" required></div><button class="btn" type="submit">دخول</button><p id="msg"></p></form>` : `<form id="form" autocomplete="on" novalidate><div class="field"><label>الاسم</label><input name="fullName" type="text" autocomplete="name" required></div><div class="field"><label>الهاتف</label><input name="phone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+967..."></div><div class="field"><label>البريد الإلكتروني${providerReg ? ' (إلزامي)' : ' (اختياري)'}</label><input name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" inputmode="email" ${providerReg ? 'required' : ''}></div><div class="field"><label>كلمة المرور</label><input name="password" type="password" autocomplete="new-password" required></div>${providerReg ? `<div class="field"><label>نوع مقدم الخدمة</label><select name="providerType"><option value="INDIVIDUAL">فرد</option><option value="TECHNICIAN">فني</option><option value="WORKER">عامل</option><option value="DRIVER">سائق</option><option value="COMPANY">شركة</option></select></div><div class="field"><label>اسم النشاط أو الاسم الظاهر</label><input name="displayName" required></div><div class="field"><label>التخصص</label><input name="specialty" maxlength="120" placeholder="مثال: بنشر متنقل أو ميكانيكا سيارات"></div><div class="field"><label>نبذة مختصرة</label><textarea name="bio" placeholder="ما الخدمات التي تقدمها؟"></textarea></div>` : ''}<button class="btn" type="submit">${providerReg ? 'إنشاء حساب مقدم خدمة' : 'إنشاء حساب'}</button><p id="msg"></p></form>`;
        applyFieldPlaceholders(formHost);
        const form = document.getElementById('form');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitButton = form.querySelector('button[type=submit]');
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.dataset.originalText = submitButton.textContent || '';
                submitButton.textContent = mode === 'login' ? 'جارٍ الدخول...' : (providerReg ? 'جارٍ إنشاء حساب مقدم الخدمة...' : 'جارٍ إنشاء الحساب...');
            }
            const f = new FormData(form);
            const b = {};
            f.forEach((v, k) => b[k] = v);
            try {
                const payload = { ...b, role: selected, locale: 'ar' };
                if (!payload.email)
                    delete payload.email;
                if (providerReg) {
                    payload.provider = { providerType: b.providerType, displayName: b.displayName, bio: b.bio, specialty: b.specialty };
                    if (b.providerType === 'COMPANY')
                        payload.provider.companyName = b.displayName;
                    delete payload.providerType;
                    delete payload.displayName;
                    delete payload.bio;
                }
                const j = mode === 'login' ? await api('/auth/login', { method: 'POST', body: JSON.stringify({ ...b, role: selected }) }) : await api('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
                await authenticate(j);
            }
            catch (x) {
                const submitButton = form.querySelector('button[type=submit]');
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = submitButton.dataset.originalText || 'إرسال';
                }
                const err = x;
                const msg = document.getElementById('msg');
                msg.textContent = err.message;
                msg.className = 'error';
            }
        });
    };
    draw();
}
async function handleNotificationDeepLink() {
    const q = new URLSearchParams(location.search);
    const orderId = q.get('order');
    if (!orderId)
        return;
    try {
        if (page === 'provider') {
            await openProviderOrder(orderId, q.get('chat') === '1');
        }
        else if (page === 'customer') {
            await openOrder(orderId);
            if (q.get('chat') === '1')
                setTimeout(() => openOrderChat(orderId).catch(() => { }), 150);
        }
    }
    catch { }
}
async function fetchAllCustomerOrders() {
    const all = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
        const q = await api('/orders?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        all.push(...(q.orders || []));
        if (!q.nextCursor)
            break;
        cursor = q.nextCursor;
    }
    const rank = (o) => { const st = String(o.status || ''); if (['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(st))
        return 0; if (['PENDING', 'SEARCHING', 'ASSIGNED'].includes(st))
        return 1; if (st === 'COMPLETED')
        return 2; return 3; };
    return uniqueOrders(all).sort((a, b) => rank(a) - rank(b) || (Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '')));
}
async function customer() {
    if (!state.user) {
        authBox(location.pathname === '/customer' ? 'CUSTOMER' : null);
        return;
    }
    if (state.user.role !== 'CUSTOMER') {
        redirectToRole(state.user.role);
        return;
    }
    try {
        const [catalogPayload, o, platformConfig] = await Promise.all([api('/catalog/bootstrap'), api('/orders'), api('/config').catch(() => ({ currency: 'YER' }))]);
        state.config = platformConfig || { currency: 'YER' };
        state.cats = catalogPayload.categories || [];
        state.orders = await fetchAllCustomerOrders();
        state.services = catalogPayload.services || [];
        state.temporaryServices = catalogPayload.temporaryServices || [];
        state.campaigns = catalogPayload.campaigns || [];
        state.popularity = catalogPayload.popularity || [];
        renderCustomer();
        handleNotificationDeepLink().catch(() => { });
        stopPollers();
        customerPollTimer = window.setInterval(async () => { try {
            state.orders = await fetchAllCustomerOrders();
            const box = document.getElementById('orders');
            if (box)
                box.innerHTML = state.orders.length ? state.orders.map(orderCard).join('') : '<div class="card empty">لا توجد طلبات حتى الآن<br><span class="muted">ابدأ باختيار خدمة من القائمة أعلاه</span></div>';
            const count = document.querySelector('#ordersTab .count');
            if (count)
                count.textContent = String(state.orders.length);
            document.querySelectorAll('[data-order]').forEach(x => { x.addEventListener('click', e => { if (e.target.closest('[data-rate-order]'))
                return; openOrder(x.dataset.order); }); x.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openOrder(x.dataset.order);
            } }); });
            document.querySelectorAll('[data-rate-order]').forEach(x => x.addEventListener('click', e => { e.stopPropagation(); openRating(x.dataset.rateOrder); }));
            document.querySelectorAll('[data-reorder-order]').forEach(x => x.addEventListener('click', async (e) => { e.stopPropagation(); try {
                const j = await api('/orders/' + x.dataset.reorderOrder + '/reorder', { method: 'POST', body: '{}' });
                openOrderForm(j.draft.serviceId, j.draft);
            }
            catch (err) {
                alert(err.message);
            } }));
        }
        catch { } }, 5000);
    }
    catch (e) {
        shell(`<div class="card error">${esc(e.message)}</div>`);
    }
}
const DESCRIPTION_SUGGESTIONS = {
    'car-with-driver': ['أحتاج سيارة مع سائق للمشوار ذهابًا وإيابًا', 'أحتاج سيارة مع سائق داخل المدينة', 'أحتاج سيارة مع سائق لمدة عدة ساعات'],
    'passenger-transport': ['أحتاج توصيل أفراد إلى هذا الموقع', 'أحتاج نقل العائلة من الموقع الحالي إلى الوجهة', 'أحتاج مشوارًا إلى المطار'],
    'freight-transport': ['أحتاج نقل بضاعة من هذا الموقع إلى الوجهة', 'لدي حمولة وأحتاج مركبة مناسبة للنقل', 'أحتاج نقل شحنة مع التحميل والتفريغ'],
    'furniture-moving': ['أحتاج نقل أثاث من منزل إلى منزل', 'أحتاج نقل العفش مع التحميل والتنزيل', 'أحتاج نقل أثاث من طابق إلى طابق آخر'],
    'parcel-delivery': ['أحتاج توصيل طرد إلى المستلم', 'لدي طرد جاهز للتوصيل إلى هذا العنوان', 'أحتاج مندوبًا لاستلام الطرد وتوصيله'],
    'shopping-delivery': ['أحتاج شراء واستلام الطلب من المتجر وتوصيله', 'أحتاج توصيل مشتريات من متجر قريب', 'أحتاج مندوبًا لاستلام مشترياتي وتوصيلها'],
    'mobile-car-wash': ['أحتاج غسيل السيارة في موقعي', 'أريد غسيل السيارة من الخارج والداخل', 'السيارة تحتاج غسيلًا متنقلًا'],
    'car-interior-deep-cleaning': ['أحتاج تنظيفًا عميقًا للسيارة من الداخل', 'أحتاج تنظيف المقاعد والفرش', 'أريد تنظيف السيارة من الداخل بالكامل'],
    'car-battery-service': ['السيارة لا تعمل وأحتاج فحص البطارية', 'أحتاج تشغيل السيارة بسبب ضعف البطارية', 'أحتاج استبدال بطارية السيارة'],
    'cleaning': ['أحتاج تنظيف المنزل بالكامل', 'أحتاج تنظيف شقة أو منزل', 'أحتاج تنظيفًا للمكان مع ترتيب بسيط'],
    'electricity': ['لدي عطل كهربائي وأحتاج فنيًا', 'هناك مشكلة في الكهرباء وأحتاج فحصها', 'أحتاج تركيب أو إصلاح كهربائي'],
    'plumbing': ['لدي تسريب مياه وأحتاج سباكًا', 'هناك انسداد في الصرف وأحتاج إصلاحه', 'أحتاج إصلاح مشكلة في السباكة'],
    'daily-worker': ['أحتاج عاملًا للعمل في هذا الموقع', 'أحتاج عمالة للمساعدة في إنجاز العمل', 'أحتاج عاملًا لعدة ساعات'],
    'construction-worker': ['أحتاج عامل بناء في هذا الموقع', 'أحتاج عاملًا لأعمال البناء أو الترميم', 'أحتاج عامل بناء لإنجاز عمل محدد'],
    'government-errands': ['أحتاج من ينهي معاملة حكومية نيابة عني', 'أحتاج متابعة معاملة في جهة حكومية', 'أحتاج مساعدة في إنجاز هذه المعاملة'],
};
async function openFavorites() { try {
    const j = await api('/me/favorites/providers');
    showModal(`<h2>⭐ مقدمو الخدمة المفضلون</h2>${(j.providers || []).map((p) => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(p.displayName)}</b><p class="muted">⭐ ${esc(p.rating || 0)} · ${esc(p.verificationStatus)}</p></div><button class="btn" data-fav-provider="${esc(p.id)}" type="button">إزالة</button></div></div>`).join('') || '<div class="empty">لا توجد حسابات مفضلة بعد.</div>'}`);
    document.querySelectorAll('[data-fav-provider]').forEach(x => x.addEventListener('click', async () => { await api('/me/favorites/providers/' + x.dataset.favProvider, { method: 'DELETE' }); openFavorites(); }));
}
catch (e) {
    alert(e.message);
} }
async function openBeneficiaries() {
    try {
        const j = await api('/me/beneficiaries');
        showModal(`<h2>👨‍👩‍👧 المستفيدون</h2><p class="muted">احفظ أفراد الأسرة أو أي شخص تطلب له الخدمة باستمرار. يمكنك حفظ موقعه الحالي لتسهيل الطلبات اللاحقة.</p><button class="btn" id="addBeneficiary">+ إضافة مستفيد</button><div style="margin-top:12px">${(j.beneficiaries || []).map((b) => `<div class="card"><div class="row" style="justify-content:space-between"><b>${esc(b.label)}</b>${b.location ? '<span class="status">📍 موقع محفوظ</span>' : '<span class="status">بدون موقع</span>'}</div><p>${esc(b.fullName)} · ${esc(b.phone)}</p>${b.location ? `<small class="muted">${esc(b.location.localityText || b.location.addressText || b.location.landmarkText || 'موقع محفوظ')}</small>` : ''}<button class="btn danger small" data-del-beneficiary="${esc(b.id)}" type="button">حذف</button></div>`).join('') || '<div class="empty">لا يوجد مستفيدون محفوظون.</div>'}</div>`);
        document.getElementById('addBeneficiary')?.addEventListener('click', () => {
            showModal(`<h2>إضافة مستفيد</h2><form id="beneficiaryForm"><div class="field"><label>صلة أو وصف المستفيد</label><input name="label" placeholder="أبي / أمي / شخص آخر" required maxlength="40"></div><div class="field"><label>الاسم</label><input name="fullName" placeholder="الاسم" required maxlength="80"></div><div class="field"><label>الهاتف</label><input name="phone" placeholder="الهاتف" required maxlength="24" inputmode="tel"></div><div class="field"><label>موقع المستفيد (اختياري)</label><div class="row"><button class="btn secondary small" id="beneficiaryUseLocation" type="button">📍 حفظ موقعي الحالي</button><span id="beneficiaryLocationStatus" class="muted">يمكن تركه فارغًا.</span></div><div class="field"><input name="localityText" maxlength="200" placeholder="القرية / الحي / المنطقة"></div><div class="field"><input name="landmarkText" maxlength="200" placeholder="أقرب معلم"></div><div class="field"><textarea name="accessNotes" maxlength="500" placeholder="وصف الوصول"></textarea></div><input name="lat" type="hidden"><input name="lng" type="hidden"><input name="accuracy" type="hidden"></div><button class="btn">حفظ</button><p id="beneficiaryMsg"></p></form>`);
            let loc = null;
            document.getElementById('beneficiaryUseLocation')?.addEventListener('click', () => { const st = document.getElementById('beneficiaryLocationStatus'); if (!navigator.geolocation) {
                if (st)
                    st.textContent = 'الموقع غير متاح على هذا الجهاز.';
                return;
            } if (st)
                st.textContent = 'جارٍ تحديد الموقع...'; navigator.geolocation.getCurrentPosition(pos => { loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, source: 'gps' }; document.querySelector('[name="lat"]').value = String(loc.lat); document.querySelector('[name="lng"]').value = String(loc.lng); document.querySelector('[name="accuracy"]').value = String(loc.accuracy || ''); if (st)
                st.textContent = '✓ تم حفظ الموقع الحالي لهذا المستفيد'; }, () => { if (st)
                st.textContent = 'تعذر تحديد الموقع؛ يمكنك الحفظ بدون موقع.'; }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }); });
            document.getElementById('beneficiaryForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try {
                const body = { label: String(f.get('label')), fullName: String(f.get('fullName')), phone: String(f.get('phone')) };
                if (loc) {
                    body.location = { ...loc, addressText: String(f.get('localityText') || ''), localityText: String(f.get('localityText') || ''), landmarkText: String(f.get('landmarkText') || ''), accessNotes: String(f.get('accessNotes') || '') };
                }
                await api('/me/beneficiaries', { method: 'POST', headers: { 'Idempotency-Key': newIdempotencyKey() }, body: JSON.stringify(body) });
                openBeneficiaries();
            }
            catch (x) {
                const m = document.getElementById('beneficiaryMsg');
                if (m) {
                    m.textContent = x.message;
                    m.className = 'error';
                }
            } });
        });
        document.querySelectorAll('[data-del-beneficiary]').forEach(x => x.addEventListener('click', async () => { await api('/me/beneficiaries/' + x.dataset.delBeneficiary, { method: 'DELETE' }); openBeneficiaries(); }));
    }
    catch (e) {
        alert(e.message);
    }
}
async function loadPersonalRecommendations() {
    const box = document.getElementById('personalRecommendations');
    if (!box)
        return;
    try {
        const j = await api('/me/recommendations');
        const rs = j.recommendations || [];
        if (!rs.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = `<div class="section-heading"><div><h2>مقترحة لك</h2><p class="muted">مبنية على طلباتك وعمليات بحثك أنت فقط.</p></div></div><div class="personal-recommendations-grid">${rs.slice(0, 6).map((x) => `<button class="card quick-service" data-personal-service="${esc(x.id)}" type="button"><div class="icon">${esc(x.icon || '🛠️')}</div><b>${esc(x.name)}</b><small class="muted">طلبتها/بحثت عنها ${esc(x.personalUses)} مرة</small></button>`).join('')}</div>`;
        box.querySelectorAll('[data-personal-service]').forEach(x => x.addEventListener('click', () => openOrderForm(x.dataset.personalService)));
    }
    catch {
        box.innerHTML = '';
    }
}
function customerMainCategories(cats) { const all = []; const walk = (items) => items.forEach(x => { all.push(x); if (Array.isArray(x.children))
    walk(x.children); }); walk(cats); return all.filter((x) => x.slug === 'vehicle-services'); }
function pickQuickServices(services, limit = 7, popularity = []) { const rank = new Map(popularity.map((x) => [x.serviceId, Number(x.count || 0)])); const ranked = services.slice().sort((a, b) => (rank.get(b.id) || 0) - (rank.get(a.id) || 0)); const picked = []; const seenCats = new Set(); for (const sv of ranked) {
    const key = String(sv.categoryId || sv.categorySlug || '');
    if (!seenCats.has(key)) {
        seenCats.add(key);
        picked.push(sv);
        if (picked.length >= limit)
            return picked;
    }
} for (const sv of ranked) {
    if (!picked.some(x => x.id === sv.id)) {
        picked.push(sv);
        if (picked.length >= limit)
            break;
    }
} return picked; }
function renderCustomer() {
    shell(`<section class="hero customer-simple-hero garage-hero">
    <div class="garage-hero-copy"><span class="garage-eyebrow">خدمة مركبتك أقرب إليك</span><h1>البنشر الذكي</h1><p>اختر خدمة البنشر أو صيانة المركبة، وحدد موقعك، وسنبحث عن مقدم خدمة مناسب.</p><div class="garage-hero-actions"><button class="btn garage-primary-action" id="browseVehicleServices" type="button">اختر الخدمة الآن ←</button><span class="garage-trust-note">طلب مباشر · متابعة واضحة · بدون ذكاء اصطناعي</span></div></div>
    <img class="garage-hero-art" src="/images/garage.svg" alt="مركبة في ورشة صيانة وإطارات" loading="eager">
  </section>
  <div class="card manual-service-fallback garage-search-card"><div class="section-heading"><div><h2>ما الخدمة التي تحتاجها؟</h2><p class="muted">ابحث باسم الخدمة أو اخترها من القائمة أدناه.</p></div><span class="status">خدمات المركبات فقط</span></div><div class="search-wrap"><div class="row search-row"><div class="search-box"><span class="search-icon">⌕</span><input id="search" autocomplete="off" placeholder="مثال: بنشر متنقل، بطارية، سطحة..."><button class="clear-search" id="clearSearch" type="button" aria-label="مسح">×</button></div></div><div id="suggestions" class="suggestions hide"></div></div></div>
  <div id="customerPriority" class="priority-stack"></div><div id="personalRecommendations"></div>

  <nav class="section-nav" aria-label="التنقل">
    <button class="section-tab active" id="servicesTab">الخدمات</button>
    <button class="section-tab" id="ordersTab">طلباتي <span class="count">${state.orders.length}</span></button>
  </nav>

  <section id="servicesSection">
    <div class="section-heading"><div><h2>الخدمات القريبة من احتياجك</h2><p class="muted">اختر الخدمة المناسبة، وسيتولى النظام البحث عن مقدم خدمة متاح.</p></div></div>
    ${(state.temporaryServices || []).length ? `<div class="temporary-priority card"><div class="section-heading"><div><h2>🔥 متاح الآن</h2><p class="muted">خدمات موسمية أو مؤقتة متاحة حاليًا</p></div></div><div class="grid">${state.temporaryServices.slice(0, 4).map((x) => `<div class="card service temporary-service-card" data-temp-id="${esc(x.id)}"><div class="icon">${esc(x.icon || '🎉')}</div><b>${esc(x.title || x.name)}</b><p>${esc(x.description || '')}</p><button class="btn small" type="button" data-temp-action="${esc(x.id)}">${esc(x.actionLabel || 'اطلب الآن')} ←</button></div>`).join('')}</div></div>` : ''}
    <div class="section-heading quick-heading"><div><h2>ابدأ بسرعة</h2><p class="muted">أكثر الاحتياجات شيوعًا</p></div></div><div class="quick-services-strip"><div class="quick-services" id="quickServices">${pickQuickServices(state.services, 8, state.popularity).map(s => `<button class="card quick-service quick-service-${esc(s.categorySlug || '')}" data-quick-service="${esc(s.id)}" type="button"><div class="icon">${esc(s.icon || s.categoryIcon || '🛠️')}</div><b>${esc(s.name)}</b><small class="muted">${esc(s.categoryName || '')}</small></button>`).join('')}</div>${state.services.length > 8 ? '<button class="btn secondary small" id="showMoreServices" type="button">عرض المزيد</button>' : ''}</div>
    <div class="section-heading"><div><h2>الأقسام الأساسية</h2><p class="muted">خدمات البنشر وصيانة المركبات في مكان واحد.</p></div></div>
    <div class="grid category-grid" id="cats">${customerMainCategories(state.cats).map(c => `<button class="card service category-card" data-cat="${esc(c.slug)}" type="button"><div class="icon">${esc(c.icon || '🛠️')}</div><b>${esc(c.name)}</b><p class="muted">${esc(c.description || ('خدمات ' + c.name))}</p><span class="choose-link">عرض ←</span></button>`).join('')}</div>
    <div class="customer-tools"><button class="btn secondary small" id="safetyCentersBtn" type="button">🛡️ الأمان</button><button class="btn secondary small" id="myLocations" type="button">📍 مواقعي</button><button class="btn secondary small" id="myFavorites" type="button">⭐ المفضلة</button><button class="btn secondary small" id="myBeneficiaries" type="button">👨‍👩‍👧 لأشخاص آخرين</button></div>
  </section>

  <section id="ordersSection" class="hide-section">
    <div class="section-heading"><div><h2>طلباتي</h2><p class="muted">تابع طلباتك وحالتها من هنا</p></div></div>
    <div id="orders">${state.orders.length ? state.orders.map(orderCard).join('') : '<div class="card empty">لا توجد طلبات حتى الآن<br><span class="muted">ابدأ باختيار خدمة من القائمة أعلاه</span></div>'}</div>
  </section>`);
    const activeCustomerOrders = state.orders.filter((o) => ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status));
    const completedCustomerOrders = state.orders.filter((o) => o.status === 'COMPLETED');
    const cp = document.getElementById('customerPriority');
    if (cp) {
        if (activeCustomerOrders.length) {
            const first = activeCustomerOrders[0];
            cp.innerHTML = `<div class="priority-card priority-primary"><div class="priority-icon">📦</div><div class="priority-body"><b>عندك طلب قيد المتابعة</b><p>${esc(first.service?.name || 'طلب خدمة')} · ${esc(statusAr(first.status))}</p></div><button class="btn" id="focusCurrentOrder" type="button">متابعة الطلب</button></div>`;
            document.getElementById('focusCurrentOrder')?.addEventListener('click', () => openOrder(first.id));
        }
        else if (completedCustomerOrders.length) {
            cp.innerHTML = `<div class="priority-card priority-gold"><div class="priority-icon">⭐</div><div class="priority-body"><b>عندك طلب مكتمل</b><p>إذا لم تقيّم مقدم الخدمة بعد، افتح الطلب من «طلباتي» وأرسل تقييمك.</p></div><button class="btn" id="focusOrders" type="button">فتح طلباتي</button></div>`;
            document.getElementById('focusOrders')?.addEventListener('click', () => { document.getElementById('ordersTab')?.click(); document.getElementById('ordersSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        }
    }
    loadPersonalRecommendations();
    document.getElementById('browseVehicleServices')?.addEventListener('click', () => document.getElementById('servicesSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    document.getElementById('myLocations')?.addEventListener('click', openSavedLocations);
    document.getElementById('myFavorites')?.addEventListener('click', openFavorites);
    document.getElementById('myBeneficiaries')?.addEventListener('click', openBeneficiaries);
    document.getElementById('customRequestBtn')?.addEventListener('click', () => openOrderFormBySlug('custom-request'));
    document.getElementById('safetyCentersBtn')?.addEventListener('click', openSafetyCenters);
    const search = document.getElementById('search');
    const suggestions = document.getElementById('suggestions');
    const clear = document.getElementById('clearSearch');
    let timer;
    const showSuggestions = (matches, q) => {
        if (!q) {
            suggestions.className = 'suggestions hide';
            suggestions.innerHTML = '';
            return;
        }
        if (!matches.length) {
            suggestions.className = 'suggestions';
            suggestions.innerHTML = `<div class="suggestion-empty"><b>لم نحدد الخدمة بعد، ولا مشكلة.</b><p class="muted">جرّب كلمات مثل: «بنشر متنقل» أو «تبديل كفر» أو «سطحة».</p><button class="btn small" id="searchCustom" type="button">➕ إرسال كطلب خاص</button></div>`;
            document.getElementById('searchCustom')?.addEventListener('click', () => openOrderFormBySlug('custom-request'));
            return;
        }
        suggestions.className = 'suggestions';
        suggestions.innerHTML = matches.map(m => `<button class="suggestion" type="button" data-suggest-service="${esc(m.serviceId)}"><span class="suggestion-icon">${esc(m.icon || '🛠️')}</span><span class="suggestion-text"><b>${esc(m.serviceName)}</b><small>${esc(m.categoryName)}</small></span><span class="suggestion-arrow">←</span></button>`).join('');
        suggestions.querySelectorAll('[data-suggest-service]').forEach(x => x.addEventListener('click', () => { suggestions.className = 'suggestions hide'; openOrderForm(x.dataset.suggestService); }));
    };
    search.addEventListener('input', () => {
        clear.style.display = search.value ? 'block' : 'none';
        window.clearTimeout(timer);
        const q = search.value.trim();
        if (q.length < 2) {
            showSuggestions([], q);
            return;
        }
        timer = window.setTimeout(async () => {
            try {
                const j = await api('/search/intent', { method: 'POST', body: JSON.stringify({ text: q }) });
                showSuggestions(j.matches || [], q);
            }
            catch {
                showSuggestions([], q);
            }
        }, 180);
    });
    search.addEventListener('focus', async () => { if (search.value.trim().length >= 2) {
        search.dispatchEvent(new Event('input'));
        return;
    } try {
        const j = await api('/me/searches/recent');
        const rs = j.searches || [];
        if (rs.length) {
            suggestions.className = 'suggestions';
            suggestions.innerHTML = '<div class="suggestion-empty">طلباتك وعمليات البحث السابقة</div>' + rs.map((r) => `<button class="suggestion" data-recent-query="${esc(r.query)}" type="button"><span>🕘</span><span>${esc(r.query)}</span><span>←</span></button>`).join('');
            suggestions.querySelectorAll('[data-recent-query]').forEach(x => x.addEventListener('click', () => { search.value = x.dataset.recentQuery || ''; search.dispatchEvent(new Event('input')); }));
        }
    }
    catch { } });
    clear.style.display = search.value ? 'block' : 'none';
    clear.addEventListener('click', () => { search.value = ''; clear.style.display = 'none'; showSuggestions([], ""); search.focus(); });
    document.addEventListener('click', function outside(e) { if (!search.contains(e.target) && !suggestions.contains(e.target)) {
        suggestions.className = 'suggestions hide';
    } }, { once: false });
    document.querySelectorAll('[data-cat]').forEach(x => x.addEventListener('click', () => openCategory(x.dataset.cat)));
    document.querySelectorAll('[data-campaign-action]').forEach(x => x.addEventListener('click', async () => { const z = x; const t = z.dataset.campaignAction || 'NONE'; const v = z.dataset.campaignValue || ''; if (t === 'SERVICE' && v)
        openOrderForm(v);
    else if (t === 'ORDER' && v)
        openOrderForm(v);
    else if (t === 'TRIP' && v)
        openOrderFormBySlug(v);
    else if (t === 'INTERNAL' && v) {
        if (v.startsWith('/') || v.startsWith('http'))
            location.href = v;
        else if (v === 'orders') {
            document.getElementById('ordersTab')?.click();
            document.getElementById('ordersSection')?.scrollIntoView({ behavior: 'smooth' });
        }
        else if (v === 'services') {
            document.getElementById('servicesTab')?.click();
        }
    }
    else if (t === 'URL' && v)
        location.href = v; }));
    const openTemporaryAction = (id) => { const z = state.temporaryServices.find((v) => v.id === id); if (!z)
        return; const flow = z.requestFlow || 'SERVICE'; if (flow === 'TRIP' || z.actionValue === 'motorcycle-trips')
        toast('الخدمة غير متاحة', 'هذا التطبيق مخصص للبنشر وصيانة المركبات فقط.');
    else if (flow === 'URL' && z.actionValue)
        location.href = z.actionValue;
    else if (flow === 'ORDER' && z.actionValue)
        openOrderForm(z.actionValue);
    else if (z.linkedServiceId)
        openOrderForm(z.linkedServiceId);
    else
        toast('تعذر فتح الخدمة', 'الإعلان غير مرتبط بخدمة فعالة حاليًا.'); };
    document.querySelectorAll('[data-temp-id]').forEach(x => x.addEventListener('click', () => openTemporaryAction(x.dataset.tempId || '')));
    document.querySelectorAll('[data-temp-action]').forEach(x => x.addEventListener('click', e => { e.stopPropagation(); openTemporaryAction(x.dataset.tempAction || ''); }));
    document.querySelectorAll('[data-quick-service]').forEach(x => x.addEventListener('click', () => openOrderForm(x.dataset.quickService)));
    document.getElementById('showMoreServices')?.addEventListener('click', () => { const box = document.getElementById('quickServices'); if (!box)
        return; const more = state.services.slice(8); box.innerHTML += more.map((s) => `<button class="card quick-service quick-service-${esc(s.categorySlug || '')}" data-quick-service="${esc(s.id)}" type="button"><div class="icon">${esc(s.icon || s.categoryIcon || '🛠️')}</div><b>${esc(s.name)}</b><small class="muted">${esc(s.categoryName || '')}</small></button>`).join(''); box.querySelectorAll('[data-quick-service]').forEach(x => x.addEventListener('click', () => openOrderForm(x.dataset.quickService))); document.getElementById('showMoreServices').remove(); });
    document.getElementById('servicesTab').onclick = () => switchCustomerSection('services');
    document.getElementById('ordersTab').onclick = () => switchCustomerSection('orders');
    document.querySelectorAll('[data-order]').forEach(x => { x.addEventListener('click', e => { if (e.target.closest('[data-rate-order]'))
        return; openOrder(x.dataset.order); }); x.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openOrder(x.dataset.order);
    } }); });
    document.querySelectorAll('[data-rate-order]').forEach(x => x.addEventListener('click', e => { e.stopPropagation(); openRating(x.dataset.rateOrder); }));
    document.querySelectorAll('[data-reorder-order]').forEach(x => x.addEventListener('click', async (e) => { e.stopPropagation(); try {
        const j = await api('/orders/' + x.dataset.reorderOrder + '/reorder', { method: 'POST', body: '{}' });
        openOrderForm(j.draft.serviceId, j.draft);
    }
    catch (err) {
        alert(err.message);
    } }));
}
function orderCard(o) { const active = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status); const completed = o.status === 'COMPLETED'; return `<div class="card order-card" data-order="${esc(o.id)}" role="button" tabindex="0"><div class="row"><b>${esc(o.code)}</b><span class="status status-${esc(String(o.status).toLowerCase())}">${esc(statusAr(o.status))}</span></div><p>${esc(o.service?.name)} — ${esc(o.description)}</p>${o.provider ? `<p class="muted">👤 ${esc(o.provider.displayName)} · ⭐ ${esc(o.provider.rating)}</p>` : ''}<div class="order-progress"><span class="${active ? 'active' : ''}"></span><span class="${['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED'].includes(o.status) ? 'active' : ''}"></span><span class="${['ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED'].includes(o.status) ? 'active' : ''}"></span><span class="${['IN_PROGRESS', 'COMPLETED'].includes(o.status) ? 'active' : ''}"></span><span class="${completed ? 'active' : ''}"></span></div><small class="muted">${esc(formatDateTime(o.createdAt))} · اضغط لمتابعة الطلب</small>${completed ? `<div class="row" style="margin-top:8px"><button class="btn secondary small" data-reorder-order="${esc(o.id)}" type="button">🔄 إعادة الطلب</button></div>` : ''}${completed ? `<div class="order-rating-inline"><div><b>⭐ ${o.rating ? 'تم تقييم مقدم الخدمة' : 'الطلب مكتمل — قيّم مقدم الخدمة'}</b>${o.rating ? `<p class="muted">تقييمك: ${esc(o.rating.score)} / 5${o.rating.comment ? ` · ${esc(o.rating.comment)}` : ''}</p>` : '<p class="muted">يمكنك إرسال تقييمك من هنا مباشرة.</p>'}</div><button class="btn ${o.rating ? 'secondary' : ''} small" data-rate-order="${esc(o.id)}" type="button">${o.rating ? 'عرض التقييم' : '⭐ تقييم الآن'}</button></div>` : ''}</div>`; }
function switchCustomerSection(section) {
    const services = document.getElementById('servicesSection');
    const orders = document.getElementById('ordersSection');
    const st = document.getElementById('servicesTab');
    const ot = document.getElementById('ordersTab');
    if (!services || !orders || !st || !ot)
        return;
    const isServices = section === 'services';
    services.className = isServices ? '' : 'hide-section';
    orders.className = isServices ? 'hide-section' : '';
    st.classList.toggle('active', isServices);
    ot.classList.toggle('active', !isServices);
}
async function openCategory(slug) { let services = []; try {
    if (slug) {
        const j = await api('/categories/' + encodeURIComponent(slug) + '/services');
        const activeIds = new Set((state.services || []).map((x) => x.id));
        services = (j.services || []).filter((x) => activeIds.has(x.id));
    }
    else {
        services = state.services;
    }
}
catch (e) {
    alert(e.message);
    return;
} if (!services.length) {
    showModal('<div class="empty">لا توجد خدمات متاحة في هذا القسم حاليًا</div>');
    return;
} showModal(`<div class="service-picker-head"><div><h2>اختر الخدمة</h2><p class="muted">اختر الخدمة الفعلية التي تريد طلبها</p></div></div><div class="grid service-picker">${services.map(s => `<button class="card service service-option" data-service="${esc(s.id)}" type="button"><div class="service-option-icon">${esc(s.icon || '🛠️')}</div><div class="service-option-body"><b>${esc(s.name)}</b><p>${esc(s.description || 'اطلب هذه الخدمة وسيتم البحث عن مقدم خدمة مناسب')}</p><span class="choose-link">طلب الخدمة ←</span></div></button>`).join('')}</div>`); document.querySelectorAll('[data-service]').forEach(x => x.addEventListener('click', () => openOrderForm(x.dataset.service))); }
async function openOrderFormBySlug(slug) { try {
    const j = await api('/services/' + encodeURIComponent(slug));
    await openOrderForm(j.service.id, j.service);
}
catch (e) {
    alert(e.message);
} }
async function openSafetyCenters() { try {
    const j = await api('/safety-centers');
    showModal(`<h2>🛡️ مراكز الأمان</h2><p class="muted">اختر المركز المناسب عند الحاجة.</p>${(j.centers || []).map((x) => `<div class="card"><b>${esc(x.name)}</b><p class="muted">${esc(x.addressText || '')}</p><div class="row">${x.phone ? `<a class="btn secondary" href="tel:${esc(x.phone)}">📞 اتصال</a>` : ''}${x.emergencyPhone ? `<a class="btn danger" href="tel:${esc(x.emergencyPhone)}">🚨 طوارئ</a>` : ''}<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lng}">🧭 الخريطة</a></div></div>`).join('') || '<div class="card muted">لا توجد مراكز أمان مسجلة حاليًا.</div>'}`);
}
catch (e) {
    alert(e.message);
} }
async function openNearbyProviders(serviceId, lat, lng) {
    let la = lat, ln = lng;
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
        try {
            const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }));
            la = pos.coords.latitude;
            ln = pos.coords.longitude;
        }
        catch {
            alert('حدد موقعك أولًا لعرض مقدمي الخدمة القريبين.');
            return;
        }
    }
    try {
        const j = await api(`/providers/nearby?serviceId=${encodeURIComponent(serviceId)}&lat=${encodeURIComponent(String(la))}&lng=${encodeURIComponent(String(ln))}&limit=20`);
        const rows = j.providers || [];
        showModal(`<div><h2>📍 مقدمو الخدمة القريبون</h2><p class="muted">الخدمة المطلوبة: ${esc(state.services.find((x) => x.id === serviceId)?.name || 'الخدمة')} · ${j.targetArea ? `منطقتك: ${esc(j.targetArea.name)} (${esc(j.targetArea.localityType)})` : 'لم تُحدد منطقة إدارية'}</p>${rows.length ? `<div class="admin-table-wrap"><table class="table"><thead><tr><th>مقدم الخدمة</th><th>التقييم</th><th>المسافة</th><th>التغطية</th><th>الحالة</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td><b>${esc(p.displayName)}</b><br><small class="muted">${esc(p.providerType || 'مقدم خدمة')} ✓ موثق</small></td><td>⭐ ${esc(p.rating?.avg ?? 0)} <small>(${esc(p.rating?.count ?? 0)})</small><br><small>قبول ${esc(p.acceptanceRate ?? 0)}% · استجابة ${esc(p.responseTimeText || 'غير متاح')}</small></td><td><b>${esc(p.distanceText)}</b><br><small class="muted">${esc(p.locationSource === 'live' ? 'الموقع الحالي' : 'الموقع الأساسي')}</small></td><td>${p.coverage?.length ? p.coverage.slice(0, 3).map((a) => esc(a.name)).join(' · ') : 'تغطية عامة'}</td><td><span class="status">${esc(p.availabilityStatusText || 'متاح')}</span>${p.featured ? '<small class="success"> ⭐ مميز</small>' : ''}</td><td><button class="btn small" data-nearby-order="${esc(p.id)}" type="button">طلب الخدمة</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">لا يوجد مقدم خدمة متاح الآن لهذه الخدمة ضمن النطاق القريب. يمكنك إرسال الطلب وسيستمر النظام في البحث.</div>'}</div>`);
        document.querySelectorAll('[data-nearby-order]').forEach(x => x.addEventListener('click', () => { closeModal(); openOrderForm(serviceId); }));
    }
    catch (e) {
        alert(e.message);
    }
}
async function openOrderForm(serviceId, initial = null) {
    const idempotencyKey = newIdempotencyKey();
    const [j, addrPayload, beneficiaryPayload] = await Promise.all([api('/services/' + encodeURIComponent(serviceId)), api('/me/addresses'), api('/me/beneficiaries').catch(() => ({ beneficiaries: [] }))]);
    const savedAddresses = addrPayload.addresses || [];
    const s = j.service;
    const beneficiaries = beneficiaryPayload.beneficiaries || [];
    const requiredFields = (s.formSchema || []).filter((f) => f.required);
    const optionalFields = (s.formSchema || []).filter((f) => !f.required);
    const renderField = (f) => `<div class="field dynamic-order-field"><label>${esc(f.labelText || f.label?.ar || f.key)}${f.required ? ' *' : ''}</label>${f.type === 'textarea' ? `<textarea name="${esc(f.key)}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || 'اكتب المعلومة الضرورية فقط')}"></textarea>` : f.type === 'select' ? `<select name="${esc(f.key)}" ${f.required ? 'required' : ''}>${(f.options || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>` : `<input name="${esc(f.key)}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.max !== undefined ? `max="${esc(f.max)}"` : ''} ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">`}</div>`;
    const fields = requiredFields.map(renderField).join('');
    const optionalFieldsHtml = optionalFields.length ? `<details class="optional-order-details"><summary>تفاصيل إضافية (فقط إذا كانت مهمة)</summary><div class="optional-order-fields">${optionalFields.map(renderField).join('')}</div></details>` : '';
    const descSuggestions = DESCRIPTION_SUGGESTIONS[s.slug] || [];
    const suggestionHtml = descSuggestions.length ? `<div class="description-suggestions"><span>اقتراحات سريعة</span><div>${descSuggestions.map(x => `<button type="button" class="description-chip" data-description-suggestion="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>` : '';
    showModal(`<h2>${esc(s.name)}</h2><div class="row" style="margin-bottom:10px"><button class="btn secondary small" id="nearbyProvidersBtn" type="button">📍 مقدمو الخدمة القريبون</button><span class="muted">اعرض المتاحين حول موقعك قبل إرسال الطلب.</span></div><div class="field"><label>المنطقة أو القرية (اختياري)</label><select id="orderAreaId"><option value="">سيحددها النظام من الموقع تلقائيًا</option></select><small class="muted">يمكنك اختيار مدينة أو مديرية أو عزلة أو قرية أو حارة حتى لو لم تكن منطقتك ظاهرة على الخريطة.</small></div><form id="orderForm"><div class="field beneficiary-first"><label>لمن هذه الخدمة؟</label><select id="beneficiarySelect"><option value="">لي أنا</option>${beneficiaries.map((b) => `<option value="${esc(b.id)}">${esc(b.label)} — ${esc(b.fullName)}</option>`).join('')}<option value="__other__">شخص آخر</option></select><div id="otherRecipient" class="hide-section" style="margin-top:8px"><input id="recipientName" placeholder="اسم المستفيد"><input id="recipientPhone" placeholder="هاتف المستفيد"></div></div><div class="field description-field"><label>ماذا تريد؟</label><textarea id="orderDescription" name="description" required placeholder="اكتب ما تحتاجه فقط">${esc(initial?.description || '')}</textarea>${suggestionHtml}</div>${fields}${optionalFieldsHtml}<div class="field location-field"><label>الموقع</label><div class="card" style="margin-bottom:10px"><div class="row"><select id="savedAddress" style="flex:1"><option value="">📍 استخدام موقع جديد من GPS</option>${savedAddresses.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}${a.isDefault ? ' — الافتراضي' : ''}</option>`).join('')}</select></div><p id="savedAddressStatus" class="muted" style="margin:8px 0 0">اختر عنوانًا محفوظًا أو حدّد موقعًا جديدًا. يمكنك أيضًا إرسال الطلب بدون موقع، وإذا سمح هاتفك بالموقع سنحاول إضافته تلقائيًا.</p></div><div class="row location-row"><button class="btn secondary" id="useLocation" type="button">📍 إرسال موقعي الحالي</button><span id="locationStatus" class="muted">لا تحتاج لمعرفة الخريطة؛ إضافة الموقع تساعد مقدم الخدمة، لكنها ليست شرطًا لإرسال الطلب.</span></div><div class="location-human-fields"><div class="field"><label>وصف الموقع عند الحاجة</label><input id="localityText" name="localityText" maxlength="300" placeholder="مثال: القرية أو الحي أو أقرب معلم"></div></div><div id="locationPreview" class="hide-section"></div><input id="addressId" name="addressId" type="hidden"><input id="lat" name="lat" type="hidden"><input id="lng" name="lng" type="hidden"><input id="accuracy" name="accuracy" type="hidden"><input id="locationConfirmed" name="locationConfirmed" type="hidden" value="0"></div><div class="field"><label>رقم التواصل</label><input name="contactPhone" value="${esc(state.user.phone || '')}" required></div><div class="field"><label>ملاحظات</label><textarea name="notes" placeholder="أي معلومة تساعد مقدم الخدمة"></textarea></div><div class="field"><label>صورة مرفقة <span class="muted">(اختيارية)</span></label><input id="customImage" type="file" accept="image/jpeg,image/png,image/webp"><small class="muted">أرفق صورة إذا كانت تساعد على فهم المطلوب، مثل جهاز أو قطعة أو غرض.</small></div><div class="order-submit-note"><b>قبل الإرسال</b><span>يمكنك إرسال الطلب الآن، وسنستخدم موقعك إذا توفر، ويمكنك وصف المكان بالكلمات عند الحاجة.</span></div><button class="btn submit-order-btn" id="submitOrderBtn" type="submit">إرسال الطلب</button><p id="msg"></p></form>`);
    document.getElementById('nearbyProvidersBtn')?.addEventListener('click', () => { const la = Number(document.getElementById('lat')?.value); const ln = Number(document.getElementById('lng')?.value); openNearbyProviders(serviceId, Number.isFinite(la) ? la : undefined, Number.isFinite(ln) ? ln : undefined); });
    try {
        const areas = (await api('/areas')).areas || [];
        const areaEl = document.getElementById('orderAreaId');
        if (areaEl) {
            const by = new Map(areas.map((a) => [a.id, a]));
            const path = (a) => { const out = []; let cur = a; while (cur && out.length < 8) {
                out.unshift(cur.name);
                cur = cur.parentId ? by.get(cur.parentId) : null;
            } return out.join(' ← '); };
            areas.slice().sort((a, b) => path(a).localeCompare(path(b), 'ar')).forEach((a) => { const o = document.createElement('option'); o.value = a.id; o.textContent = `${path(a)} · ${a.localityType || a.type}`; areaEl.appendChild(o); });
        }
    }
    catch { }
    document.getElementById('beneficiarySelect')?.addEventListener('change', e => { const v = e.target.value; document.getElementById('otherRecipient')?.classList.toggle('hide-section', v !== '__other__'); });
    document.querySelectorAll('[data-description-suggestion]').forEach(x => x.addEventListener('click', () => { const t = document.getElementById('orderDescription'); if (t) {
        t.value = x.dataset.descriptionSuggestion || '';
        t.focus();
    } }));
    const savedSelect = document.getElementById('savedAddress');
    const addressIdInput = document.getElementById('addressId');
    savedSelect.addEventListener('change', () => {
        const id = savedSelect.value;
        addressIdInput.value = id;
        const status = document.getElementById('savedAddressStatus');
        const btn = document.getElementById('useLocation');
        const confirm = document.getElementById('locationConfirmed');
        const preview = document.getElementById('locationPreview');
        if (id) {
            const a = savedAddresses.find((x) => x.id === id);
            status.textContent = a ? `سيُستخدم الموقع المحفوظ: ${a.label}` : 'سيُستخدم العنوان المحفوظ.';
            status.className = 'success';
            preview.className = '';
            preview.innerHTML = a ? `<div class="card"><b>${esc(a.label)}</b><p class="muted">الإحداثيات: ${Number(a.location.lat).toFixed(6)} — ${Number(a.location.lng).toFixed(6)}</p><p class="muted">هذا العنوان محفوظ في حسابك ولن نحتاج لتحديد GPS مرة أخرى.</p></div>` : '';
            confirm.value = '1';
            btn.disabled = true;
            btn.textContent = '📍 اختر موقعًا جديدًا';
        }
        else {
            status.textContent = 'اختر موقعًا جديدًا من GPS.';
            status.className = 'muted';
            preview.className = 'hide-section';
            confirm.value = '0';
            btn.disabled = false;
            btn.textContent = '📍 تحديد موقعي الحقيقي من GPS';
            addressIdInput.value = '';
        }
    });
    document.getElementById('useLocation').addEventListener('click', () => {
        const status = document.getElementById('locationStatus');
        const preview = document.getElementById('locationPreview');
        const locationBtn = document.getElementById('useLocation');
        const latInput = document.getElementById('lat');
        const lngInput = document.getElementById('lng');
        const accuracyInput = document.getElementById('accuracy');
        const confirmedInput = document.getElementById('locationConfirmed');
        if (!navigator.geolocation) {
            status.textContent = 'المتصفح لا يدعم تحديد الموقع';
            status.className = 'error';
            return;
        }
        const MIN_GOOD_ACCURACY = 100;
        const MAX_WAIT_MS = 90000;
        const started = Date.now();
        let best = null;
        let watchId;
        let timer;
        let map = null;
        locationBtn.disabled = true;
        locationBtn.textContent = '📍 جارٍ تحديد الموقع بدقة...';
        status.textContent = 'جارٍ الحصول على موقع الجهاز الحقيقي. أبقِ GPS والموقع مفعّلين وانتظر حتى تتحسن الدقة.';
        status.className = 'muted';
        preview.className = 'hide-section';
        confirmedInput.value = '0';
        latInput.value = '';
        lngInput.value = '';
        accuracyInput.value = '';
        const cleanup = () => {
            if (watchId !== undefined) {
                navigator.geolocation.clearWatch(watchId);
                watchId = undefined;
            }
            if (timer !== undefined) {
                window.clearInterval(timer);
                timer = undefined;
            }
            locationBtn.disabled = false;
            locationBtn.textContent = '📍 إعادة تحديد موقعي';
        };
        const render = async (pos) => {
            const lat = pos.coords.latitude, lng = pos.coords.longitude, accuracy = pos.coords.accuracy;
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) || accuracy <= 0)
                return;
            if (best && best.coords.accuracy <= accuracy)
                return;
            best = pos;
            latInput.value = String(lat);
            lngInput.value = String(lng);
            accuracyInput.value = String(accuracy);
            confirmedInput.value = '0';
            const age = Math.round((Date.now() - started) / 1000);
            const quality = accuracy <= 20 ? 'ممتازة' : accuracy <= 50 ? 'جيدة جدًا' : accuracy <= 100 ? 'جيدة' : accuracy <= 500 ? 'متوسطة' : 'ضعيفة';
            status.textContent = `أفضل قراءة حتى الآن: دقة تقريبية ${Math.round(accuracy)} متر — ${quality}. جارٍ البحث عن قراءة أدق (${age} ثانية).`;
            status.className = accuracy <= 500 ? 'success' : 'muted';
            preview.className = '';
            preview.innerHTML = `<div class="card" style="margin-top:10px"><b>الموقع الذي سيُحفظ في الطلب</b><p class="muted">خط العرض: ${lat.toFixed(6)} — خط الطول: ${lng.toFixed(6)} — أفضل دقة: ${Math.round(accuracy)} متر</p><p class="muted">المصدر: موقع الجهاز عبر Geolocation API — لا يتم تخمين الموقع من اسم المدينة أو IP.</p><div id="captureMap" style="height:260px;width:100%;border-radius:12px;overflow:hidden;margin:10px 0"></div><button class="btn" id="confirmLocation" type="button" ${accuracy > 1000 ? 'disabled' : ''}>${accuracy > 1000 ? '⏳ انتظر دقة GPS أفضل' : '✅ تأكيد هذا الموقع وإرفاقه بالطلب'}</button></div>`;
            const mapEl = document.getElementById('captureMap');
            const L = await ensureLeaflet().catch(() => null);
            if (L && mapEl) {
                if (map) {
                    try {
                        map.remove();
                    }
                    catch { }
                }
                map = L.map(mapEl, { scrollWheelZoom: false, zoomControl: true }).setView([lat, lng], accuracy > 500 ? 13 : 17);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
                const marker = L.marker([lat, lng]).addTo(map).bindPopup(`موقع الجهاز — دقة تقريبية ${Math.round(accuracy)} متر`).openPopup();
                if (accuracy > 0 && accuracy < 10000)
                    L.circle([lat, lng], { radius: accuracy }).addTo(map);
                setTimeout(() => map.invalidateSize(), 100);
            }
            document.getElementById('confirmLocation')?.addEventListener('click', () => {
                if (!best)
                    return;
                const a = best.coords.accuracy;
                if (a > 1000) {
                    status.textContent = 'الدقة الحالية لا تكفي لحفظ موقع خدمة موثوق. استمر في انتظار GPS أو فعّل تحسين دقة الموقع في الهاتف.';
                    status.className = 'error';
                    return;
                }
                confirmedInput.value = '1';
                status.textContent = `تم تأكيد الموقع. سيتم حفظ نفس الإحداثيات (${lat.toFixed(6)}, ${lng.toFixed(6)}) في الطلب.`;
                status.className = 'success';
                cleanup();
            });
            // Stop only after we have a reasonably accurate fix; otherwise keep searching.
            if (accuracy <= MIN_GOOD_ACCURACY) {
                cleanup();
                status.textContent = `تم الحصول على قراءة GPS جيدة بدقة تقريبية ${Math.round(accuracy)} متر. راجع النقطة ثم أكّدها.`;
                status.className = 'success';
            }
        };
        const fail = (err) => {
            if (best)
                return;
            const detail = err?.code === 1 ? 'اسمح للمتصفح بالوصول إلى الموقع من إعدادات الهاتف.' : err?.code === 2 ? 'لم يتمكن الجهاز من تحديد موقعه. فعّل GPS/الموقع وحاول في مكان مفتوح.' : 'انتهت محاولة تحديد الموقع دون قراءة صالحة.';
            status.textContent = detail;
            status.className = 'error';
            cleanup();
        };
        try {
            watchId = navigator.geolocation.watchPosition(render, fail, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
        }
        catch (e) {
            fail();
            return;
        }
        timer = window.setInterval(() => {
            const elapsed = Date.now() - started;
            if (elapsed >= MAX_WAIT_MS) {
                if (timer !== undefined) {
                    window.clearInterval(timer);
                    timer = undefined;
                }
                if (watchId !== undefined) {
                    navigator.geolocation.clearWatch(watchId);
                    watchId = undefined;
                }
                locationBtn.disabled = false;
                locationBtn.textContent = '📍 إعادة تحديد موقعي';
                if (best) {
                    const a = best.coords.accuracy;
                    status.textContent = `انتهى البحث بعد 90 ثانية. أفضل دقة وصلت إليها ${Math.round(a)} متر. ${a > 1000 ? 'الموقع غير كافٍ لإرسال طلب موثوق؛ فعّل تحسين دقة الموقع ثم أعد المحاولة.' : 'راجع النقطة ثم أكّدها.'}`;
                    status.className = a > 1000 ? 'error' : 'success';
                }
                else
                    fail();
            }
        }, 1000);
    });
    // تجربة تلقائية هادئة: إذا كان المستخدم قد سمح للموقع سابقًا، نلتقطه تلقائيًا
    // بدون إظهار نافذة صلاحية جديدة. إذا لم يمنح الإذن، يبقى الزر واضحًا وبسيطًا.
    try {
        const permissions = navigator.permissions;
        if (permissions?.query) {
            const permission = await permissions.query({ name: 'geolocation' });
            if (permission.state === 'granted') {
                document.getElementById('useLocation')?.click();
            }
        }
    }
    catch {
        // بعض المتصفحات لا تدعم Permissions API؛ الزر اليدوي هو البديل الطبيعي.
    }
    document.getElementById('orderForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const formData = {};
        (s.formSchema || []).forEach((f) => { const v = fd.get(f.key); if (v !== null && v !== '')
            formData[f.key] = f.type === 'number' ? Number(v) : v; });
        const addressId = String(fd.get('addressId') || '');
        const lat = Number(fd.get('lat')), lng = Number(fd.get('lng')), accuracy = Number(fd.get('accuracy')), confirmed = String(fd.get('locationConfirmed')) === '1';
        const msg = document.getElementById('msg');
        const beneficiaryId = String(document.getElementById('beneficiarySelect')?.value || '');
        const ben = beneficiaries.find((x) => x.id === beneficiaryId);
        const beneficiaryLocation = !!ben?.location;
        if (!addressId && !beneficiaryLocation && Number.isFinite(lat) && Number.isFinite(lng)) {
            if (Number.isFinite(accuracy) && accuracy > 1000) {
                msg.textContent = 'الموقع غير دقيق حاليًا، لذلك سنرسل الطلب بدونه. يمكنك وصف المكان في الملاحظات.';
                msg.className = 'muted';
            }
        }
        const chosenPriority = String(s.defaultPriority || 'NORMAL');
        const scheduledAt = '';
        const b = { serviceId, description: String(fd.get('description')), contactPhone: String(fd.get('contactPhone')), notes: String(fd.get('notes') || ''), formData, priority: chosenPriority, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined };
        const selectedAreaId = String(document.getElementById('orderAreaId')?.value || '');
        if (selectedAreaId)
            b.areaId = selectedAreaId;
        if (ben) {
            b.recipientName = ben.fullName;
            b.recipientPhone = ben.phone;
            if (ben.location) {
                b.location = { lat: Number(ben.location.lat), lng: Number(ben.location.lng), accuracy: Number(ben.location.accuracy || 0), source: 'manual' };
            }
        }
        else if (beneficiaryId === '__other__') {
            b.recipientName = String(document.getElementById('recipientName')?.value || '').trim();
            b.recipientPhone = String(document.getElementById('recipientPhone')?.value || '').trim();
            if (b.recipientName.length < 2 || b.recipientPhone.length < 8) {
                msg.textContent = 'أدخل اسم ورقم هاتف المستفيد';
                msg.className = 'error';
                return;
            }
        }
        let attachmentFileIds = [];
        let offlineImage;
        const customFile = document.getElementById('customImage');
        const file = customFile?.files?.[0];
        if (file) {
            if (file.size > 5 * 1024 * 1024) {
                msg.textContent = 'حجم الصورة يتجاوز 5MB';
                msg.className = 'error';
                return;
            }
            const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة الصورة')); fr.readAsDataURL(file); });
            if (navigator.onLine) {
                const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'order_attachment', name: file.name, dataBase64: data }) });
                attachmentFileIds = [up.file.id];
            }
            else
                offlineImage = { name: file.name, dataBase64: data };
        }
        if (addressId)
            b.addressId = addressId;
        else if (!beneficiaryLocation && Number.isFinite(lat) && Number.isFinite(lng) && (!Number.isFinite(accuracy) || accuracy <= 1000))
            b.location = { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined, source: 'gps', localityText: String(document.getElementById('localityText')?.value || '').trim() || undefined, landmarkText: String(document.getElementById('landmarkText')?.value || '').trim() || undefined, accessNotes: String(document.getElementById('accessNotes')?.value || '').trim() || undefined, addressText: String(document.getElementById('accessNotes')?.value || '').trim() || undefined };
        if (attachmentFileIds.length)
            b.attachmentFileIds = attachmentFileIds;
        const submitBtn = document.getElementById('submitOrderBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'جارٍ إرسال الطلب...';
        }
        try {
            const created = await api('/orders', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(b) });
            if (s.deliveryProofType === 'PIN' && created?.order?.id) {
                try {
                    const proof = await api('/orders/' + encodeURIComponent(created.order.id) + '/delivery-proof/issue', { method: 'POST', body: '{}' });
                    alert('رمز التسليم الخاص بهذا الطلب: ' + proof.pin + '\nاحتفظ به ولا تشاركه إلا مع المستلم عند التسليم.');
                }
                catch { }
            }
            closeModal();
            await customer();
        }
        catch (x) {
            if (!navigator.onLine) {
                queueOrder(b, idempotencyKey, offlineImage);
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'حفظ الطلب وإرساله عند عودة الإنترنت';
                }
                msg.textContent = 'الإنترنت غير متاح. حُفظ الطلب على هذا الجهاز وسيُرسل تلقائيًا عند عودة الاتصال.';
                msg.className = 'success';
                return;
            }
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'إرسال الطلب';
            }
            msg.textContent = x.message;
            msg.className = 'error';
        }
    });
}
function renderOrderTimeline(current) {
    const steps = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED'];
    const idx = steps.indexOf(current);
    const parts = steps.map((step, i) => {
        const done = idx >= i && idx >= 0;
        const active = step === current;
        return `<div class="timeline-step ${done ? 'done' : ''} ${active ? 'active' : ''}"><span class="timeline-dot">${done ? '✓' : ''}</span><div><b>${esc(statusAr(step))}</b>${active ? '<small>الحالة الحالية</small>' : ''}</div></div>`;
    });
    if (current === 'CANCELLED' || current === 'DISPUTED')
        parts.push(`<div class="timeline-step active"><span class="timeline-dot">!</span><div><b>${esc(statusAr(current))}</b><small>توقفت رحلة الطلب</small></div></div>`);
    return parts.join('');
}
async function openTripTracking(id) { try {
    const j = await api('/orders/' + encodeURIComponent(id) + '/tracking');
    const l = j.location;
    showModal(`<h2>📍 تتبع ${esc(j.code)}</h2><p><b>الحالة:</b> ${esc(statusAr(j.status))}</p><div id="tripLiveMap" style="height:320px;width:100%;border-radius:12px;overflow:hidden"></div><p id="tripLiveText" class="muted">${l ? 'آخر تحديث: ' + esc(formatDateTime(l.updatedAt)) : 'لا يوجد موقع حي متاح حاليًا.'}</p>${l ? '<button class="btn secondary" id="shareLiveLocationBtn" type="button">📍 مشاركة الموقع الحالي</button>' : ''}`);
    const el = document.getElementById('tripLiveMap'), L = window.L;
    document.getElementById('shareLiveLocationBtn')?.addEventListener('click', async () => { const z = j.location; if (!z)
        return; const u = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(z.lat)}&mlon=${encodeURIComponent(z.lng)}#map=18/${encodeURIComponent(z.lat)}/${encodeURIComponent(z.lng)}`; await nativeShare('موقع المشوار', `الموقع الحالي للمشوار ${j.code}`, u); });
    if (el && L && l) {
        const map = L.map(el, { scrollWheelZoom: false }).setView([l.lat, l.lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
        const mk = L.marker([l.lat, l.lng]).addTo(map);
        const onLive = (ev) => { const d = ev.detail; if (d?.orderId === id && d.location) {
            mk.setLatLng([d.location.lat, d.location.lng]);
            map.panTo([d.location.lat, d.location.lng]);
            const t = document.getElementById('tripLiveText');
            if (t)
                t.textContent = 'آخر تحديث: ' + formatDateTime(d.location.updatedAt);
        } };
        window.addEventListener('khadamat:trip-location', onLive);
        const timer = window.setInterval(async () => { if (!document.getElementById('tripLiveMap')) {
            clearInterval(timer);
            window.removeEventListener('khadamat:trip-location', onLive);
            return;
        } try {
            const z = await api('/orders/' + encodeURIComponent(id) + '/tracking');
            if (z.location) {
                mk.setLatLng([z.location.lat, z.location.lng]);
                map.panTo([z.location.lat, z.location.lng]);
            }
        }
        catch { } }, 10000);
        setTimeout(() => map.invalidateSize(), 100);
    }
}
catch (e) {
    alert(e.message);
} }
async function openOrderChat(orderId) {
    try {
        const orderSummary = await api('/orders/' + encodeURIComponent(orderId));
        const orderInfo = orderSummary.order || {};
        const load = async () => { const j = await api('/orders/' + encodeURIComponent(orderId) + '/messages?limit=100'); return j.messages || []; };
        const isProvider = state.user?.role === 'PROVIDER';
        const quick = isProvider ? ['أنا في الطريق', 'وصلت إلى الموقع', 'أحتاج موقعك بالضبط', 'سأتأخر قليلًا', 'أنا عندك الآن'] : ['أين وصلت؟', 'أنا بانتظارك', 'هل أنت قريب؟', 'هذا هو موقعي', 'سأتأخر قليلًا'];
        const pending = () => readMessageOutbox().filter((x) => x.orderId === orderId).sort((a, b) => a.queuedAt - b.queuedAt);
        const render = async () => {
            const [msgs] = await Promise.all([load(), flushMessageOutbox().catch(() => { })]);
            const queued = pending();
            const box = document.getElementById('chatMessages');
            if (box) {
                const serverHtml = msgs.map((m) => `<div class="chat-bubble ${m.senderId === state.user?.id ? 'mine' : 'theirs'}"><div class="chat-meta"><b>${esc(m.senderName || m.senderRole)}</b><small>${esc(formatDateTime(m.createdAt))}</small></div><p>${esc(m.body)}</p>${m.attachments?.length ? `<div class="card" style="margin-top:8px"><b>📎 المرفقات</b><div class="row" style="margin-top:6px">${m.attachments.map((a) => a.mime?.startsWith?.('audio/') ? `<audio controls preload="none" src="${esc(a.url)}" style="max-width:100%"></audio>` : `<button type="button" class="btn secondary small" data-chat-file="${esc(a.url)}">فتح المرفق</button>`).join('')}</div></div>` : ''}${m.location ? `<div class="card" style="margin-top:8px"><b>📍 موقع مرسل</b><p class="muted">${esc(m.location.addressText || 'إحداثيات الموقع')}</p><a class="btn secondary small" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(m.location.lat)}&mlon=${encodeURIComponent(m.location.lng)}#map=18/${encodeURIComponent(m.location.lat)}/${encodeURIComponent(m.location.lng)}">فتح الموقع</a></div>` : ''}</div>`).join('');
                const pendingHtml = queued.map((x) => `<div class="chat-bubble mine chat-pending"><div class="chat-meta"><b>أنت</b><small>جارٍ الإرسال...</small></div><p>${esc(x.payload.body || '📍 الموقع المرسل')}</p></div>`).join('');
                box.innerHTML = (serverHtml || pendingHtml) ? serverHtml + pendingHtml : '<div class="chat-empty">💬 لا توجد رسائل بعد. ابدأ المحادثة من هنا.</div>';
                box.scrollTop = box.scrollHeight;
                box.querySelectorAll('[data-chat-file]').forEach((x) => x.addEventListener('click', () => openPrivateFile(String(x.dataset.chatFile || ''))));
            }
        };
        showModal(`<div class="chat-modal"><div class="chat-header"><div><h2>💬 محادثة الطلب ${esc(orderInfo.code || '')}</h2><p class="muted">${esc(orderInfo.service?.name || '')} · محادثة خاصة بهذا الطلب فقط${orderInfo.provider?.displayName ? ` · ${esc(orderInfo.provider.displayName)}` : ''}</p><p class="muted">الرسائل مباشرة وتُحفظ عند ضعف الاتصال، ولا تظهر خارج أطراف هذا الطلب.</p></div><div class="row"><span class="chat-live-badge">● مباشر · التواصل داخل خدمات</span></div></div><div id="chatMessages" class="chat-messages"></div><div class="chat-quick"><b>اقتراحات سريعة</b><div class="chat-quick-list">${quick.map(q => `<button type="button" class="chat-quick-btn" data-chat-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div></div><form id="chatForm" class="chat-form"><textarea id="chatBody" maxlength="2000" placeholder="اكتب رسالتك هنا..."></textarea><div class="row"><label class="btn secondary" for="chatFile">📎 صورة/ملف</label><input id="chatFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden><button type="button" class="btn secondary" id="sendChatLocation">📍 إرسال موقعي</button><button type="button" class="btn secondary" id="recordChatVoice">🎙️ تسجيل صوتي</button><button class="btn" id="sendChat">إرسال</button></div><small id="chatFileStatus" class="muted"></small></form></div>`);
        await render();
        document.querySelectorAll('[data-chat-quick]').forEach(x => x.addEventListener('click', () => { const body = document.getElementById('chatBody'); if (body) {
            body.value = x.dataset.chatQuick || '';
            body.focus();
        } }));
        document.getElementById('chatForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('sendChat');
            const bodyEl = document.getElementById('chatBody');
            const body = bodyEl.value.trim();
            const selectedFile = document.getElementById('chatFile')?.files?.[0];
            if (!body && !selectedFile)
                return;
            btn.disabled = true;
            try {
                let attachmentFileIds = [];
                const f = selectedFile;
                if (f) {
                    if (!navigator.onLine)
                        throw new Error('المرفقات تحتاج اتصالًا بالإنترنت. أرسل الرسالة النصية الآن وسيتم مزامنتها تلقائيًا.');
                    if (f.size > 5 * 1024 * 1024)
                        throw new Error('حجم الملف يتجاوز 5MB');
                    const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة الملف')); fr.readAsDataURL(f); });
                    const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'order_attachment', name: f.name, dataBase64: data }) });
                    attachmentFileIds = [up.file.id];
                }
                if (!body && !attachmentFileIds.length)
                    return;
                const key = newIdempotencyKey();
                const payload = { body, attachmentFileIds };
                if (!navigator.onLine) {
                    queueChatMessage(orderId, payload, key);
                    bodyEl.value = '';
                    document.getElementById('chatFile').value = '';
                    await render();
                    toast('تم حفظ الرسالة', 'سيتم إرسالها تلقائيًا عند عودة الإنترنت.');
                    return;
                }
                try {
                    await api('/orders/' + encodeURIComponent(orderId) + '/messages', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
                    bodyEl.value = '';
                    document.getElementById('chatFile').value = '';
                    document.getElementById('chatFileStatus').textContent = '';
                    await render();
                }
                catch (err) {
                    if (!navigator.onLine) {
                        queueChatMessage(orderId, payload, key);
                        bodyEl.value = '';
                        document.getElementById('chatFile').value = '';
                        await render();
                        toast('تم حفظ الرسالة', 'سيتم إعادة الإرسال عند عودة الإنترنت.');
                    }
                    else
                        throw err;
                }
            }
            catch (x) {
                alert(x.message);
            }
            finally {
                btn.disabled = false;
            }
        });
        let chatRecorder = null;
        let chatVoiceChunks = [];
        document.getElementById('recordChatVoice')?.addEventListener('click', async () => {
            const btn = document.getElementById('recordChatVoice');
            if (chatRecorder?.state === 'recording') {
                chatRecorder.stop();
                return;
            }
            if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
                alert('التسجيل الصوتي غير مدعوم في هذا المتصفح');
                return;
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '';
                chatVoiceChunks = [];
                chatRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
                chatRecorder.ondataavailable = e => { if (e.data.size)
                    chatVoiceChunks.push(e.data); };
                chatRecorder.onstop = async () => { stream.getTracks().forEach(t => t.stop()); btn.textContent = '🎙️ تسجيل صوتي'; btn.disabled = true; try {
                    const blob = new Blob(chatVoiceChunks, { type: chatRecorder?.mimeType || 'audio/webm' });
                    if (blob.size > 5 * 1024 * 1024)
                        throw new Error('حجم التسجيل يتجاوز 5MB');
                    if (!navigator.onLine)
                        throw new Error('التسجيل الصوتي يحتاج اتصالًا لإرساله الآن');
                    const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة التسجيل')); fr.readAsDataURL(blob); });
                    const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'order_attachment', name: 'voice-message.webm', dataBase64: data }) });
                    const key = newIdempotencyKey();
                    await api('/orders/' + encodeURIComponent(orderId) + '/messages', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ body: '🎙️ رسالة صوتية', attachmentFileIds: [up.file.id] }) });
                    await render();
                    toast('تم إرسال التسجيل', 'أُرسلت الرسالة الصوتية داخل الطلب.');
                }
                catch (e) {
                    alert(e.message);
                }
                finally {
                    btn.disabled = false;
                } };
                btn.textContent = '⏹️ إيقاف التسجيل';
                chatRecorder.start();
            }
            catch (e) {
                alert('تعذر الوصول إلى الميكروفون. اسمح بالوصول للميكروفون ثم حاول مرة أخرى.');
            }
        });
        document.getElementById('sendChatLocation')?.addEventListener('click', async () => {
            const btn = document.getElementById('sendChatLocation');
            if (!navigator.geolocation) {
                alert('المتصفح لا يدعم تحديد الموقع');
                return;
            }
            btn.disabled = true;
            try {
                const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }));
                const lat = Number(pos.coords.latitude), lng = Number(pos.coords.longitude), accuracy = Number(pos.coords.accuracy);
                if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
                    throw new Error('تعذر الحصول على إحداثيات موقع صالحة');
                const payload = { body: '📍 الموقع المرسل', location: { lat, lng, accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : undefined } };
                const key = newIdempotencyKey();
                if (!navigator.onLine) {
                    queueChatMessage(orderId, payload, key);
                    await render();
                    toast('تم حفظ الموقع', 'سيتم إرسال موقعك عند عودة الإنترنت.');
                    return;
                }
                try {
                    await api('/orders/' + encodeURIComponent(orderId) + '/messages', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
                    await render();
                }
                catch (err) {
                    if (!navigator.onLine) {
                        queueChatMessage(orderId, payload, key);
                        await render();
                        toast('تم حفظ الموقع', 'سيتم إرساله عند عودة الإنترنت.');
                    }
                    else
                        throw err;
                }
            }
            catch (e) {
                alert(e.message);
            }
            finally {
                btn.disabled = false;
            }
        });
        const onLive = async (ev) => { const d = ev.detail; if (d?.orderId === orderId)
            await render(); };
        const onDirect = async (ev) => { const d = ev.detail; if (d?.orderId === orderId)
            await render(); };
        window.addEventListener('khadamat:chat', onLive);
        window.addEventListener('khadamat:chat-message', onDirect);
        window.addEventListener('online', onDirect);
        const timer = window.setInterval(async () => { if (!document.getElementById('chatMessages')) {
            clearInterval(timer);
            window.removeEventListener('khadamat:chat', onLive);
            window.removeEventListener('khadamat:chat-message', onDirect);
            window.removeEventListener('online', onDirect);
            return;
        } try {
            await render();
        }
        catch { } }, 5000);
    }
    catch (e) {
        alert(e.message);
    }
}
async function openOrderQuotes(orderId) {
    try {
        const j = await api('/orders/' + encodeURIComponent(orderId) + '/quotes');
        const qs = j.quotes || [];
        showModal(`<h2>عروض الأسعار</h2><p class="muted">اختر العرض الذي يناسبك. قبول العرض يسند الطلب لمقدم الخدمة صاحب العرض.</p><div>${qs.length ? qs.map((q) => `<div class="card" style="margin-top:10px"><div class="row" style="justify-content:space-between"><div><b>${esc(q.providerName || 'مقدم خدمة')}</b><p class="muted">${esc(q.message || 'بدون ملاحظة')}</p></div><b>${esc(q.amount)} ريال</b></div><p class="muted">صالح حتى: ${esc(formatDateTime(q.validUntil))}</p>${q.status === 'SUBMITTED' ? `<button class="btn" data-accept-quote="${esc(q.id)}">قبول العرض</button>` : `<span class="status">${esc(q.status)}</span>`}</div>`).join('') : '<div class="card empty">لم تصل عروض أسعار بعد.</div>'}</div>`);
        document.querySelectorAll('[data-accept-quote]').forEach(x => x.addEventListener('click', async () => { const b = x; b.disabled = true; try {
            await api('/orders/' + encodeURIComponent(orderId) + '/quotes/' + encodeURIComponent(b.dataset.acceptQuote) + '/accept', { method: 'POST', body: '{}' });
            closeModal();
            await customer();
        }
        catch (e) {
            b.disabled = false;
            alert(e.message);
        } }));
    }
    catch (e) {
        alert(e.message);
    }
}
async function openRating(id) {
    try {
        const j = await api('/orders/' + encodeURIComponent(id) + '/rating');
        const o = j.order;
        const existing = j.rating;
        if (o.status !== 'COMPLETED') {
            alert('يمكن التقييم بعد اكتمال الخدمة.');
            return;
        }
        if (existing) {
            showModal(`<div class="rating-box card"><h2>⭐ تم تقييم الخدمة</h2><p><b>${esc(o.service?.name || 'الخدمة')}</b> — ${esc(o.code)}</p><div class="rating-stars rating-stars-readonly">${[5, 4, 3, 2, 1].map(n => `<span class="rating-star ${n <= Number(existing.score) ? 'selected' : ''}">★</span>`).join('')}</div><p class="success">تم إرسال تقييمك مسبقًا.</p>${existing.comment ? `<p class="muted">${esc(existing.comment)}</p>` : ''}</div>`);
            return;
        }
        showModal(`<div class="rating-box card"><h2>⭐ قيّم مقدم الخدمة</h2><p class="muted">اختر عدد النجوم الذي يعبر عن تجربتك في ${esc(o.service?.name || 'الخدمة')}.</p><div class="rating-stars" id="ratingStars" role="radiogroup" aria-label="تقييم مقدم الخدمة">${[5, 4, 3, 2, 1].map(n => `<button type="button" class="rating-star" data-score="${n}" aria-label="${n} نجوم">★</button>`).join('')}</div><input type="hidden" id="score" value="5"><textarea id="comment" placeholder="تعليق اختياري"></textarea><button class="btn" id="rate" type="button">إرسال التقييم</button></div>`);
        const setScore = (score) => { const input = document.getElementById('score'); if (input)
            input.value = String(score); document.querySelectorAll('.rating-star').forEach(st => st.classList.toggle('selected', Number(st.dataset.score || 0) <= score)); };
        document.querySelectorAll('.rating-star').forEach(x => x.addEventListener('click', () => setScore(Number(x.dataset.score || 5))));
        setScore(5);
        document.getElementById('rate')?.addEventListener('click', async () => { const btn = document.getElementById('rate'); btn.disabled = true; try {
            await api('/orders/' + encodeURIComponent(id) + '/rating', { method: 'POST', body: JSON.stringify({ score: Number(document.getElementById('score').value), comment: document.getElementById('comment').value }) });
            showModal(`<div class="rating-box card"><h2>✓ شكرًا لك</h2><p class="success">تم إرسال تقييمك بنجاح.</p></div>`);
            await customer();
        }
        catch (e) {
            btn.disabled = false;
            alert(e.message);
        } });
    }
    catch (e) {
        alert(e.message);
    }
}
async function nativeShare(title, text, url) {
    try {
        if (navigator.share) {
            await navigator.share({ title, text, url });
            return true;
        }
        await navigator.clipboard?.writeText(url);
        alert('لا تتوفر نافذة المشاركة الأصلية هنا؛ تم نسخ الرابط.');
        return false;
    }
    catch (e) {
        if (e?.name === 'AbortError')
            return false;
        try {
            await navigator.clipboard?.writeText(url);
            alert('تم نسخ رابط المشاركة.');
        }
        catch { }
        return false;
    }
}
async function openOrder(id) {
    try {
        const j = await api('/orders/' + id);
        const o = j.order;
        const purchaseChanges = (o.service?.slug === 'purchase-and-delivery' || o.service?.slug === 'pharmacy-purchase') ? ((await api('/orders/' + encodeURIComponent(id) + '/purchase-change')).changes || []) : [];
        showModal(`<h2>${esc(o.code)}</h2><p><b>الخدمة:</b> ${esc(o.service.name)}</p><p><b>الحالة:</b> <span class="status">${esc(statusAr(o.status))}</span></p><p>${esc(o.description)}</p>${o.trip ? `<div class="trip-summary card"><b>🛵 تفاصيل المشوار</b><p>الغرض: ${esc(o.trip.purposeName)} · المسافة: ${esc(o.trip.distanceKm)} كم · الأجرة: ${esc(o.trip.fare)} ${esc(o.trip.currency)}</p><p class="muted">الوجهة: ${o.trip.destination ? esc(o.trip.destination.addressText || `${Number(o.trip.destination.lat).toFixed(6)} ، ${Number(o.trip.destination.lng).toFixed(6)}`) : 'لم تُحدد بعد — يمكن تحديدها لاحقًا'}</p></div>` : ''}<p class="muted">${esc(formatDateTime(o.createdAt))}</p>${o.provider ? `<div class="card" style="margin-top:12px"><div class="row" style="justify-content:space-between"><div><b>👤 ${esc(o.provider.displayName)}</b><p class="muted">⭐ ${esc(o.provider.rating)} · مقدم خدمة موثق</p></div><div class="row"><button class="btn secondary small" id="viewProviderProfile" type="button">عرض الملف</button><button class="btn secondary small" id="favoriteProviderBtn" type="button">⭐ حفظ كمفضل</button></div></div></div>` : ''}${o.provider && ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED'].includes(o.status) ? `<div class="row"><button class="btn secondary" id="openChatBtn" type="button">💬 محادثة مع مقدم الخدمة</button><button class="btn secondary" id="trackTripBtn" type="button">📍 تتبع الموقع</button><button class="btn secondary" id="shareTripBtn" type="button">🔗 مشاركة المشوار</button></div>` : ''}${o.pricingType === 'QUOTE' && ['SEARCHING', 'ASSIGNED'].includes(o.status) ? `<button class="btn" id="openQuotesBtn" type="button">💰 مشاهدة عروض الأسعار</button>` : ''}${purchaseChanges.some((c) => c.status === 'PENDING') ? `<div class="card"><b>🛒 تعديل مطلوب في الشراء</b>${purchaseChanges.filter((c) => c.status === 'PENDING').slice(0, 1).map((c) => `<p>السعر المقترح: <b>${esc(c.requestedPrice)}</b></p><p class="muted">${esc(c.requestedProduct || '')}${c.reason ? ' — ' + esc(c.reason) : ''}</p><div class="row"><button class="btn" id="approvePurchaseChange" type="button">موافقة</button><button class="btn danger secondary" id="rejectPurchaseChange" type="button">رفض</button></div>`).join('')}</div>` : ''}${o.service?.deliveryProofType === 'RECIPIENT_CONFIRMATION' && ['ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<div class="card"><b>👤 تأكيد الاستلام</b><p class="muted">أدخل اسم الشخص الذي استلم الخدمة ليتمكن مقدم الخدمة من إنهاء الطلب.</p><div class="row"><input id="customerRecipientConfirmName" maxlength="120" placeholder="اسم المستلم"><button class="btn" id="customerRecipientConfirmBtn" type="button">تأكيد الاستلام</button></div></div>` : ''}<div class="order-timeline">${(j.timeline || []).map((t) => `<div class="card"><b>${esc(t.title)}</b><small class="muted">${esc(formatDateTime(t.at))}</small><div>${esc(t.detail || '')}</div></div>`).join('')}</div><div class="card"><h3>تسلسل التوجيه</h3>${(j.assignments || []).map((a) => `<p><b>${esc(a.providerName)}</b> — ${esc(a.status)} · موجة ${esc(a.wave)} · ${a.distanceKm == null ? '' : esc(a.distanceKm) + ' كم'}</p>`).join('') || '<p class="muted">لا توجد عروض توجيه.</p>'}</div>${['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<button class="btn danger" id="cancel">إلغاء الطلب</button>` : ''}${['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED'].includes(o.status) ? `<button class="btn secondary" id="complaintBtn" type="button">⚠️ ${o.status === 'DISPUTED' ? 'متابعة الشكوى' : 'فتح شكوى'}</button>` : ''}${o.status === 'COMPLETED' ? `<div class="rating-box card"><h3>⭐ التقييم</h3><p class="muted">الخدمة مكتملة. افتح شاشة التقييم لإرسال نجومك وتعليقك.</p><button class="btn" id="openRatingBtn" type="button">⭐ تقييم مقدم الخدمة</button></div>` : ''}</div>`);
        document.getElementById('openChatBtn')?.addEventListener('click', () => openOrderChat(id));
        document.getElementById('trackTripBtn')?.addEventListener('click', () => openTripTracking(id));
        document.getElementById('shareTripBtn')?.addEventListener('click', async () => { try {
            const z = await api('/orders/' + encodeURIComponent(id) + '/share', { method: 'POST', body: '{}' });
            await nativeShare('مشاركة المشوار', `مشوار ${o.code} — حالة الطلب: ${statusAr(o.status)}`, new URL(z.url, location.origin).href);
        }
        catch (e) {
            alert(e.message);
        } });
        document.getElementById('openQuotesBtn')?.addEventListener('click', () => openOrderQuotes(id));
        document.getElementById('favoriteProviderBtn')?.addEventListener('click', async () => { try {
            await api('/me/favorites/providers/' + encodeURIComponent(o.provider.id), { method: 'POST', body: '{}' });
            alert('تم حفظ مقدم الخدمة في المفضلة');
        }
        catch (e) {
            alert(e.message);
        } });
        document.getElementById('viewProviderProfile')?.addEventListener('click', async () => { try {
            const pp = await api('/providers/' + encodeURIComponent(o.provider.id));
            const p = pp.provider;
            showModal(`<div class="card provider-public-profile">${p.avatarUrl ? `<img class="provider-profile-avatar" src="${esc(p.avatarUrl)}" alt="صورة ${esc(p.displayName)}">` : ''}<h2>${esc(p.displayName)}</h2><p>${esc(p.bio || 'مقدم خدمة موثق في منصة خدمات')}</p><p>⭐ ${esc(p.rating.avg)} (${esc(p.rating.count)} تقييم)</p><p>طلبات مكتملة: ${esc(p.completedOrders)}</p>${p.services?.length ? `<h3>الخدمات</h3><p>${p.services.map((x) => esc(x.name)).join(' · ')}</p>` : ''}</div>`);
        }
        catch (e) {
            alert(e.message);
        } });
        document.getElementById('cancel')?.addEventListener('click', async () => { if (!confirm('هل أنت متأكد من إلغاء هذا الطلب؟'))
            return; const btn = document.getElementById('cancel'); btn.disabled = true; btn.textContent = 'جارٍ الإلغاء...'; try {
            await api('/orders/' + id + '/cancel', { method: 'POST', body: JSON.stringify({ reason: 'إلغاء من العميل' }) });
            closeModal();
            await customer();
        }
        catch (e) {
            btn.disabled = false;
            btn.textContent = 'إلغاء الطلب';
            alert(e.message);
        } });
        document.getElementById('openRatingBtn')?.addEventListener('click', () => openRating(id));
        document.getElementById('complaintBtn')?.addEventListener('click', () => openOrderComplaint(id, o.status === 'DISPUTED'));
        document.getElementById('approvePurchaseChange')?.addEventListener('click', async () => { const c = purchaseChanges.find((x) => x.status === 'PENDING'); if (!c)
            return; try {
            await api('/orders/' + encodeURIComponent(id) + '/purchase-change/' + encodeURIComponent(c.id) + '/respond', { method: 'POST', body: JSON.stringify({ decision: 'APPROVE' }) });
            await openOrder(id);
        }
        catch (e) {
            alert(e.message);
        } });
        document.getElementById('rejectPurchaseChange')?.addEventListener('click', async () => { const c = purchaseChanges.find((x) => x.status === 'PENDING'); if (!c)
            return; try {
            await api('/orders/' + encodeURIComponent(id) + '/purchase-change/' + encodeURIComponent(c.id) + '/respond', { method: 'POST', body: JSON.stringify({ decision: 'REJECT' }) });
            await openOrder(id);
        }
        catch (e) {
            alert(e.message);
        } });
        document.getElementById('customerRecipientConfirmBtn')?.addEventListener('click', async () => { const name = document.getElementById('customerRecipientConfirmName').value.trim(); if (name.length < 2) {
            alert('أدخل اسم المستلم');
            return;
        } const b = document.getElementById('customerRecipientConfirmBtn'); b.disabled = true; try {
            await api('/orders/' + encodeURIComponent(id) + '/delivery-proof/recipient-confirm', { method: 'POST', body: JSON.stringify({ recipientName: name }) });
            await openOrder(id);
        }
        catch (e) {
            b.disabled = false;
            alert(e.message);
        } });
    }
    catch (e) {
        alert(e.message);
    }
}
async function openSavedLocations() {
    try {
        const j = await api('/me/addresses');
        const addresses = j.addresses || [];
        showModal(`<div class="service-picker-head"><div><h2>مواقعي المحفوظة</h2><p class="muted">احفظ مواقعك المتكررة لتختارها مباشرة عند طلب أي خدمة.</p></div><button class="btn" id="addAddress" type="button">+ إضافة موقع</button></div><div id="addressList">${addresses.length ? addresses.map((a) => `<div class="card" style="margin-top:10px"><div class="row" style="justify-content:space-between"><div><b>📍 ${esc(a.label)}</b>${a.isDefault ? ' <span class="status">افتراضي</span>' : ''}<p class="muted">${Number(a.location.lat).toFixed(6)} — ${Number(a.location.lng).toFixed(6)}</p>${a.location.areaName ? `<small class="muted">${esc(a.location.areaName)}</small>` : ''}</div><div class="row"><button class="btn secondary small" data-edit-address="${esc(a.id)}" type="button">تعديل</button><button class="btn secondary small" data-default-address="${esc(a.id)}" type="button">${a.isDefault ? 'الافتراضي' : 'تعيين افتراضي'}</button><button class="btn secondary small" data-delete-address="${esc(a.id)}" type="button">حذف</button></div></div></div>`).join('') : '<div class="card empty">لا توجد مواقع محفوظة بعد.</div>'}</div>`);
        document.getElementById('addAddress').onclick = () => addSavedAddress();
        document.querySelectorAll('[data-delete-address]').forEach(x => x.addEventListener('click', async () => { if (!confirm('هل تريد حذف هذا الموقع؟'))
            return; try {
            await api('/me/addresses/' + encodeURIComponent(x.dataset.deleteAddress), { method: 'DELETE' });
            await openSavedLocations();
        }
        catch (e) {
            alert(e.message);
        } }));
        document.querySelectorAll('[data-edit-address]').forEach(x => x.addEventListener('click', () => { const id = x.dataset.editAddress; const a = addresses.find((z) => z.id === id); if (a)
            editSavedAddress(a); }));
        document.querySelectorAll('[data-default-address]').forEach(x => x.addEventListener('click', async () => { const id = x.dataset.defaultAddress; try {
            await api('/me/addresses/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
            await openSavedLocations();
        }
        catch (e) {
            alert(e.message);
        } }));
    }
    catch (e) {
        alert(e.message);
    }
}
async function editSavedAddress(a) {
    showModal(`<h2>تعديل الموقع المحفوظ</h2><form id="editAddressForm"><div class="field"><label>اسم الموقع</label><input name="label" maxlength="40" required value="${esc(a.label)}"></div><div class="field"><label>الموقع الحالي</label><p class="muted">${Number(a.location.lat).toFixed(6)} — ${Number(a.location.lng).toFixed(6)}</p><button class="btn secondary" id="editAddressGps" type="button">📍 إعادة تحديد الموقع من GPS</button><p id="editAddressGpsStatus" class="muted">سيبقى الموقع الحالي إذا لم تعِد تحديده.</p><input name="lat" id="editAddressLat" type="hidden"><input name="lng" id="editAddressLng" type="hidden"><input name="accuracy" id="editAddressAccuracy" type="hidden"></div><button class="btn">حفظ التعديل</button><p id="editAddressMsg"></p></form>`);
    document.getElementById('editAddressGps').onclick = () => { const btn = document.getElementById('editAddressGps'), st = document.getElementById('editAddressGpsStatus'), la = document.getElementById('editAddressLat'), ln = document.getElementById('editAddressLng'), ac = document.getElementById('editAddressAccuracy'); if (!navigator.geolocation) {
        st.textContent = 'المتصفح لا يدعم تحديد الموقع';
        st.className = 'error';
        return;
    } btn.disabled = true; st.textContent = 'جارٍ تحديد أفضل موقع...'; let best = null; let watch; const started = Date.now(); const finish = () => { if (watch !== undefined)
        navigator.geolocation.clearWatch(watch); btn.disabled = false; if (!best) {
        st.textContent = 'تعذر تحديد الموقع';
        st.className = 'error';
        return;
    } la.value = String(best.coords.latitude); ln.value = String(best.coords.longitude); ac.value = String(best.coords.accuracy); st.textContent = `تم تحديد موقع جديد بدقة تقريبية ${Math.round(best.coords.accuracy)} متر`; st.className = best.coords.accuracy <= 1000 ? 'success' : 'error'; }; watch = navigator.geolocation.watchPosition(pos => { if (!best || pos.coords.accuracy < best.coords.accuracy)
        best = pos; if (best.coords.accuracy <= 100 || Date.now() - started > 45000)
        finish(); }, () => { if (Date.now() - started > 45000)
        finish(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }); window.setTimeout(finish, 60000); };
    document.getElementById('editAddressForm').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const msg = document.getElementById('editAddressMsg'); const lat = f.get('lat'), lng = f.get('lng'), accuracy = f.get('accuracy'); const body = { label: String(f.get('label')) }; if (lat && lng && accuracy) {
        const nlat = Number(lat), nlng = Number(lng), nac = Number(accuracy);
        if (!Number.isFinite(nlat) || !Number.isFinite(nlng) || !Number.isFinite(nac) || nac > 1000) {
            msg.textContent = 'دقة الموقع الجديد ضعيفة، أعد المحاولة';
            msg.className = 'error';
            return;
        }
        body.location = { lat: nlat, lng: nlng, accuracy: nac, source: 'gps' };
    } try {
        await api('/me/addresses/' + encodeURIComponent(a.id), { method: 'PATCH', body: JSON.stringify(body) });
        await openSavedLocations();
    }
    catch (e) {
        msg.textContent = e.message;
        msg.className = 'error';
    } });
}
async function addSavedAddress() {
    showModal(`<h2>إضافة موقع محفوظ</h2><form id="addressForm"><div class="field"><label>اسم الموقع</label><input name="label" required maxlength="40" placeholder="البيت أو العمل أو المزرعة"></div><div class="field"><label>الموقع</label><button class="btn secondary" id="captureAddressGps" type="button">📍 تحديد الموقع من GPS</button><p id="addressGpsStatus" class="muted">لم يتم تحديد الموقع بعد</p><input name="lat" id="addressLat" type="hidden"><input name="lng" id="addressLng" type="hidden"><input name="accuracy" id="addressAccuracy" type="hidden"></div><button class="btn">حفظ الموقع</button><p id="addressMsg"></p></form>`);
    document.getElementById('captureAddressGps').onclick = () => { const btn = document.getElementById('captureAddressGps'), st = document.getElementById('addressGpsStatus'), la = document.getElementById('addressLat'), ln = document.getElementById('addressLng'), ac = document.getElementById('addressAccuracy'); if (!navigator.geolocation) {
        st.textContent = 'المتصفح لا يدعم تحديد الموقع';
        st.className = 'error';
        return;
    } btn.disabled = true; st.textContent = 'جارٍ تحديد الموقع...'; navigator.geolocation.getCurrentPosition(pos => { la.value = String(pos.coords.latitude); ln.value = String(pos.coords.longitude); ac.value = String(pos.coords.accuracy); st.textContent = `تم تحديد الموقع بدقة تقريبية ${Math.round(pos.coords.accuracy)} متر`; st.className = pos.coords.accuracy <= 1000 ? 'success' : 'error'; btn.disabled = false; }, () => { st.textContent = 'تعذر تحديد الموقع. فعّل GPS/الموقع وحاول مرة أخرى.'; st.className = 'error'; btn.disabled = false; }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }); };
    document.getElementById('addressForm').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const lat = Number(f.get('lat')), lng = Number(f.get('lng')), accuracy = Number(f.get('accuracy')); const msg = document.getElementById('addressMsg'); if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy)) {
        msg.textContent = 'حدد الموقع من GPS أولًا';
        msg.className = 'error';
        return;
    } if (accuracy > 1000) {
        msg.textContent = 'دقة الموقع ضعيفة، أعد المحاولة من مكان مفتوح';
        msg.className = 'error';
        return;
    } try {
        await api('/me/addresses', { method: 'POST', body: JSON.stringify({ label: String(f.get('label')), location: { lat, lng, accuracy, source: 'gps' }, isDefault: false }) });
        await openSavedLocations();
    }
    catch (x) {
        msg.textContent = x.message;
        msg.className = 'error';
    } });
}
async function openOrderComplaint(orderId, followExisting = false) {
    try {
        const j = await api('/orders/' + encodeURIComponent(orderId) + '/complaint');
        const c = j.complaint;
        const msgs = j.messages || [];
        if (c) {
            const roleMap = { CUSTOMER: 'العميل', PROVIDER: 'مقدم الخدمة', ADMIN: 'الإدارة' };
            const renderThread = (items) => { const box = document.getElementById('customerComplaintThread'); if (!box)
                return; box.innerHTML = items.map((m) => `<div class="chat-bubble ${m.authorId === state.user?.id ? 'mine' : 'theirs'}"><div class="chat-meta"><b>${esc(roleMap[m.authorRole] || m.authorRole)}</b><small>${esc(formatDateTime(m.createdAt))}</small></div><p>${esc(m.body)}</p></div>`).join('') || '<p class="muted">لا توجد ردود بعد.</p>'; box.scrollTop = box.scrollHeight; };
            showModal(`<div class="complaint-modal" data-complaint-id="${esc(c.id)}"><div class="chat-header"><div><h2>💬 محادثة الدعم ${esc(c.code)}</h2><p class="muted">هذه المحادثة مرتبطة بالشكوى والطلب نفسه وتُحدّث مباشرة.</p></div><span class="chat-live-badge">● مباشر</span></div><div class="card"><b>وصف الشكوى</b><p>${esc(c.description)}</p></div><div id="customerComplaintThread" class="chat-messages complaint-thread"></div>${!['RESOLVED', 'REJECTED', 'CLOSED'].includes(c.status) ? `<form id="complaintReplyForm" class="chat-form"><textarea name="body" minlength="1" maxlength="1000" required placeholder="اكتب ردك..."> </textarea><button class="btn">إرسال</button></form>` : `<div class="notice success">تم إنهاء هذه الشكوى.</div>`}</div>`);
            renderThread(msgs);
            document.getElementById('complaintReplyForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const form = e.currentTarget; const btn = form.querySelector('button'); const body = String(new FormData(form).get('body') || '').trim(); if (!body)
                return; btn.disabled = true; try {
                await api('/complaints/' + encodeURIComponent(c.id) + '/reply', { method: 'POST', headers: { 'Idempotency-Key': newIdempotencyKey() }, body: JSON.stringify({ body }) });
                const latest = await api('/complaints/' + encodeURIComponent(c.id));
                renderThread(latest.messages || []);
                form.querySelector('textarea').value = '';
            }
            catch (e) {
                alert(e.message);
            }
            finally {
                btn.disabled = false;
            } });
            const onComplaint = async (ev) => { const d = ev.detail; if (d?.complaintId === c.id) {
                const latest = await api('/complaints/' + encodeURIComponent(c.id));
                renderThread(latest.messages || []);
            } };
            window.addEventListener('khadamat:complaint-message', onComplaint);
            const timer = window.setInterval(async () => { if (!document.querySelector('.complaint-modal')) {
                clearInterval(timer);
                window.removeEventListener('khadamat:complaint-message', onComplaint);
                return;
            } try {
                const latest = await api('/complaints/' + encodeURIComponent(c.id));
                renderThread(latest.messages || []);
            }
            catch { } }, 5000);
            return;
        }
        if (followExisting)
            return;
        showModal(`<h2>فتح شكوى</h2><p class="muted">استخدم الشكوى فقط عند وجود مشكلة فعلية في تنفيذ الطلب.</p><form id="newComplaintForm"><div class="field"><label>نوع المشكلة</label><select name="category"><option value="QUALITY">جودة الخدمة</option><option value="BEHAVIOR">التعامل</option><option value="PRICE">السعر</option><option value="NO_SHOW">لم يحضر مقدم الخدمة</option><option value="DAMAGE">ضرر</option><option value="OTHER">أخرى</option></select></div><div class="field"><label>وصف المشكلة</label><textarea name="description" minlength="5" maxlength="1000" required></textarea></div><button class="btn">إرسال الشكوى</button></form>`);
        document.getElementById('newComplaintForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const b = e.currentTarget.querySelector('button'); b.disabled = true; try {
            await api('/orders/' + encodeURIComponent(orderId) + '/complaints', { method: 'POST', body: JSON.stringify({ category: String(f.get('category')), description: String(f.get('description')) }) });
            await openOrderComplaint(orderId, true);
        }
        catch (e) {
            b.disabled = false;
            alert(e.message);
        } });
    }
    catch (e) {
        alert(e.message);
    }
}
function showModal(html) { closeModal(); const d = document.createElement('div'); d.id = 'modal'; d.className = 'modal'; d.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><span></span><button class="btn secondary small" id="close">إغلاق</button></div>${html}</div>`; document.body.appendChild(d); applyFieldPlaceholders(d); document.getElementById('close').onclick = closeModal; }
function closeModal() { if (notificationModalTimer) {
    clearInterval(notificationModalTimer);
    notificationModalTimer = undefined;
} notificationModalRefreshing = false; document.getElementById('modal')?.remove(); }
async function openProviderQuote(orderId) {
    showModal(`<h2>تقديم عرض سعر</h2><p class="muted">أدخل السعر الذي ستنفذ به الخدمة. يمكن للعميل مقارنة العروض واختيار أحدها.</p><form id="quoteForm"><div class="field"><label>السعر</label><input id="quoteAmount" type="number" min="0" step="1" required></div><div class="field"><label>ملاحظة</label><textarea id="quoteMessage" maxlength="500" placeholder="ما الذي يشمله السعر؟"></textarea></div><div class="field"><label>صلاحية العرض بالساعات</label><input id="quoteHours" type="number" min="1" max="720" value="24"></div><button class="btn" id="sendQuote">إرسال العرض</button></form>`);
    document.getElementById('quoteForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const b = document.getElementById('sendQuote'); b.disabled = true; try {
        await api('/provider/orders/' + encodeURIComponent(orderId) + '/quote', { method: 'POST', body: JSON.stringify({ amount: Number(document.getElementById('quoteAmount').value), message: document.getElementById('quoteMessage').value, validHours: Number(document.getElementById('quoteHours').value) }) });
        closeModal();
        await provider();
    }
    catch (x) {
        b.disabled = false;
        alert(x.message);
    } });
}
function startProviderPresenceHeartbeat(online) { if (providerHeartbeatTimer !== undefined) {
    clearInterval(providerHeartbeatTimer);
    providerHeartbeatTimer = undefined;
} if (!online || !state.token)
    return; const beat = () => { api('/provider/presence-heartbeat', { method: 'POST', body: '{}' }).catch(() => { }); }; beat(); providerHeartbeatTimer = window.setInterval(beat, 30000); }
function startProviderLocationTracking(online) { if (providerLocationWatch !== undefined) {
    navigator.geolocation?.clearWatch(providerLocationWatch);
    providerLocationWatch = undefined;
} if (!online || !navigator.geolocation || !state.token)
    return; providerLocationWatch = navigator.geolocation.watchPosition(async (pos) => { const now = Date.now(); if (now - providerLocationLastSent < 4000)
    return; providerLocationLastSent = now; try {
    await api('/provider/live-location', { method: 'POST', body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, heading: Number.isFinite(pos.coords.heading ?? NaN) ? pos.coords.heading : undefined, speedMps: Number.isFinite(pos.coords.speed ?? NaN) ? pos.coords.speed : undefined }) });
}
catch { } }, () => { }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }); }
async function provider() {
    if (!state.user) {
        authBox('PROVIDER');
        return;
    }
    if (state.user.role !== 'PROVIDER') {
        redirectToRole(state.user.role);
        return;
    }
    try {
        const [p, o, e, catalogPayload, offers, dashboard, providerNotifications] = await Promise.all([api('/provider/profile'), api('/provider/orders'), api('/provider/earnings'), api('/catalog/bootstrap'), api('/provider/offers'), api('/provider/dashboard').catch(() => ({})), api('/notifications?limit=5').catch(() => ({ notifications: [] }))]);
        const allServices = (catalogPayload.services || []).map((svc) => ({ ...svc, categoryName: catalogPayload.categories?.find((c) => c.id === svc.categoryId)?.name || '', categoryIcon: catalogPayload.categories?.find((c) => c.id === svc.categoryId)?.icon || '' }));
        const selected = new Set((p.provider.services || []).map((s) => s.serviceId));
        shell(`<div class="hero provider-hero"><div class="provider-hero-head">${p.provider.avatarUrl ? `<img class="provider-avatar" src="${esc(p.provider.avatarUrl)}" alt="صورة مقدم الخدمة">` : '<div class="provider-avatar provider-avatar-empty">👤</div>'}<div><h1>لوحة مقدم الخدمة</h1><p>${esc(p.provider.displayName)} — ${esc(verifyAr(p.provider.verificationStatus))}</p></div></div><div class="row"><span class="status" id="providerConnectionStatus">${p.provider.isOnline ? '🟢 متصل' : '⚪ غير متصل'}</span><span class="status" id="providerAcceptingStatus">${p.provider.acceptingOrders ? 'يستقبل الطلبات' : 'لا يستقبل الطلبات'}</span><button class="btn" id="online" type="button">${p.provider.isOnline ? 'قطع الاتصال' : 'بدء الاتصال'}</button><button class="btn secondary" id="acceptingOrders" type="button" ${p.provider.isOnline ? '' : 'disabled'}>${p.provider.acceptingOrders ? 'إيقاف استقبال الطلبات' : 'بدء استقبال الطلبات'}</button>${p.provider.verificationStatus !== 'VERIFIED' ? '<button class="btn secondary" id="goVerification" type="button">🔐 توثيق الحساب</button>' : ''}</div>${p.provider.verificationStatus !== 'VERIFIED' ? '<div class="notice" style="margin-top:12px">لا يمكنك استقبال الطلبات قبل اعتماد الهوية والترخيص من الإدارة. ارفع الوثيقتين من قسم «توثيق الحساب» ثم انتظر المراجعة.</div>' : ''}</div>
      <div id="providerPriority" class="priority-stack"></div><div class="provider-command-strip"><div><b>مركز عملك</b><small>${dashboard.current?.length ? `لديك ${dashboard.current.length} طلب${dashboard.current.length === 1 ? ' حالي' : 'ات حالية'}` : 'لا توجد طلبات قيد التنفيذ'}</small></div><div><b>${esc(dashboard.pendingOffers || 0)}</b><small>طلبات جديدة</small></div><div><b>${esc(dashboard.unreadNotifications || 0)}</b><small>إشعارات</small></div><div><b>${esc(dashboard.commissionDue || 0)} ${esc(dashboard.currency || e.currency)}</b><small>عمولة مستحقة</small></div></div>
      <div class="card provider-notification-workspace"><div class="row" style="justify-content:space-between"><div><h2>🔔 متابعات وإشعارات الطلبات</h2><p class="muted">كل طلب جديد أو رسالة جديدة تظهر هنا. اضغط على الرسالة لفتح الطلب والمحادثة مباشرة.</p></div><button class="btn secondary small" id="providerOpenAllNotifications" type="button">كل الإشعارات</button></div><div id="providerNotificationPanel"></div></div>
      <div class="grid"><div class="card"><div class="stat">${esc(e.completedOrders)}</div><div>طلبات مكتملة</div></div><div class="card"><div class="stat">${esc(e.net)} ${esc(e.currency)}</div><div>صافي تقديري</div></div><div class="card"><div class="stat">${esc(e.pendingOrders)}</div><div>طلبات قيد التنفيذ</div></div></div>
      <div class="card"><div class="row" style="justify-content:space-between"><div><h2>خدماتي</h2><p class="muted">هذه هي الخدمات التي اخترتها لتقديمها للعملاء.</p></div><button class="btn secondary" id="editServices" type="button">${selected.size ? 'إضافة أو تعديل الخدمات' : 'اختيار الخدمات'}</button></div>
      <div id="myServicesList" class="grid provider-services">${selected.size ? allServices.filter((s) => selected.has(s.id)).map((s) => `<div class="card service-check"><span class="icon">${esc(s.icon || s.categoryIcon || '🛠️')}</span><span><b>${esc(s.name)}</b><small class="muted">${esc(s.categoryName || '')}</small></span></div>`).join('') : '<div class="notice">لم تختر أي خدمة بعد. اختر الخدمات التي تستطيع تنفيذها فعليًا.</div>'}</div>
      <div id="servicesEditor" style="display:none;margin-top:14px"><div class="grid provider-services">${allServices.map((s) => `<label class="card service-check"><input type="checkbox" data-service-check="${esc(s.id)}" ${selected.has(s.id) ? 'checked' : ''}> <span class="icon">${esc(s.icon || s.categoryIcon || '🛠️')}</span><span><b>${esc(s.name)}</b><small class="muted">${esc(s.categoryName || '')}</small></span></label>`).join('')}</div><div class="row" style="margin-top:12px"><button class="btn" id="saveServices" type="button">حفظ الخدمات</button><button class="btn secondary" id="cancelServicesEdit" type="button">إلغاء</button></div></div><p id="servicesMsg" class="muted"></p></div>
      <div class="card" id="verificationCard"><div class="row" style="justify-content:space-between"><div><h2>توثيق الحساب</h2><p class="muted">ارفع الهوية والترخيص. بعد اختيار الملف ستظهر لك معاينة بسيطة، ولن يُرسل للمراجعة حتى تضغط «رفع وإرسال للمراجعة».</p></div><span class="status">${esc(verifyAr(p.provider.verificationStatus))}</span></div><div id="providerDocs"></div><div class="row" style="margin-top:12px"><label class="btn secondary" for="docId">${p.documents?.find((d) => d.docType === 'ID') ? 'استبدال الهوية' : 'رفع الهوية'}</label><input id="docId" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden><label class="btn secondary" for="docLicense">${p.documents?.find((d) => d.docType === 'LICENSE') ? 'استبدال الترخيص' : 'رفع الترخيص'}</label><input id="docLicense" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></div><div id="pendingDoc" class="notice" style="display:none;margin-top:12px"></div><p id="docMsg" class="muted"></p></div>
    <div class="card"><div class="row" style="justify-content:space-between"><div><h2>موقع تقديم الخدمة</h2><p id="providerLocationText" class="muted">${p.provider.baseLocation ? `محفوظ: ${Number(p.provider.baseLocation.lat).toFixed(6)} ، ${Number(p.provider.baseLocation.lng).toFixed(6)}` : 'لم يتم تحديد موقع أساسي بعد'}</p></div><button class="btn secondary" id="setProviderLocation">📍 تحديد موقعي</button></div><p id="providerLocationMsg" class="muted"></p><p class="muted">يساعد الموقع في ترتيب طلبات البنشر والصيانة القريبة منك.</p></div>
      <div class="card"><h2>التشغيل المتقدم</h2><p class="muted">حدد المناطق وأوقات العمل حتى يعرف النظام أين ومتى يستطيع إسناد الطلبات إليك.</p><div class="row"><button class="btn secondary" id="editProviderAreas" type="button">المناطق</button><button class="btn secondary" id="editProviderAvailability" type="button">أوقات العمل</button></div></div>
      <h2>طلبات جديدة</h2><p class="muted">يمكنك قبول الطلب مباشرة، أو تقديم عرض سعر إذا كان السعر يحتاج اتفاقًا مع العميل، أو رفض الطلب.</p><div id="offers"></div><h2>طلباتي</h2><div id="myorders">${(o.orders || []).map(providerOrder).join('') || '<div class="card muted">لا توجد طلبات</div>'}</div>`);
        const providerNotificationPanel = document.getElementById('providerNotificationPanel');
        const providerNs = providerNotifications.notifications || [];
        if (providerNotificationPanel) {
            const unreadTotal = Number(providerNotifications.unreadCount || 0);
            const recent = providerNs.slice(0, 5);
            const groups = [{ key: 'CHAT_MESSAGE', label: 'رسائل المحادثات', icon: '💬' }, { key: 'NEW_OFFER', label: 'طلبات جديدة', icon: '📦' }, { key: 'ORDER_ACCEPTED', label: 'تحديثات الطلبات', icon: '🔄' }];
            const counts = groups.map(g => ({ ...g, count: recent.filter((n) => n.type === g.key).length }));
            const latest = recent[0];
            providerNotificationPanel.innerHTML = `<div class="provider-notification-summary"><div class="provider-notification-count"><span class="notification-dot ${unreadTotal ? 'unread' : ''}"></span><div><b>${unreadTotal ? `لديك ${unreadTotal} إشعار${unreadTotal === 1 ? '' : 'ات'} غير مقروء` : 'لا توجد إشعارات غير مقروءة'}</b><small class="muted">التفاصيل الكاملة متاحة عبر «مشاهدة الإشعارات».</small></div></div><div class="provider-notification-stats">${counts.map(g => `<span class="status notification-stat">${g.icon} ${esc(g.label)}${g.count ? ` · ${g.count}` : ''}</span>`).join('')}</div>${latest ? `<div class="provider-notification-latest"><span>آخر تحديث</span><b>${esc(latest.title || latest.body || 'إشعار جديد')}</b><small class="muted">${esc(formatDateTime(latest.createdAt))}</small></div>` : ''}<button class="btn secondary small" id="providerOpenAllNotificationsInline" type="button">مشاهدة الإشعارات${unreadTotal ? ` (${unreadTotal})` : ''}</button></div>`;
        }
        document.getElementById('providerOpenAllNotifications')?.addEventListener('click', () => openNotifications());
        document.getElementById('providerOpenAllNotificationsInline')?.addEventListener('click', () => openNotifications());
        const priority = document.getElementById('providerPriority');
        const pendingOffers = offers.offers || [];
        if (priority) {
            if (pendingOffers.length) {
                priority.innerHTML = `<div class="priority-card priority-primary"><div class="priority-icon">🔔</div><div class="priority-body"><b>عندك ${pendingOffers.length} ${pendingOffers.length === 1 ? 'طلب جديد يحتاج ردك' : 'طلبات جديدة تحتاج ردك'}</b><p>راجع الطلب واختر «قبول مباشرة» أو «تقديم عرض سعر» أو «رفض». لا تحتاج تبحث عنها في الصفحة.</p></div><button class="btn" id="focusOffers" type="button">فتح الطلبات الجديدة</button></div>`;
                document.getElementById('focusOffers')?.addEventListener('click', () => document.getElementById('offers')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            }
            else if (p.provider.verificationStatus !== 'VERIFIED') {
                priority.innerHTML = `<div class="priority-card priority-warning"><div class="priority-icon">🔐</div><div class="priority-body"><b>خطوتك المهمة الآن: توثيق الحساب</b><p>ارفع الهوية والترخيص ثم أرسلهما للمراجعة. بعد اعتماد الإدارة يمكنك بدء استقبال الطلبات.</p></div><button class="btn" id="focusVerification" type="button">ابدأ التوثيق</button></div>`;
                document.getElementById('focusVerification')?.addEventListener('click', () => document.getElementById('verificationCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            }
        }
        document.getElementById('offers').innerHTML = uniqueBy((offers.offers || []), (x) => String(x.orderId)).map((x) => `<div class="card offer-card" data-offer-expiry="${esc(x.expiresAt)}"><div class="row"><b>${esc(x.orderCode)}</b><span class="status">${esc(x.priority)}</span></div><p>${esc(x.serviceName)}</p><p class="muted">${esc(x.areaName || 'الموقع غير مصنف')} · ${esc(x.distanceKm)} كم</p><p><b class="offer-countdown" data-expires="${esc(x.expiresAt)}">جاري حساب المهلة...</b></p>${x.pricingType === 'QUOTE' ? (x.quoteStatus === 'SUBMITTED' ? `<div class="quote-submitted"><b>✓ تم تقديم عرض السعر</b>${x.quoteAmount != null ? `<span>${esc(x.quoteAmount)} ريال</span>` : ''}</div>` : `<div class="row" style="margin-top:10px"><button class="btn" data-accept="${esc(x.id)}">✓ قبول الطلب مباشرة</button><button class="btn secondary" data-quote-offer="${esc(x.orderId)}">💰 تقديم عرض سعر</button></div>`) : `<button class="btn" data-accept="${esc(x.id)}">✓ قبول الطلب</button>`} <button class="btn secondary" data-reject="${esc(x.id)}">رفض</button></div>`).join('') || '<div class="card muted">لا توجد عروض حاليًا</div>';
        bindProviderLiveActions();
        startOfferCountdowns();
        startProviderPresenceHeartbeat(!!p.provider.isOnline);
        startProviderLocationTracking(!!p.provider.isOnline);
        document.getElementById('goVerification')?.addEventListener('click', () => document.getElementById('verificationCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        document.getElementById('editProviderAreas')?.addEventListener('click', () => openProviderAreas(p.provider));
        document.getElementById('editProviderAvailability')?.addEventListener('click', () => openProviderAvailability(p.provider));
        document.getElementById('online').onclick = async () => { const btn = document.getElementById('online'); btn.disabled = true; try {
            await api('/provider/online', { method: 'POST', body: JSON.stringify({ online: !p.provider.isOnline }) });
            await provider();
        }
        catch (e) {
            btn.disabled = false;
            alert(e.message);
        } };
        document.getElementById('acceptingOrders').onclick = async () => { const btn = document.getElementById('acceptingOrders'); btn.disabled = true; try {
            await api('/provider/accepting-orders', { method: 'POST', body: JSON.stringify({ accepting: !p.provider.acceptingOrders }) });
            await provider();
        }
        catch (e) {
            btn.disabled = false;
            alert(e.message);
        } };
        document.getElementById('editServices').onclick = () => { const ed = document.getElementById('servicesEditor'); ed.style.display = ed.style.display === 'none' ? 'block' : 'none'; };
        document.getElementById('cancelServicesEdit').onclick = () => { document.getElementById('servicesEditor').style.display = 'none'; };
        document.getElementById('saveServices').onclick = async () => { const btn = document.getElementById('saveServices'); const msg = document.getElementById('servicesMsg'); const services = Array.from(document.querySelectorAll('[data-service-check]:checked')).map(x => ({ serviceId: x.dataset.serviceCheck, experienceYears: 0 })); if (!services.length) {
            msg.textContent = 'اختر خدمة واحدة على الأقل حتى يستطيع النظام إسناد الطلبات إليك.';
            msg.className = 'error';
            return;
        } btn.disabled = true; msg.textContent = 'جارٍ حفظ الخدمات...'; try {
            await api('/provider/services', { method: 'PUT', body: JSON.stringify({ services }) });
            await provider();
            const savedMsg = document.getElementById('servicesMsg');
            if (savedMsg) {
                savedMsg.textContent = 'تم حفظ خدماتك بنجاح. تظهر الآن الخدمات التي اخترتها فقط.';
                savedMsg.className = 'muted';
            }
        }
        catch (e) {
            msg.textContent = e.message;
            msg.className = 'error';
            btn.disabled = false;
        } };
        const renderDocs = () => { const docs = p.documents || []; const el = document.getElementById('providerDocs'); const card = (type, empty) => { const d = docs.find((x) => x.docType === type); return d ? `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(docTypeAr(d.docType))}</b><div class="muted">الحالة: ${esc(docStatusAr(d.status))}</div>${d.fileName ? `<div class="muted">${esc(d.fileName)} — ${Math.max(1, Math.round(d.fileSize / 1024))} KB</div>` : ''}${d.note ? `<div class="error" style="margin-top:6px">ملاحظة المراجعة: ${esc(d.note)}</div>` : ''}</div>${d.fileUrl ? `<button class="btn secondary small" type="button" data-view-file="${esc(d.fileUrl)}">عرض الملف</button>` : ''}</div></div>` : `<div class="card"><b>${empty}</b><div class="muted">لم يتم رفع هذه الوثيقة بعد.</div></div>`; }; el.innerHTML = card('ID', 'الهوية') + card('LICENSE', 'الترخيص'); };
        renderDocs();
        document.querySelectorAll('[data-view-file]').forEach(x => x.addEventListener('click', () => openPrivateFile(x.dataset.viewFile)));
        let pending = null;
        const showPending = () => { const box = document.getElementById('pendingDoc'); if (!pending) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        } box.style.display = 'block'; box.innerHTML = `<b>ملف جاهز للإرسال: ${esc(pending.file.name)}</b><div class="muted">${Math.max(1, Math.round(pending.file.size / 1024))} KB — لم يُرسل بعد</div><div class="row" style="margin-top:10px"><button class="btn" id="confirmDoc" type="button">رفع وإرسال للمراجعة</button><button class="btn secondary" id="cancelDoc" type="button">إلغاء</button></div>`; document.getElementById('cancelDoc').onclick = () => { pending = null; showPending(); }; document.getElementById('confirmDoc').onclick = () => uploadDoc(pending.docType, pending.file); };
        const uploadDoc = async (docType, file) => { const msg = document.getElementById('docMsg'); if (file.size > 5 * 1024 * 1024) {
            msg.textContent = 'حجم الملف يتجاوز 5MB.';
            msg.className = 'error';
            pending = null;
            showPending();
            return;
        } const current = pending; pending = null; showPending(); msg.textContent = 'جارٍ رفع الوثيقة وإرسالها للمراجعة...'; msg.className = 'muted'; try {
            const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة الملف')); fr.readAsDataURL(file); });
            const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'provider_document', name: file.name, dataBase64: data }) });
            await api('/provider/documents', { method: 'POST', body: JSON.stringify({ docType, fileId: up.file.id }) });
            msg.textContent = `تم حفظ ${docTypeAr(docType)} وإرسالها للمراجعة.`;
            msg.className = 'muted';
            const fresh = await api('/provider/profile');
            p.documents = fresh.documents || [];
            renderDocs();
        }
        catch (e) {
            msg.textContent = e.message;
            msg.className = 'error';
            pending = current;
            showPending();
        } };
        const chooseDoc = (inputId, docType) => { const input = document.getElementById(inputId); const file = input.files?.[0]; if (!file)
            return; pending = { docType, file }; input.value = ''; showPending(); };
        document.getElementById('docId').addEventListener('change', () => chooseDoc('docId', 'ID'));
        document.getElementById('docLicense').addEventListener('change', () => chooseDoc('docLicense', 'LICENSE'));
        document.getElementById('setProviderLocation').onclick = () => setProviderLocation();
        stopPollers();
        providerPollTimer = window.setInterval(async () => { try {
            const [pp, oo, offers] = await Promise.all([api('/provider/profile'), api('/provider/orders'), api('/provider/offers')]);
            const currentOfferIds = new Set((offers.offers || []).map((x) => String(x.id || '')));
            const addedOffers = [...currentOfferIds].filter(id => id && !lastProviderOfferIds.has(id));
            if (addedOffers.length) {
                toast('طلب جديد', addedOffers.length === 1 ? 'لديك طلب جديد يحتاج ردك' : `لديك ${addedOffers.length} طلبات جديدة تحتاج ردك`);
                refreshNotificationBadge().catch(() => { });
            }
            lastProviderOfferIds = currentOfferIds;
            const onlineBtn = document.getElementById('online');
            const topStatus = document.querySelector('.hero .status');
            const connStatus = document.getElementById('providerConnectionStatus');
            if (connStatus)
                connStatus.textContent = pp.provider.isOnline ? '🟢 متصل' : '⚪ غير متصل';
            const acceptingStatus = document.getElementById('providerAcceptingStatus');
            if (acceptingStatus)
                acceptingStatus.textContent = pp.provider.acceptingOrders ? 'يستقبل الطلبات' : 'لا يستقبل الطلبات';
            if (onlineBtn) {
                onlineBtn.textContent = pp.provider.isOnline ? 'قطع الاتصال' : 'بدء الاتصال';
                onlineBtn.disabled = false;
            }
            const acceptingBtn = document.getElementById('acceptingOrders');
            if (acceptingBtn) {
                acceptingBtn.textContent = pp.provider.acceptingOrders ? 'إيقاف استقبال الطلبات' : 'بدء استقبال الطلبات';
                acceptingBtn.disabled = !pp.provider.isOnline;
            }
            const off = document.getElementById('offers');
            if (off) {
                off.innerHTML = uniqueBy((offers.offers || []), (x) => String(x.orderId)).map((x) => `<div class="card"><div class="row"><b>${esc(x.orderCode)}</b><span class="status">${esc(x.priority)}</span></div><p>${esc(x.serviceName)}</p><p class="muted">${esc(x.areaName || 'الموقع غير مصنف')} · ${esc(x.distanceKm)} كم</p><p><b class="offer-countdown" data-expires="${esc(x.expiresAt)}">جاري حساب المهلة...</b></p>${x.pricingType === 'QUOTE' ? (x.quoteStatus === 'SUBMITTED' ? `<div class="quote-submitted"><b>✓ تم تقديم عرض السعر</b>${x.quoteAmount != null ? `<span>${esc(x.quoteAmount)} ريال</span>` : ''}</div>` : `<div class="row" style="margin-top:10px"><button class="btn" data-accept="${esc(x.id)}">✓ قبول الطلب مباشرة</button><button class="btn secondary" data-quote-offer="${esc(x.orderId)}">💰 تقديم عرض سعر</button></div>`) : `<button class="btn" data-accept="${esc(x.id)}">✓ قبول الطلب</button>`} <button class="btn secondary" data-reject="${esc(x.id)}">رفض</button></div>`).join('') || '<div class="card muted">لا توجد عروض حاليًا</div>';
            }
            const mo = document.getElementById('myorders');
            if (mo)
                mo.innerHTML = (oo.orders || []).map(providerOrder).join('') || '<div class="card muted">لا توجد طلبات</div>';
            bindProviderLiveActions();
            startOfferCountdowns();
            startProviderPresenceHeartbeat(!!p.provider.isOnline);
            startProviderLocationTracking(!!p.provider.isOnline);
        }
        catch { } }, 8000);
        document.querySelectorAll('[data-provider-order]').forEach(x => x.addEventListener('click', () => openProviderOrder(x.dataset.providerOrder)));
        document.querySelectorAll('[data-provider-chat]').forEach(x => x.addEventListener('click', e => { e.stopPropagation(); openOrderChat(x.dataset.providerChat); }));
    }
    catch (e) {
        shell(`<div class="card error">${esc(e.message)}</div>`);
    }
}
async function setProviderLocation() {
    const msg = document.getElementById('providerLocationMsg');
    const btn = document.getElementById('setProviderLocation');
    if (!navigator.geolocation) {
        if (msg)
            msg.textContent = 'المتصفح لا يدعم تحديد الموقع';
        return;
    }
    btn.disabled = true;
    if (msg)
        msg.textContent = 'جارٍ تحديد أفضل موقع للجهاز...';
    let best = null;
    let watch;
    const started = Date.now();
    const finish = async () => { if (watch !== undefined)
        navigator.geolocation.clearWatch(watch); btn.disabled = false; if (!best) {
        if (msg)
            msg.textContent = 'تعذر الحصول على موقع الجهاز';
        return;
    } try {
        await api('/provider/profile', { method: 'PATCH', body: JSON.stringify({ baseLocation: { lat: best.coords.latitude, lng: best.coords.longitude } }) });
        if (msg)
            msg.textContent = `تم حفظ الموقع بدقة تقريبية ${Math.round(best.coords.accuracy)} متر.`;
        const t = document.getElementById('providerLocationText');
        if (t)
            t.textContent = `محفوظ: ${best.coords.latitude.toFixed(6)} ، ${best.coords.longitude.toFixed(6)}`;
    }
    catch (e) {
        if (msg)
            msg.textContent = e.message;
    } };
    watch = navigator.geolocation.watchPosition(pos => { if (!best || pos.coords.accuracy < best.coords.accuracy)
        best = pos; if (best.coords.accuracy <= 100 || Date.now() - started > 45000)
        finish(); }, err => { if (Date.now() - started > 45000)
        finish();
    else if (msg)
        msg.textContent = 'فعّل GPS وخدمات الموقع ثم انتظر...'; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    window.setTimeout(finish, 60000);
}
function startOfferCountdowns() { if (offerCountdownTimer !== undefined)
    clearInterval(offerCountdownTimer); const tick = () => { document.querySelectorAll('[data-expires]').forEach(el => { const t = Date.parse(el.dataset.expires || ''); const left = Math.max(0, Math.ceil((t - Date.now()) / 1000)); const m = Math.floor(left / 60), s = left % 60; el.textContent = left ? `⏳ متبقٍ لقبول الطلب: ${m}:${String(s).padStart(2, '0')}` : 'انتهت مهلة العرض'; el.classList.toggle('error', left === 0); }); }; tick(); offerCountdownTimer = window.setInterval(tick, 1000); }
function bindProviderLiveActions() {
    document.querySelectorAll('[data-accept]').forEach(x => x.addEventListener('click', async () => { const b = x; const offerId = String(b.dataset.accept || ''); if (!offerId || acceptingOffers.has(offerId))
        return; acceptingOffers.add(offerId); b.disabled = true; b.textContent = 'جارٍ قبول الطلب...'; try {
        await api('/provider/offers/' + encodeURIComponent(offerId) + '/accept', { method: 'POST', body: '{}' });
        acceptingOffers.delete(offerId);
        await provider();
    }
    catch (e) {
        acceptingOffers.delete(offerId);
        b.disabled = false;
        b.textContent = '✓ قبول الطلب';
        alert(e.message);
    } }));
    document.querySelectorAll('[data-quote-offer]').forEach(x => x.addEventListener('click', () => openProviderQuote(x.dataset.quoteOffer)));
    document.querySelectorAll('[data-reject]').forEach(x => x.addEventListener('click', async () => { const b = x; b.disabled = true; try {
        await api('/provider/offers/' + b.dataset.reject + '/reject', { method: 'POST', body: '{}' });
        await provider();
    }
    catch (e) {
        b.disabled = false;
        alert(e.message);
    } }));
    document.querySelectorAll('[data-status]').forEach(x => x.addEventListener('click', async () => { try {
        await api('/provider/orders/' + x.dataset.id + '/status', { method: 'POST', body: JSON.stringify({ to: x.dataset.status }) });
        await provider();
    }
    catch (e) {
        alert(e.message);
    } }));
    document.querySelectorAll('[data-provider-cancel]').forEach(x => x.addEventListener('click', async () => { const b = x; if (!confirm('سيتم إعادة البحث عن مقدم خدمة بديل لهذا الطلب. هل تريد الاعتذار عن الطلب؟'))
        return; b.disabled = true; try {
        await api('/orders/' + encodeURIComponent(b.dataset.providerCancel || '') + '/cancel', { method: 'POST', body: JSON.stringify({ reason: 'اعتذار مقدم الخدمة قبل بدء التنفيذ' }) });
        await provider();
    }
    catch (e) {
        b.disabled = false;
        alert(e.message);
    } }));
}
function providerOrder(o) { const map = { ACCEPTED: 'ON_THE_WAY', ON_THE_WAY: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED' }; const next = map[o.status]; const label = next === 'ON_THE_WAY' ? 'في الطريق' : next === 'IN_PROGRESS' ? 'بدء الخدمة' : 'إكمال الطلب'; return `<div class="card order-card"><button class="order-card-main" data-provider-order="${esc(o.id)}" type="button"><div class="row"><b>${esc(o.code)}</b><span class="status status-${esc(String(o.status).toLowerCase())}">${esc(statusAr(o.status))}</span></div><p>${esc(o.service.name)} — ${esc(o.description)}</p>${o.location ? `<small class="muted">📍 موقع محفوظ مع الطلب</small>` : '<small class="muted">📍 العميل لم يحدد موقعًا بعد — استخدم المحادثة لطلب الموقع.</small>'}<small class="muted">💬 يمكنك فتح الطلب والدردشة مع العميل مباشرة.</small></button><div class="row" style="margin-top:10px"><button class="btn secondary" type="button" data-provider-chat="${esc(o.id)}">💬 فتح الدردشة</button>${next ? `<button class="btn" type="button" data-id="${esc(o.id)}" data-status="${next}">${label}</button>${o.status === 'ACCEPTED' ? ` <button class="btn danger secondary" type="button" data-provider-cancel="${esc(o.id)}">اعتذار وإعادة البحث</button>` : ''}` : ''}</div></div>`; }
// o.customer?.phone is intentionally not rendered to providers; communication stays inside order chat.
async function openProviderOrder(id, autoChat = false) { try {
    const [j, msgsPayload, complaintPayload] = await Promise.all([api('/orders/' + id), api('/orders/' + encodeURIComponent(id) + '/messages?limit=5').catch(() => ({ messages: [] })), api('/orders/' + encodeURIComponent(id) + '/complaint').catch(() => ({ complaint: null, messages: [] }))]);
    const o = j.order;
    const loc = o.location || {};
    const hasLoc = Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng));
    const lat = Number(loc.lat), lng = Number(loc.lng);
    const mapUrl = hasLoc ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}` : '';
    const g = hasLoc ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}&travelmode=driving` : '';
    showModal(`<h2>${esc(o.code)}</h2><p><b>الخدمة:</b> ${esc(o.service.name)}</p><p><b>الحالة:</b> ${esc(statusAr(o.status))}</p><p>${esc(o.description)}</p>${o.trip ? `<div class="trip-summary card"><b>🛵 تفاصيل المشوار</b><p>الغرض: ${esc(o.trip.purposeName)} · المسافة: ${esc(o.trip.distanceKm)} كم · الأجرة: ${esc(o.trip.fare)} ${esc(o.trip.currency)}</p><p class="muted">الوجهة: ${o.trip.destination ? esc(o.trip.destination.addressText || `${Number(o.trip.destination.lat).toFixed(6)} ، ${Number(o.trip.destination.lng).toFixed(6)}`) : 'لم تُحدد بعد — يمكن تحديدها لاحقًا'}</p></div>` : ''}${o.customer ? `<div class="card"><b>👤 العميل: ${esc(o.customer.fullName)}</b><p class="muted">التواصل عبر محادثة الطلب داخل خدمات. رقم الهاتف لا يظهر في الملف العام.</p></div>${state.user?.role === 'PROVIDER' && ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED'].includes(o.status) ? `<div class="card provider-chat-summary"><div class="row" style="justify-content:space-between"><div><h3>💬 التواصل المباشر</h3><p class="muted">${(msgsPayload.messages || []).length ? `آخر رسالة: ${esc((msgsPayload.messages || []).slice(-1)[0]?.body || '')}` : 'لا توجد رسائل بعد.'}</p></div><button class="btn" id="providerChatBtn" type="button">💬 فتح محادثة الطلب</button></div></div>` : ''}` : ''}${o.service?.deliveryProofType === 'PIN' && ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<div class="card"><b>🔐 تأكيد التسليم بالرمز</b><p class="muted">أدخل رمز التسليم الذي يقدمه المستلم قبل إنهاء الطلب.</p><div class="row"><input id="deliveryPinInput" inputmode="numeric" maxlength="6" placeholder="رمز من 6 أرقام"><button class="btn" id="verifyDeliveryPin" type="button">تأكيد الرمز</button></div></div>` : o.service?.deliveryProofType === 'RECIPIENT_CONFIRMATION' && ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<div class="card"><b>👤 تأكيد المستلم</b><p class="muted">يؤكد المستلم اسمه من جهاز العميل قبل إنهاء الطلب.</p><div class="row"><input id="recipientConfirmName" maxlength="120" placeholder="اسم المستلم"><span id="recipientProofStatus" class="muted">بانتظار التأكيد</span></div></div>` : o.service?.deliveryProofType === 'PHOTO' && ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<div class="card"><b>📷 صورة إثبات التسليم</b><p class="muted">التقط صورة واضحة لإثبات التسليم ثم ارفعها.</p><input id="deliveryProofPhoto" type="file" accept="image/jpeg,image/png,image/webp"><button class="btn" id="uploadDeliveryProof" type="button" style="margin-top:8px">رفع إثبات التسليم</button><p id="deliveryProofPhotoStatus" class="muted"></p></div>` : ''}${o.trip && o.status === 'IN_PROGRESS' ? `<div class="row"><button class="btn secondary" id="startWaitBtn" type="button">⏱️ بدء الانتظار</button><button class="btn secondary" id="stopWaitBtn" type="button">⏹️ إنهاء الانتظار</button></div>` : ''}${(o.service?.slug === 'purchase-and-delivery' || o.service?.slug === 'pharmacy-purchase') && ['ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS'].includes(o.status) ? `<button class="btn secondary" id="purchaseChangeBtn" type="button">🛒 طلب تعديل الشراء</button>` : ''}${complaintPayload.complaint ? `<button class="btn secondary" id="providerComplaintBtn" type="button">⚠️ ${['RESOLVED', 'REJECTED', 'CLOSED'].includes(complaintPayload.complaint.status) ? 'عرض الشكوى' : 'متابعة الشكوى'}</button>` : ''}${o.status === 'COMPLETED' ? `<div class="field"><label>تقييم العميل</label><select id="customerScore"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select><textarea id="customerComment" placeholder="تعليق اختياري"></textarea><button class="btn" id="rateCustomer" type="button">إرسال تقييم العميل</button></div>` : ''}${hasLoc ? `<div class="card"><h3>📍 موقع العميل</h3><p class="muted">الإحداثيات المحفوظة في الطلب: ${lat.toFixed(6)} ، ${lng.toFixed(6)}</p><div id="providerOrderMap" style="height:280px;width:100%;border-radius:12px;overflow:hidden"></div><div class="row" style="margin-top:10px"><a class="btn secondary" target="_blank" rel="noopener" href="${mapUrl}">فتح الخريطة</a><a class="btn" target="_blank" rel="noopener" href="${g}">🧭 ابدأ الاتجاهات</a></div></div>` : '<div class="card error">لا يوجد موقع محفوظ لهذا الطلب</div>'}<div class="order-timeline">${renderOrderTimeline(o.status)}</div>`);
    if (hasLoc) {
        const el = document.getElementById('providerOrderMap');
        const L = await ensureLeaflet().catch(() => null);
        if (el && L) {
            const map = L.map(el, { scrollWheelZoom: false }).setView([lat, lng], 18);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
            L.marker([lat, lng]).addTo(map).bindPopup('موقع العميل').openPopup();
            setTimeout(() => map.invalidateSize(), 100);
        }
    }
    document.getElementById('providerChatBtn')?.addEventListener('click', () => openOrderChat(id));
    if (autoChat)
        setTimeout(() => document.getElementById('providerChatBtn')?.click(), 0);
    document.getElementById('verifyDeliveryPin')?.addEventListener('click', async () => { const btn = document.getElementById('verifyDeliveryPin'); const pin = document.getElementById('deliveryPinInput').value.trim(); btn.disabled = true; try {
        await api('/provider/orders/' + encodeURIComponent(id) + '/delivery-proof/verify', { method: 'POST', body: JSON.stringify({ pin }) });
        btn.textContent = '✓ تم تأكيد التسليم';
        alert('تم تأكيد التسليم ويمكن الآن إنهاء الطلب.');
    }
    catch (e) {
        btn.disabled = false;
        alert(e.message);
    } });
    document.getElementById('uploadDeliveryProof')?.addEventListener('click', async () => { const btn = document.getElementById('uploadDeliveryProof'); const st = document.getElementById('deliveryProofPhotoStatus'); const f = document.getElementById('deliveryProofPhoto')?.files?.[0]; if (!f) {
        st.textContent = 'اختر صورة أولًا';
        st.className = 'error';
        return;
    } if (f.size > 5 * 1024 * 1024) {
        st.textContent = 'حجم الصورة يتجاوز 5MB';
        st.className = 'error';
        return;
    } btn.disabled = true; st.textContent = 'جارٍ رفع الصورة...'; try {
        const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('تعذر قراءة الصورة')); fr.readAsDataURL(f); });
        const up = await api('/files', { method: 'POST', body: JSON.stringify({ purpose: 'work_photo', name: f.name, dataBase64: data }) });
        await api('/provider/orders/' + encodeURIComponent(id) + '/delivery-proof/photo', { method: 'POST', body: JSON.stringify({ fileId: up.file.id }) });
        st.textContent = '✓ تم حفظ إثبات التسليم';
        st.className = 'success';
        btn.textContent = 'تم الرفع';
    }
    catch (e) {
        btn.disabled = false;
        st.textContent = e.message;
        st.className = 'error';
    } });
    document.getElementById('startWaitBtn')?.addEventListener('click', async () => { try {
        await api('/trips/' + encodeURIComponent(id) + '/wait', { method: 'POST', body: JSON.stringify({ action: 'START' }) });
        alert('بدأ احتساب وقت الانتظار');
    }
    catch (e) {
        alert(e.message);
    } });
    document.getElementById('stopWaitBtn')?.addEventListener('click', async () => { try {
        const w = await api('/trips/' + encodeURIComponent(id) + '/wait', { method: 'POST', body: JSON.stringify({ action: 'STOP' }) });
        alert(`تم إنهاء الانتظار. الدقائق: ${w.minutes} — الأجرة الحالية: ${w.fare}`);
    }
    catch (e) {
        alert(e.message);
    } });
    document.getElementById('providerComplaintBtn')?.addEventListener('click', () => openOrderComplaint(id, true));
    document.getElementById('purchaseChangeBtn')?.addEventListener('click', async () => { const price = prompt('السعر الجديد المقترح'); if (price === null)
        return; const requestedProduct = prompt('المنتج/البديل (اختياري)') || undefined; const reason = prompt('سبب التعديل (اختياري)') || undefined; try {
        await api('/provider/orders/' + encodeURIComponent(id) + '/purchase-change', { method: 'POST', body: JSON.stringify({ requestedPrice: Number(price), requestedProduct, reason }) });
        alert('تم إرسال طلب تعديل الشراء للعميل.');
    }
    catch (e) {
        alert(e.message);
    } });
    document.getElementById('rateCustomer')?.addEventListener('click', async () => { const b = document.getElementById('rateCustomer'); b.disabled = true; try {
        await api('/provider/orders/' + encodeURIComponent(id) + '/rate-customer', { method: 'POST', body: JSON.stringify({ score: Number(document.getElementById('customerScore').value), comment: document.getElementById('customerComment').value }) });
        alert('تم تقييم العميل');
        b.textContent = 'تم التقييم';
    }
    catch (e) {
        b.disabled = false;
        alert(e.message);
    } });
}
catch (e) {
    alert(e.message);
} }
async function openProviderAreas(providerData) {
    try {
        const j = await api('/areas');
        const areas = j.areas || [];
        const selected = new Set((providerData.serviceAreas || []).map((x) => x.id || x.areaId));
        showModal(`<h2>مناطق الخدمة</h2><p class="muted">اختر المناطق التي تستطيع الوصول إليها. الإسناد يعتمد أيضًا على الإحداثيات الفعلية.</p><div class="grid">${areas.map((a) => `<label class="card"><input type="checkbox" data-area-check="${esc(a.id)}" ${selected.has(a.id) ? 'checked' : ''}> ${esc(a.name)} <small class="muted">${esc(a.type)}</small></label>`).join('')}</div><button class="btn" id="saveProviderAreas">حفظ المناطق</button><p id="providerAreasMsg"></p>`);
        document.getElementById('saveProviderAreas')?.addEventListener('click', async () => { const ids = Array.from(document.querySelectorAll('[data-area-check]:checked')).map(x => x.dataset.areaCheck); try {
            await api('/provider/areas', { method: 'PUT', body: JSON.stringify({ areaIds: ids }) });
            closeModal();
            await provider();
        }
        catch (e) {
            alert(e.message);
        } });
    }
    catch (e) {
        alert(e.message);
    }
}
async function openProviderAvailability(providerData) {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const slots = providerData.availability || [];
    showModal(`<h2>أوقات العمل</h2><p class="muted">حدد الأيام والساعات التي تستقبل فيها الطلبات.</p><div class="availability-toolbar"><button class="btn secondary small" id="selectAllDays" type="button">✓ تحديد كل الأيام</button><button class="btn secondary small" id="clearAllDays" type="button">مسح التحديد</button></div><div id="availabilityRows">${days.map((d, i) => { const x = slots.find((z) => Number(z.weekday) === i); return `<div class="card availability-day" style="margin-top:8px"><label><input type="checkbox" data-day="${i}" ${x ? 'checked' : ''}> ${d}</label><div class="row" style="margin-top:8px"><input type="time" data-start="${i}" value="${esc(x?.start || '08:00')}"><input type="time" data-end="${i}" value="${esc(x?.end || '18:00')}"></div></div>`; }).join('')}</div><button class="btn availability-save" id="saveAvailability">حفظ أوقات العمل</button><p id="availabilityMsg" class="muted"></p>`);
    document.getElementById('selectAllDays')?.addEventListener('click', () => document.querySelectorAll('[data-day]').forEach(x => x.checked = true));
    document.getElementById('clearAllDays')?.addEventListener('click', () => document.querySelectorAll('[data-day]').forEach(x => x.checked = false));
    document.getElementById('saveAvailability')?.addEventListener('click', async () => { const out = []; days.forEach((_, i) => { const c = document.querySelector(`[data-day="${i}"]`); if (c?.checked) {
        const st = document.querySelector(`[data-start="${i}"]`).value;
        const en = document.querySelector(`[data-end="${i}"]`).value;
        if (st && en)
            out.push({ weekday: i, start: st, end: en });
    } }); const msg = document.getElementById('availabilityMsg'); try {
        await api('/provider/availability', { method: 'PUT', body: JSON.stringify({ slots: out }) });
        if (msg) {
            msg.textContent = 'تم حفظ أوقات العمل بنجاح';
            msg.className = 'success';
        }
        setTimeout(() => { closeModal(); provider(); }, 500);
    }
    catch (e) {
        if (msg) {
            msg.textContent = e.message;
            msg.className = 'error';
        }
    } });
}
function trJson(v) { try {
    const x = typeof v === 'string' ? JSON.parse(v) : v;
    return String(x?.ar || x?.en || '');
}
catch {
    return String(v || '');
} }
async function openAliasManager() { try {
    const [j, cat] = await Promise.all([api('/admin/service-aliases'), api('/catalog/bootstrap')]);
    const aliases = j.aliases || [];
    const services = cat.services || [];
    showModal(`<h2>🗣️ قاموس العبارات اليمنية</h2><p class="muted">أضف كلمات أو عبارات يستخدمها الناس فعليًا. سيستخدمها محرك المطابقة مباشرة دون الحاجة لتعديل الكود.</p><div class="card"><form id="aliasForm"><div class="field"><label>الخدمة</label><select name="serviceId" required>${services.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div><div class="field"><label>العبارة</label><input name="phrase" maxlength="120" placeholder="مثال: حراث" required></div><button class="btn">إضافة العبارة</button></form></div><div class="card"><b>العبارات الحالية</b><div class="admin-alias-list">${aliases.slice(0, 150).map((a) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid #eee;padding:8px 0"><span><b>${esc(a.phrase)}</b><small class="muted"> · ${esc(a.serviceName || a.serviceSlug)} · ${a.isActive ? 'نشطة' : 'معطلة'}</small></span><span class="row"><button type="button" class="btn secondary small" data-edit-alias="${esc(a.id)}">تعديل</button><button type="button" class="btn danger small" data-delete-alias="${esc(a.id)}">حذف</button></span></div>`).join('') || '<p class="muted">لا توجد عبارات مضافة.</p>'}</div></div>`);
    document.getElementById('aliasForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try {
        await api('/admin/service-aliases', { method: 'POST', body: JSON.stringify({ serviceId: String(f.get('serviceId')), phrase: String(f.get('phrase')) }) });
        await openAliasManager();
    }
    catch (x) {
        alert(x.message);
    } });
    document.querySelectorAll('[data-edit-alias]').forEach(x => x.addEventListener('click', async () => { const a = aliases.find((z) => z.id === x.dataset.editAlias); if (!a)
        return; const phrase = prompt('العبارة الجديدة:', a.phrase); if (phrase === null)
        return; try {
        await api('/admin/service-aliases/' + encodeURIComponent(a.id), { method: 'PATCH', body: JSON.stringify({ phrase, isActive: a.isActive }) });
        await openAliasManager();
    }
    catch (e) {
        alert(e.message);
    } }));
    document.querySelectorAll('[data-delete-alias]').forEach(x => x.addEventListener('click', async () => { const id = x.dataset.deleteAlias || ''; if (!confirm('حذف هذه العبارة من قاموس المطابقة؟'))
        return; try {
        await api('/admin/service-aliases/' + encodeURIComponent(id), { method: 'DELETE' });
        await openAliasManager();
    }
    catch (e) {
        alert(e.message);
    } }));
}
catch (e) {
    alert(e.message);
} }
async function admin() {
    if (!state.user) {
        authBox('ADMIN');
        return;
    }
    if (state.user.role !== 'ADMIN') {
        redirectToRole(state.user.role);
        return;
    }
    let activeTab = (new URLSearchParams(location.search).get('tab') || 'overview'), orderStatus = '', providerStatus = 'PENDING';
    const load = async () => {
        const qs = (base, status) => status ? base + encodeURIComponent(status) : base;
        const [d, u, o, c, ps, cat, areas, settings, audit, intentAudit, liveProviders, ops, liveOps, alerts, temporaryServices, campaigns, health, perf, reports, businessKpis, settlements, safety, admins] = await Promise.all([
            api('/admin/dashboard'), api('/admin/users?limit=50'), api(qs('/admin/orders?limit=50&status=', orderStatus)), api('/admin/complaints?limit=50'), api(qs('/admin/providers?status=', providerStatus)), api('/admin/catalog'), api('/admin/areas'), api('/admin/settings'), api('/admin/audit-logs?limit=100'), api('/admin/intent-audit?limit=100').catch(() => ({ items: [] })), api('/admin/live-providers'), api('/admin/operations/overview'), api('/admin/operations/live'), api('/admin/operations/alerts?status=OPEN'), api('/admin/temporary-services'), api('/admin/campaigns'), api('/admin/system-health'), api('/admin/performance-diagnostics').catch(() => ({ server: { database: { queries: 0, totalMs: 0, slowQueries: [] }, sse: { users: 0, connections: 0 } }, api: [] })), api('/admin/operations/reports').catch(() => ({ summary: {}, daily: [], byService: [], topProviders: [] })), api('/admin/business-kpis').catch(() => ({})), api('/admin/settlements').catch(() => ({ settlements: [] })), api('/admin/vehicles'), api('/safety-centers'), state.user.adminLevel === 'SUPER_ADMIN' ? api('/admin/admins') : Promise.resolve({ admins: [] })
        ]);
        return { d, u, o, c, ps, cat, areas, settings, audit, intentAudit, liveProviders, safety, admins, ops, liveOps, alerts, temporaryServices, campaigns, health, reports, perf, businessKpis, settlements };
    };
    const draw = async () => {
        try {
            const { d, u, o, c, ps, cat, areas, settings, audit, intentAudit, liveProviders, safety, admins, ops, liveOps, alerts, temporaryServices, campaigns, health, reports, perf, businessKpis, settlements } = await load();
            const stats = d.stats || {};
            const statusOptions = ['', 'PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED'];
            const providerStatuses = ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'];
            const cats = cat.categories || [];
            const allServices = cats.flatMap((x) => x.services || []);
            shell(`<div class="hero"><div class="row" style="justify-content:space-between"><div><h1>لوحة إدارة البنشر الذكي</h1><p>إدارة التشغيل والكتالوج والمناطق والإعدادات من مكان واحد.</p></div><span class="status">${esc(state.user.adminLevel || 'ADMIN')}</span></div></div>
      <div class="nav admin-tabs"><button class="btn ${activeTab === 'overview' ? '' : 'secondary'}" data-admin-tab="overview">نظرة عامة</button><button class="btn ${activeTab === 'business' ? '' : 'secondary'}" data-admin-tab="business">📈 مؤشرات العمل</button><button class="btn ${activeTab === 'providers' ? '' : 'secondary'}" data-admin-tab="providers">مقدمو الخدمات</button><button class="btn ${activeTab === 'verification' ? '' : 'secondary'}" data-admin-tab="verification">طلبات التوثيق</button><button class="btn ${activeTab === 'catalog' ? '' : 'secondary'}" data-admin-tab="catalog">الخدمات والكتالوج</button><button class="btn ${activeTab === 'areas' ? '' : 'secondary'}" data-admin-tab="areas">المناطق</button><button class="btn ${activeTab === 'settings' ? '' : 'secondary'}" data-admin-tab="settings">الإعدادات</button><button class="btn ${activeTab === 'account' ? '' : 'secondary'}" data-admin-tab="account">حسابي</button><button class="btn ${activeTab === 'orders' ? '' : 'secondary'}" data-admin-tab="orders">الطلبات</button><button class="btn ${activeTab === 'live' ? '' : 'secondary'}" data-admin-tab="live">📍 المواقع الحية</button><button class="btn ${activeTab === 'safety' ? '' : 'secondary'}" data-admin-tab="safety">🛡️ مراكز الأمان</button><button class="btn ${activeTab === 'complaints' ? '' : 'secondary'}" data-admin-tab="complaints">الشكاوى</button><button class="btn ${activeTab === 'users' ? '' : 'secondary'}" data-admin-tab="users">المستخدمون</button>${state.user.adminLevel === 'SUPER_ADMIN' ? `<button class="btn ${activeTab === 'admins' ? '' : 'secondary'}" data-admin-tab="admins">المديرون والمشرفون</button>` : ''}<button class="btn ${activeTab === 'audit' ? '' : 'secondary'}" data-admin-tab="audit">سجل العمليات</button><button class="btn ${activeTab === 'command' ? '' : 'secondary'}" data-admin-tab="command">🎛️ مركز التشغيل</button><button class="btn ${activeTab === 'liveOps' ? '' : 'secondary'}" data-admin-tab="liveOps">🟢 المراقبة الحية</button><button class="btn ${activeTab === 'alerts' ? '' : 'secondary'}" data-admin-tab="alerts">🔔 التنبيهات</button><button class="btn ${activeTab === 'temporary' ? '' : 'secondary'}" data-admin-tab="temporary">⏳ الخدمات المؤقتة</button><button class="btn ${activeTab === 'campaigns' ? '' : 'secondary'}" data-admin-tab="campaigns">📣 الإعلانات والحملات</button><button class="btn ${activeTab === 'reports' ? '' : 'secondary'}" data-admin-tab="reports">📊 التقارير</button><button class="btn ${activeTab === 'system' ? '' : 'secondary'}" data-admin-tab="system">🩺 صحة النظام</button></div>
      ${activeTab === 'business' ? `<div class="grid"><div class="card"><div class="stat">${esc(businessKpis.today?.created ?? 0)}</div><div>طلبات اليوم</div></div><div class="card"><div class="stat">${esc(businessKpis.today?.completed ?? 0)}</div><div>مكتملة اليوم</div></div><div class="card"><div class="stat">${esc(businessKpis.ordersWithoutProvider ?? 0)}</div><div>بدون مقدم</div></div><div class="card"><div class="stat">${esc(businessKpis.availableProviders ?? 0)}</div><div>مقدمون متاحون</div></div><div class="card"><div class="stat">${esc(businessKpis.avgProviderResponseSec ?? 0)}ث</div><div>متوسط الاستجابة</div></div><div class="card"><div class="stat">${esc(businessKpis.commissionDue ?? 0)} ${esc(businessKpis.currency || '')}</div><div>عمولة مستحقة</div></div></div><div class="card"><h2>تسويات العمولة</h2><p class="muted">الدفع للمنصة نقدي في البداية، لذلك نحفظ الاستحقاق بدل اختراع محفظة إلكترونية.</p><div class="admin-table-wrap"><table class="table"><thead><tr><th>الطلب</th><th>المقدم</th><th>الإجمالي</th><th>عمولة</th><th>صافي المقدم</th><th>الحالة</th><th></th></tr></thead><tbody>${(settlements.settlements || []).slice(0, 100).map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.providerName)}</td><td>${esc(x.grossAmount)} ${esc(x.currency)}</td><td>${esc(x.commissionAmount)} ${esc(x.currency)}</td><td>${esc(x.payoutAmount)} ${esc(x.currency)}</td><td>${esc(x.status === 'DUE' ? 'مستحقة' : x.status === 'PAID' ? 'مدفوعة' : 'معفاة')}</td><td>${x.status === 'DUE' ? `<button class="btn small" data-pay-settlement="${esc(x.id)}">تسجيل الدفع</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد تسويات.</td></tr>'}</tbody></table></div></div>` : ''}
      ${activeTab === 'command' ? `<div class="grid"><div class="card"><div class="stat">${esc(ops.providers?.online ?? 0)}</div><div>مقدم خدمة متصل</div><small class="muted">${esc(ops.providers?.available ?? 0)} متاح · ${esc(ops.providers?.busy ?? 0)} مشغول</small></div><div class="card"><div class="stat">${esc(ops.orders?.inProgress ?? 0)}</div><div>طلبات جارية</div></div><div class="card"><div class="stat">${esc(ops.orders?.unaccepted ?? 0)}</div><div>بانتظار القبول</div></div><div class="card"><div class="stat">${esc(ops.orders?.overdue ?? 0)}</div><div>طلبات متأخرة</div></div><div class="card"><div class="stat">${esc(ops.alerts?.open ?? 0)}</div><div>تنبيهات مفتوحة</div></div><div class="card"><div class="stat">${esc(ops.alerts?.complaints ?? 0)}</div><div>شكاوى مفتوحة</div></div></div><div class="card"><h2>مؤشر صحة التشغيل: ${ops.health === 'GOOD' ? '🟢' : ops.health === 'ATTENTION' ? '🟠' : '🔴'} ${esc(ops.healthText)}</h2><p class="muted">يعتمد على الطلبات غير المقبولة والمتأخرة والشكاوى وأخطاء النظام، وليس رقمًا ثابتًا.</p></div><div class="card"><h2>يحتاج انتباهك الآن</h2>${(alerts.alerts || []).slice(0, 10).map((a) => `<div class="notice ${a.severity === 'CRITICAL' ? 'error' : ''}"><b>${esc(a.title)}</b><div>${esc(a.message)}</div></div>`).join('') || '<div class="muted">لا توجد تنبيهات مفتوحة.</div>'}</div>` : ''}
      ${activeTab === 'liveOps' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2>🟢 المراقبة الحية</h2><p class="muted">بيانات تشغيلية حقيقية من قاعدة البيانات، مع مزامنة تلقائية عبر SSE عند تغير الطلبات أو حالة مقدم الخدمة.</p></div><button class="btn secondary" id="refreshLiveOps">تحديث الآن</button></div></div><div class="card"><h3>الطلبات الآن</h3><div class="admin-table-wrap"><table class="table"><thead><tr><th>الطلب</th><th>الخدمة</th><th>العميل</th><th>المقدم</th><th>الحالة</th><th>آخر تحديث</th></tr></thead><tbody>${(liveOps.orders || []).map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(trJson(x.serviceName))}</td><td>${esc(x.customerName)}</td><td>${esc(x.providerName || 'غير مسند')}</td><td>${esc(statusAr(x.status))}</td><td>${esc(formatDateTime(x.updatedAt))}</td></tr>`).join('') || '<tr><td colspan=6 class="muted">لا توجد طلبات نشطة.</td></tr>'}</tbody></table></div></div><div class="card"><h3>مقدمو الخدمة</h3><div class="admin-table-wrap"><table class="table"><thead><tr><th>المقدم</th><th>الاتصال</th><th>التوفر</th><th>استقبال الطلبات</th><th>آخر Heartbeat</th><th>آخر موقع</th><th>الطلب الحالي</th><th>الموقع</th></tr></thead><tbody>${(liveOps.providers || []).map((x) => `<tr><td>${esc(x.displayName)}</td><td>${x.online ? '🟢 متصل' : '⚪ غير متصل'}</td><td>${esc(x.availabilityText || 'غير متاح')}</td><td>${x.acceptingOrders ? '🟢 يستقبل' : '⚪ لا يستقبل'}</td><td>${esc(formatDateTime(x.lastHeartbeatAt || x.lastSeenAt || ''))}</td><td>${esc(formatDateTime(x.lastLocationAt || x.updatedAt || ''))}</td><td>${x.currentOrder?.code ? esc(x.currentOrder.code) + ' · ' + esc(statusAr(x.currentOrder.status)) : 'لا يوجد طلب'}</td><td>${x.lat ?? x.baseLat ? `${Number(x.lat ?? x.baseLat).toFixed(5)} , ${Number(x.lng ?? x.baseLng).toFixed(5)}` : 'غير متوفر'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${activeTab === 'alerts' ? `<div class="card"><h2>🔔 مركز التنبيهات</h2><p class="muted">التنبيهات مولدة من حالات النظام الحقيقية. يمكن الإقرار بها أو حلها.</p></div><div>${(alerts.alerts || []).map((a) => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${a.severity === 'CRITICAL' ? '🔴' : '🟠'} ${esc(a.title)}</b><p>${esc(a.message)}</p><small class="muted">${esc(formatDateTime(a.last_seen_at))}</small></div><div class="row"><button class="btn secondary small" data-alert-action="ACKNOWLEDGED" data-alert-id="${esc(a.id)}">إقرار</button><button class="btn small" data-alert-action="RESOLVED" data-alert-id="${esc(a.id)}">حل</button></div></div></div>`).join('') || '<div class="card muted">لا توجد تنبيهات مفتوحة.</div>'}</div>` : ''}
      ${activeTab === 'temporary' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2>⏳ الخدمات المؤقتة والمناسبات</h2><p class="muted">الخدمة تختفي تلقائيًا بعد انتهاء الفترة دون حذف سجلها.</p></div><button class="btn" id="newTemporaryService">+ خدمة مؤقتة</button></div></div><div>${(temporaryServices.items || []).map((x) => `<div class="card"><b>${esc(trJson(x.title_i18n))}</b><p>${esc(trJson(x.description_i18n || '{}'))}</p><small class="muted">${esc(x.start_at)} → ${esc(x.end_at)} · ${esc(x.state || (x.is_active ? 'مفعلة' : 'معطلة'))} · أولوية ${esc(x.priority || 0)} · مرتبطة بخدمة ${esc(x.linked_service_id)}</small><div class="row" style="margin-top:8px"><button class="btn secondary small" data-temp-edit="${esc(x.id)}">تعديل الفترة والأولوية</button><button class="btn secondary small" data-temp-toggle="${esc(x.id)}" data-next-temp="${x.is_active ? 'false' : 'true'}">${x.is_active ? 'إيقاف' : 'تفعيل'}</button></div></div>`).join('') || '<div class="card muted">لا توجد خدمات مؤقتة.</div>'}</div>` : ''}
      ${activeTab === 'campaigns' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2>📣 الإعلانات والحملات</h2><p class="muted">تحدد الإدارة المحتوى والجمهور والفترة دون تعديل الكود.</p></div><button class="btn" id="newCampaign">+ حملة جديدة</button></div></div><div>${(campaigns.items || []).map((x) => `<div class="card"><b>${esc(trJson(x.title_i18n))}</b><p>${esc(trJson(x.description_i18n || '{}'))}</p><small class="muted">${esc(x.start_at)} → ${esc(x.end_at)} · ${esc(x.state || (x.is_active ? 'مفعلة' : 'معطلة'))} · أولوية ${esc(x.priority || 0)}</small><div class="row" style="margin-top:8px"><button class="btn secondary small" data-camp-edit="${esc(x.id)}">تعديل الحملة</button><button class="btn secondary small" data-camp-toggle="${esc(x.id)}" data-next-camp="${x.is_active ? 'false' : 'true'}">${x.is_active ? 'إيقاف' : 'تفعيل'}</button></div></div>`).join('') || '<div class="card muted">لا توجد حملات.</div>'}</div>` : ''}
      ${activeTab === 'reports' ? `<div class="grid"><div class="card"><div class="stat">${esc(reports.summary?.orders ?? 0)}</div><div>الطلبات</div></div><div class="card"><div class="stat">${esc(reports.summary?.completed ?? 0)}</div><div>مكتملة</div></div><div class="card"><div class="stat">${esc(Math.round(reports.summary?.acceptSec || 0))} ث</div><div>متوسط القبول</div></div><div class="card"><div class="stat">${esc(Math.round(reports.summary?.executionSec || 0))} ث</div><div>متوسط التنفيذ</div></div></div><div class="card"><h3>أكثر الخدمات طلبًا</h3><div class="admin-table-wrap"><table class="table"><thead><tr><th>الخدمة</th><th>الطلبات</th><th>مكتملة</th><th>ملغاة</th><th>متوسط القبول</th></tr></thead><tbody>${(reports.byService || []).map((x) => `<tr><td>${esc(x.service)}</td><td>${esc(x.orders)}</td><td>${esc(x.completed)}</td><td>${esc(x.cancelled)}</td><td>${esc(Math.round(x.acceptSec || 0))} ث</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${activeTab === 'system' ? `<div class="grid"><div class="card"><div class="stat">${esc(health.db?.ok ? 'OK' : 'FAIL')}</div><div>قاعدة البيانات</div></div><div class="card"><div class="stat">${esc(health.api?.errors?.length || 0)}</div><div>أخطاء API مسجلة</div></div><div class="card"><div class="stat">${esc(health.api?.slow?.length || 0)}</div><div>مسارات بطيئة</div></div><div class="card"><div class="stat">${esc(perf.server?.database?.queries || 0)}</div><div>استعلامات DB</div><small>${esc(perf.server?.database?.totalMs || 0)}ms إجمالي</small></div><div class="card"><div class="stat">${esc(perf.server?.sse?.connections || 0)}</div><div>اتصالات Realtime</div></div></div><div class="card"><h3>أحدث الأخطاء</h3>${(health.api?.errors || []).map((x) => `<div class="notice error"><b>${esc(x.event_type)}</b> · ${esc(x.path || '')} · ${esc(x.status_code || '')}<br>${esc(x.message)}<br><small>${esc(formatDateTime(x.created_at))}</small></div>`).join('') || '<p class="muted">لا توجد أخطاء مسجلة خلال الفترة.</p>'}</div>` : ''}
      ${activeTab === 'overview' ? `<div class="card" style="border:2px solid #2563eb"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">🔐 طلبات التوثيق</h2><p class="muted">طلبات مقدمي الخدمات التي تنتظر مراجعة الإدارة</p></div><div class="stat">${esc(stats.pendingProviders)}</div></div><button class="btn" id="openVerificationQueue" type="button">فتح طلبات التوثيق والموافقة عليها</button></div><div class="grid"><div class="card"><div class="stat">${esc(stats.users)}</div><div>مستخدمون</div></div><div class="card"><div class="stat">${esc(stats.providers)}</div><div>مقدمو خدمات</div></div><div class="card"><div class="stat">${esc(stats.pendingProviders)}</div><div>بانتظار التوثيق</div></div><div class="card"><div class="stat">${esc(stats.activeOrders)}</div><div>طلبات نشطة</div></div><div class="card"><div class="stat">${esc(stats.completedOrders)}</div><div>طلبات مكتملة</div></div><div class="card"><div class="stat">${esc(stats.cancelledOrders)}</div><div>طلبات ملغاة</div></div><div class="card"><div class="stat">${esc(stats.complaints)}</div><div>شكاوى مفتوحة</div></div><div class="card"><div class="stat">${esc(cats.length)}</div><div>أقسام الكتالوج</div></div><div class="card"><div class="stat">${esc(allServices.length)}</div><div>خدمات الكتالوج</div></div></div><h2>طلبات التوثيق</h2><div>${(ps.providers || []).slice(0, 5).map((p) => adminProviderCard(p)).join('') || '<div class="card muted">لا توجد طلبات توثيق معلقة.</div>'}</div>` : ''}
      ${activeTab === 'providers' ? `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">مقدمو الخدمات</h2><select id="providerStatusFilter">${providerStatuses.map(x => `<option value="${x}" ${providerStatus === x ? 'selected' : ''}>${esc(x === 'PENDING' ? 'بانتظار التوثيق' : x === 'VERIFIED' ? 'موثق' : x === 'REJECTED' ? 'مرفوض' : 'موقوف')}</option>`).join('')}</select></div></div><div>${(ps.providers || []).map((p) => adminProviderCard(p)).join('') || '<div class="card muted">لا توجد نتائج.</div>'}</div>` : ''}
      ${activeTab === 'verification' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">طلبات توثيق الحسابات</h2><p class="muted">راجع الهوية والترخيص ثم اعتمد الحساب أو ارفضه مع ذكر السبب.</p></div><span class="status">${esc(stats.pendingProviders)} بانتظار المراجعة</span></div></div><div>${(ps.providers || []).filter((p) => p.verificationStatus === 'PENDING').map((p) => adminProviderCard(p)).join('') || '<div class="card muted">لا توجد طلبات توثيق معلقة.</div>'}</div>` : ''}
      ${activeTab === 'catalog' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">كتالوج الخدمات</h2><p class="muted">إدارة الأقسام والخدمات والأسعار والحالة ومخطط بيانات الطلب.</p></div><div class="row"><button class="btn secondary" id="openAliasManager" type="button">🗣️ كلمات البحث</button></div></div></div><div>${cats.map((cat) => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(cat.icon || '🛠️')} ${esc(cat.name)}</b><div class="muted">${esc(cat.slug)} · ${cat.isActive ? 'نشط' : 'معطل'} · ${esc(cat.moduleType || 'STANDARD')}</div></div><div class="row"><button class="btn small" data-new-service-category="${esc(cat.id)}" type="button">+ خدمة جديدة</button><button class="btn secondary small" data-edit-category="${esc(cat.id)}">تعديل القسم</button></div></div><div class="row" style="margin-top:10px;flex-wrap:wrap">${(cat.services || []).map((sv) => `<div class="card" style="text-align:right;min-width:240px;flex:1"><b>${esc(sv.icon || '🛠️')} ${esc(sv.name)}</b><small class="muted">${esc(sv.pricingType === 'FIXED' ? 'سعر ثابت' : 'عرض سعر')} · ${sv.basePrice === null ? 'حسب العرض' : esc(sv.basePrice + ' ' + sv.currency)} · ${sv.isActive === false ? 'معطلة' : 'نشطة'}</small><div class="row" style="margin-top:8px"><button class="btn secondary small" data-edit-service="${esc(sv.id)}" type="button">تعديل</button><button class="btn secondary small" data-service-areas="${esc(sv.id)}" type="button">مناطق الخدمة</button></div></div>`).join('') || '<span class="muted">لا توجد خدمات.</span>'}</div></div>`).join('')}</div>` : ''}
      ${activeTab === 'areas' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">المناطق التشغيلية</h2><p class="muted">المناطق مساعدة للمطابقة وليست شرطًا لطلب العميل إذا كانت الإحداثيات صالحة.</p></div><button class="btn" id="newArea">+ منطقة جديدة</button></div></div><div class="card"><div class="admin-table-wrap"><table class="table"><thead><tr><th>الاسم</th><th>النوع</th><th>المركز</th><th>النطاق</th><th>الحالة</th><th></th></tr></thead><tbody>${(areas.areas || []).map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${Number(a.centerLat).toFixed(5)} , ${Number(a.centerLng).toFixed(5)}</td><td>${esc(a.radiusKm)} كم</td><td>${a.isActive ? 'نشطة' : 'معطلة'}</td><td><button class="btn secondary small" data-edit-area="${esc(a.id)}">تعديل</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا توجد مناطق.</td></tr>'}</tbody></table></div></div>` : ''}
      ${activeTab === 'settings' ? `<div class="card"><h2>إعدادات المنصة</h2><p class="muted">تُحفظ الإعدادات في قاعدة البيانات. التعديل متاح لـ SUPER_ADMIN فقط.</p></div><div>${(settings.settings || []).filter((x) => !String(x.key).startsWith('trips.')).map((x) => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(x.key)}</b><p class="muted">${esc(x.description)}</p><small>القيمة الحالية: <code>${esc(JSON.stringify(x.value))}</code> · الافتراضي: <code>${esc(JSON.stringify(x.default))}</code></small></div>${state.user.adminLevel === 'SUPER_ADMIN' ? `<button class="btn secondary small" data-edit-setting="${esc(x.key)}">تعديل</button>` : ''}</div></div>`).join('')}</div>` : ''}
      ${activeTab === 'account' ? `<div class="card"><h2>إعدادات حساب الإدارة</h2><p class="muted">يمكنك تغيير البريد الإلكتروني وكلمة المرور الخاصة بحسابك.</p><button class="btn" id="openAdminAccountSettings" type="button">فتح إعدادات الحساب</button></div>` : ''}
      ${activeTab === 'orders' ? `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">الطلبات</h2><select id="orderStatusFilter">${statusOptions.map(x => `<option value="${x}" ${orderStatus === x ? 'selected' : ''}>${esc(x ? statusAr(x) : 'كل الحالات')}</option>`).join('')}</select></div></div><div class="card"><div class="admin-table-wrap"><table class="table"><thead><tr><th>الرقم</th><th>الخدمة</th><th>الحالة</th><th>العميل</th><th>المقدم</th><th>التاريخ</th><th></th></tr></thead><tbody>${(o.orders || []).map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.service?.name || '—')}</td><td>${esc(statusAr(x.status))}</td><td>${esc(x.customer?.fullName || '—')}</td><td>${esc(x.provider?.displayName || 'غير مسند')}</td><td>${esc(formatDateTime(x.createdAt))}</td><td><button class="btn secondary small" data-admin-order="${esc(x.id)}">التفاصيل</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد طلبات.</td></tr>'}</tbody></table></div></div>` : ''}
      ${activeTab === 'live' ? `<div class="card"><h2>📍 المواقع الحية</h2><p class="muted">آخر موقع لمقدمي الخدمات المتصلين. الوصول مقيد بصلاحيات الإدارة.</p></div><div class="grid">${(liveProviders.providers || []).map((x) => `<div class="card"><b>${esc(x.displayName)}</b><p class="muted">${x.lat != null ? `${Number(x.lat).toFixed(6)} ، ${Number(x.lng).toFixed(6)}` : 'لا يوجد موقع حي'}<br>${x.updatedAt ? esc(formatDateTime(x.updatedAt)) : '—'}</p></div>`).join('') || '<div class="card muted">لا يوجد مقدمو خدمات متصلون.</div>'}</div>` : ''}
      ${activeTab === 'safety' ? `<div class="card"><h2>🛡️ مراكز الأمان</h2><p class="muted">المراكز التي يمكن للمستخدم الوصول إليها عند الحاجة.</p>${(safety.centers || []).map((x) => `<div class="card"><b>${esc(x.name)}</b><p class="muted">${esc(x.addressText || '')} · ${esc(x.phone || '')}</p></div>`).join('') || '<p class="muted">لا توجد مراكز مسجلة.</p>'}</div>` : ''}
      ${activeTab === 'complaints' ? `<div>${(c.complaints || []).map((x) => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(x.code)}</b><div class="muted">الطلب: ${esc(x.orderId)}</div></div><span class="status">${esc(x.status)}</span></div><p><b>${esc(x.category)}</b> — ${esc(x.description)}</p><div class="row"><button class="btn secondary small" data-admin-complaint="${esc(x.id)}">عرض</button>${!['RESOLVED', 'REJECTED', 'CLOSED'].includes(x.status) ? `<button class="btn small" data-admin-complaint="${esc(x.id)}">فتح الشكوى والرد</button>` : ''}</div></div>`).join('') || '<div class="card muted">لا توجد شكاوى.</div>'}</div>` : ''}
      ${activeTab === 'admins' && state.user.adminLevel === 'SUPER_ADMIN' ? `<div class="card admin-manager-head"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">المديرون والمشرفون</h2><p class="muted">أنشئ حسابات مستقلة لفريق الإدارة وحدد مستوى الصلاحية لكل حساب.</p></div><button class="btn" id="newAdminAccount" type="button">+ إضافة مشرف</button></div></div><div class="grid admin-users-grid">${(admins.admins || []).map((x) => `<div class="card admin-user-card"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><b>${esc(x.fullName)}</b><div class="muted">${esc(x.email || 'بدون بريد')}</div><small class="muted">${esc(x.phone)}</small></div><span class="status">${esc(x.adminLevel === 'SUPER_ADMIN' ? 'مدير النظام الأعلى' : x.adminLevel === 'ADMIN' ? 'مدير' : 'مشرف')}</span></div><div class="admin-user-meta"><span>${x.status === 'ACTIVE' ? '🟢 نشط' : '🔴 موقوف'}</span><span>آخر دخول: ${x.lastLoginAt ? esc(formatDateTime(x.lastLoginAt)) : 'لم يسجل'}</span></div>${x.adminLevel !== 'SUPER_ADMIN' ? `<div class="row admin-user-actions"><button class="btn secondary small" data-edit-admin="${esc(x.id)}">تعديل</button><button class="btn secondary small" data-toggle-admin="${esc(x.id)}" data-next-admin-status="${x.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}">${x.status === 'ACTIVE' ? 'إيقاف' : 'تفعيل'}</button></div>` : ''}</div>`).join('') || '<div class="card muted">لا توجد حسابات إضافية.</div>'}</div>` : ''}
      ${activeTab === 'audit' ? `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">سجل العمليات</h2><p class="muted">سجل تدقيق لمراجعة الموافقات والتغييرات والإجراءات الإدارية.</p></div><span class="status">آخر 100 عملية</span></div></div><div class="card"><div class="admin-table-wrap"><table class="table"><thead><tr><th>الوقت</th><th>العملية</th><th>النوع</th><th>المعرّف</th><th>الدور</th></tr></thead><tbody>${(audit.logs || []).map((x) => `<tr><td>${esc(formatDateTime(x.createdAt))}</td><td>${esc(x.action)}</td><td>${esc(x.entityType || '—')}</td><td>${esc(x.entityId || '—')}</td><td>${esc(x.actorRole || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا توجد عمليات مسجلة.</td></tr>'}</tbody></table></div></div>` : ''}
      ${activeTab === 'users' ? `<div class="card"><h2>المستخدمون</h2><table class="table"><thead><tr><th>الاسم</th><th>الهاتف</th><th>الدور</th><th>الحالة</th><th></th></tr></thead><tbody>${(u.users || []).map((x) => `<tr><td>${esc(x.fullName)}</td><td>${esc(x.phone)}</td><td>${esc(x.role)}</td><td>${esc(x.status)}</td><td>${x.id === state.user.id ? '<span class="muted">حسابك</span>' : `<button class="btn secondary small" data-user-status="${esc(x.id)}" data-next-status="${x.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}">${x.status === 'ACTIVE' ? 'تعليق' : 'تفعيل'}</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا توجد نتائج.</td></tr>'}</tbody></table></div></div>` : ''}`);
            document.querySelectorAll('[data-intent-correction]').forEach(x => x.addEventListener('click', async () => { const id = x.dataset.intentCorrection || ''; const serviceId = prompt('معرّف الخدمة الصحيح (اتركه فارغًا فقط لإزالة التصحيح):', ''); if (serviceId === null)
                return; const note = prompt('ملاحظة التصحيح (اختياري):', '') || undefined; try {
                await api('/admin/intent-audit/' + encodeURIComponent(id) + '/correction', { method: 'PATCH', body: JSON.stringify({ serviceId: serviceId || undefined, note }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-admin-tab]').forEach(x => x.addEventListener('click', () => { activeTab = x.dataset.adminTab; history.replaceState(null, '', activeTab === 'overview' ? '/admin' : '/admin?tab=' + encodeURIComponent(activeTab)); draw(); }));
            document.getElementById('openAliasManager')?.addEventListener('click', openAliasManager);
            document.getElementById('openVerificationQueue')?.addEventListener('click', () => { activeTab = 'verification'; history.replaceState(null, '', '/admin?tab=verification'); draw(); });
            document.getElementById('openAdminAccountSettings')?.addEventListener('click', () => openAdminAccountEditor());
            document.getElementById('providerStatusFilter')?.addEventListener('change', e => { providerStatus = e.target.value; draw(); });
            document.getElementById('orderStatusFilter')?.addEventListener('change', e => { orderStatus = e.target.value; draw(); });
            document.querySelectorAll('[data-pay-settlement]').forEach(x => x.addEventListener('click', async () => { const b = x; const note = prompt('ملاحظة الدفع (اختيارية):', '') || undefined; if (note === null)
                return; b.disabled = true; try {
                await api('/admin/settlements/' + encodeURIComponent(b.dataset.paySettlement || '') + '/pay', { method: 'POST', body: JSON.stringify({ note }) });
                await draw();
            }
            catch (e) {
                b.disabled = false;
                alert(e.message);
            } }));
            document.querySelectorAll('[data-verify]').forEach(x => x.addEventListener('click', async () => { const z = x; z.disabled = true; try {
                await api('/admin/providers/' + z.dataset.verify + '/verification', { method: 'PATCH', body: JSON.stringify({ status: 'VERIFIED' }) });
                await draw();
            }
            catch (e) {
                z.disabled = false;
                alert(e.message);
            } }));
            document.querySelectorAll('[data-feature-provider]').forEach(x => x.addEventListener('click', async () => { const z = x; z.disabled = true; try {
                await api('/admin/providers/' + encodeURIComponent(z.dataset.featureProvider || '') + '/featured', { method: 'PATCH', body: JSON.stringify({ featured: z.textContent?.includes('إزالة') !== true }) });
                await draw();
            }
            catch (e) {
                z.disabled = false;
                alert(e.message);
            } }));
            document.querySelectorAll('[data-reject-provider]').forEach(x => x.addEventListener('click', async () => { const z = x; const reason = prompt('سبب رفض التوثيق (اختياري):', 'الوثائق غير مكتملة'); if (reason === null)
                return; try {
                await api('/admin/providers/' + z.dataset.rejectProvider + '/verification', { method: 'PATCH', body: JSON.stringify({ status: 'REJECTED', reason }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-admin-order]').forEach(x => x.addEventListener('click', () => openAdminOrder(x.dataset.adminOrder)));
            document.querySelectorAll('[data-admin-file]').forEach(x => x.addEventListener('click', () => openPrivateFile(x.dataset.adminFile)));
            document.querySelectorAll('[data-admin-complaint]').forEach(x => x.addEventListener('click', () => openAdminComplaint(x.dataset.adminComplaint)));
            document.querySelectorAll('[data-user-status]').forEach(x => x.addEventListener('click', async () => { const z = x; const reason = prompt(z.dataset.nextStatus === 'SUSPENDED' ? 'سبب تعليق الحساب (اختياري):' : 'ملاحظة التفعيل (اختيارية):', ''); if (reason === null)
                return; try {
                await api('/admin/users/' + z.dataset.userStatus + '/status', { method: 'PATCH', body: JSON.stringify({ status: z.dataset.nextStatus, reason }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.getElementById('newAdminAccount')?.addEventListener('click', () => openAdminEditor(null, draw));
            document.querySelectorAll('[data-edit-admin]').forEach(x => x.addEventListener('click', () => openAdminEditor((admins.admins || []).find((z) => z.id === x.dataset.editAdmin), draw)));
            document.querySelectorAll('[data-toggle-admin]').forEach(x => x.addEventListener('click', async () => { const z = x; try {
                await api('/admin/admins/' + z.dataset.toggleAdmin, { method: 'PATCH', body: JSON.stringify({ status: z.dataset.nextAdminStatus }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-new-service-category]').forEach(x => x.addEventListener('click', () => openServiceEditor(null, cats, draw)));
            document.getElementById('newCategory')?.addEventListener('click', () => openCategoryEditor(null, draw));
            document.querySelectorAll('[data-edit-category]').forEach(x => x.addEventListener('click', () => openCategoryEditor(cats.find((z) => z.id === x.dataset.editCategory), draw)));
            document.querySelectorAll('[data-edit-service]').forEach(x => x.addEventListener('click', () => openServiceEditor(allServices.find((z) => z.id === x.dataset.editService), cats, draw)));
            document.querySelectorAll('[data-service-areas]').forEach(x => x.addEventListener('click', () => openServiceAreas(x.dataset.serviceAreas, areas.areas || [], draw)));
            document.getElementById('newArea')?.addEventListener('click', () => openAreaEditor(null, areas.areas || [], draw));
            document.querySelectorAll('[data-edit-area]').forEach(x => x.addEventListener('click', () => openAreaEditor((areas.areas || []).find((z) => z.id === x.dataset.editArea), areas.areas || [], draw)));
            document.querySelectorAll('[data-edit-setting]').forEach(x => x.addEventListener('click', () => editSetting(x.dataset.editSetting, settings.settings || [], draw)));
            document.getElementById('refreshLiveOps')?.addEventListener('click', () => draw());
            document.querySelectorAll('[data-alert-action]').forEach(x => x.addEventListener('click', async () => { const z = x; try {
                await api('/admin/operations/alerts/' + encodeURIComponent(z.dataset.alertId || ''), { method: 'PATCH', body: JSON.stringify({ status: z.dataset.alertAction }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-temp-toggle]').forEach(x => x.addEventListener('click', async () => { const z = x; try {
                await api('/admin/temporary-services/' + encodeURIComponent(z.dataset.tempToggle || ''), { method: 'PATCH', body: JSON.stringify({ isActive: z.dataset.nextTemp === 'true' }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-temp-edit]').forEach(x => x.addEventListener('click', () => { const id = x.dataset.tempEdit || ''; const row = (temporaryServices.items || []).find((v) => v.id === id); if (row)
                openTemporaryServiceEditor(allServices, draw, row); }));
            document.querySelectorAll('[data-camp-toggle]').forEach(x => x.addEventListener('click', async () => { const z = x; try {
                await api('/admin/campaigns/' + encodeURIComponent(z.dataset.campToggle || ''), { method: 'PATCH', body: JSON.stringify({ isActive: z.dataset.nextCamp === 'true' }) });
                await draw();
            }
            catch (e) {
                alert(e.message);
            } }));
            document.querySelectorAll('[data-camp-edit]').forEach(x => x.addEventListener('click', () => { const id = x.dataset.campEdit || ''; const row = (campaigns.items || []).find((v) => v.id === id); if (row)
                openCampaignEditor(draw, row); }));
            document.getElementById('newTemporaryService')?.addEventListener('click', () => openTemporaryServiceEditor(allServices, draw));
            document.getElementById('newCampaign')?.addEventListener('click', () => openCampaignEditor(draw));
        }
        catch (e) {
            shell(`<div class="card error">${esc(e.message)}</div>`);
        }
    };
    await draw();
}
function openTemporaryServiceEditor(allServices, refresh, existing = null) {
    const now = new Date();
    const startValue = existing?.start_at ? new Date(existing.start_at).toISOString().slice(0, 16) : new Date(now.getTime() + 60 * 1000).toISOString().slice(0, 16);
    const endValue = existing?.end_at ? new Date(existing.end_at).toISOString().slice(0, 16) : new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 16);
    const title = existing ? trJson(existing.title_i18n || existing.name_i18n) : 'فحص إطاراتك قبل السفر 🛞';
    const desc = existing ? trJson(existing.description_i18n || '{}') : 'اطلب فحص الإطارات وضغط الهواء قبل الانطلاق، وتعرّف على خدمات البنشر المتاحة.';
    showModal(`<div><h2>${existing ? 'تعديل الخدمة المؤقتة' : 'إضافة خدمة مؤقتة'}</h2><p class="muted">تُحفظ الفترة والأولوية في قاعدة البيانات وتنعكس مباشرة على ترتيب الواجهة العامة.</p><form id="temporaryEditor"><div class="field"><label>الخدمة الفعلية المرتبطة</label><select name="linkedServiceId" ${existing ? 'disabled' : ''}>${allServices.map((x) => `<option value="${esc(x.id)}" ${x.id === existing?.linked_service_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div><div class="field"><label>الاسم الظاهر</label><input name="titleAr" value="${esc(title)}" required></div><div class="field"><label>الوصف</label><textarea name="descriptionAr">${esc(desc)}</textarea></div><div class="grid"><div class="field"><label>البداية</label><input name="startAt" type="datetime-local" value="${startValue}" required></div><div class="field"><label>النهاية</label><input name="endAt" type="datetime-local" value="${endValue}" required></div></div><div class="grid"><div class="field"><label>أولوية الحملة</label><input name="priority" type="number" value="${Number(existing?.priority || 100)}"></div><div class="field"><label>ترتيب ثانوي</label><input name="sortOrder" type="number" value="${Number(existing?.sort_order || 0)}"></div></div><div class="field"><label>طريقة فتح الطلب</label><select name="requestFlow"><option value="SERVICE" ${existing?.request_flow === 'SERVICE' || !existing ? 'selected' : ''}>الخدمة المرتبطة</option><option value="ORDER" ${existing?.request_flow === 'ORDER' ? 'selected' : ''}>طلب بخدمة محددة</option><option value="INTERNAL" ${existing?.request_flow === 'INTERNAL' ? 'selected' : ''}>صفحة داخلية</option><option value="URL" ${existing?.request_flow === 'URL' ? 'selected' : ''}>رابط</option></select></div><div class="field"><label>قيمة التدفق</label><input name="actionValue" value="${esc(existing?.action_value || '')}" placeholder="معرف الخدمة أو الرابط عند الحاجة"></div><button class="btn">${existing ? 'حفظ التعديلات' : 'حفظ الخدمة المؤقتة'}</button><p id="tempMsg"></p></form></div>`);
    document.getElementById('temporaryEditor').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { title: { ar: String(f.get('titleAr')), en: String(f.get('titleAr')) }, description: { ar: String(f.get('descriptionAr') || ''), en: String(f.get('descriptionAr') || '') }, startAt: new Date(String(f.get('startAt'))).toISOString(), endAt: new Date(String(f.get('endAt'))).toISOString(), sortOrder: Number(f.get('sortOrder') || 0), priority: Number(f.get('priority') || 0), requestFlow: String(f.get('requestFlow') || 'SERVICE'), actionValue: String(f.get('actionValue') || '') || undefined, isActive: true }; try {
        if (existing) {
            await api('/admin/temporary-services/' + encodeURIComponent(existing.id), { method: 'PATCH', body: JSON.stringify(body) });
        }
        else {
            body.linkedServiceId = String(f.get('linkedServiceId'));
            body.name = body.title;
            await api('/admin/temporary-services', { method: 'POST', body: JSON.stringify(body) });
        }
        closeModal();
        await refresh();
    }
    catch (x) {
        document.getElementById('tempMsg').textContent = x.message;
        document.getElementById('tempMsg').className = 'error';
    } });
}
function openCampaignEditor(refresh, existing = null) {
    const now = new Date();
    const startValue = existing?.start_at ? new Date(existing.start_at).toISOString().slice(0, 16) : new Date(now.getTime() + 60 * 1000).toISOString().slice(0, 16);
    const endValue = existing?.end_at ? new Date(existing.end_at).toISOString().slice(0, 16) : new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 16);
    const title = existing ? trJson(existing.title_i18n) : 'عروض البنشر والصيانة 🛞';
    const desc = existing ? trJson(existing.description_i18n || '{}') : 'تابع العروض والخدمات المتاحة للبنشر وصيانة المركبات.';
    showModal(`<div><h2>${existing ? 'تعديل الحملة' : 'إضافة إعلان أو حملة'}</h2><form id="campaignEditor"><div class="field"><label>العنوان</label><input name="title" value="${esc(title)}" required></div><div class="field"><label>الوصف</label><textarea name="description">${esc(desc)}</textarea></div><div class="field"><label>نص الزر</label><input name="button" value="${esc(existing ? trJson(existing.button_label_i18n || '{}') : 'اطلب الآن')}"></div><div class="field"><label>نوع الإجراء</label><select name="actionType"><option value="SERVICE" ${existing?.action_type === 'SERVICE' || !existing ? 'selected' : ''}>خدمة</option><option value="ORDER" ${existing?.action_type === 'ORDER' ? 'selected' : ''}>طلب</option><option value="INTERNAL" ${existing?.action_type === 'INTERNAL' ? 'selected' : ''}>صفحة داخلية</option><option value="URL" ${existing?.action_type === 'URL' ? 'selected' : ''}>رابط</option><option value="NONE" ${existing?.action_type === 'NONE' ? 'selected' : ''}>بدون إجراء</option></select></div><div class="field"><label>قيمة الإجراء</label><input name="actionValue" value="${esc(existing?.action_value || '')}" placeholder="معرّف الخدمة أو الرابط"></div><div class="grid"><div class="field"><label>البداية</label><input name="startAt" type="datetime-local" value="${startValue}" required></div><div class="field"><label>النهاية</label><input name="endAt" type="datetime-local" value="${endValue}" required></div><div class="field"><label>أولوية الحملة</label><input name="priority" type="number" value="${Number(existing?.priority || 100)}"></div></div><button class="btn">${existing ? 'حفظ التعديلات' : 'حفظ الحملة'}</button><p id="campMsg"></p></form></div>`);
    document.getElementById('campaignEditor').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { title: { ar: String(f.get('title')), en: String(f.get('title')) }, description: { ar: String(f.get('description') || ''), en: String(f.get('description') || '') }, buttonLabel: { ar: String(f.get('button') || ''), en: String(f.get('button') || '') }, actionType: String(f.get('actionType')), actionValue: String(f.get('actionValue') || '') || undefined, startAt: new Date(String(f.get('startAt'))).toISOString(), endAt: new Date(String(f.get('endAt'))).toISOString(), priority: Number(f.get('priority') || 0), isActive: true }; try {
        await api(existing ? '/admin/campaigns/' + encodeURIComponent(existing.id) : '/admin/campaigns', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        closeModal();
        await refresh();
    }
    catch (x) {
        document.getElementById('campMsg').textContent = x.message;
        document.getElementById('campMsg').className = 'error';
    } });
}
function openAdminAccountEditor() {
    showModal(`<div class="admin-account-modal"><h2>إعدادات حساب الإدارة</h2><p class="muted">تغيير البريد أو كلمة المرور يتطلب كلمة المرور الحالية. بعد الحفظ تُلغى الجلسات القديمة ويُنشأ تسجيل دخول جديد.</p><form id="adminAccountEditor"><div class="field"><label>الاسم</label><input name="fullName" value="${esc(state.user?.fullName || '')}" minlength="2" maxlength="80"></div><div class="field"><label>البريد الإلكتروني الجديد</label><input name="email" type="email" value="${esc(state.user?.email || '')}" autocomplete="email"></div><div class="field"><label>كلمة المرور الحالية</label><input name="currentPassword" type="password" autocomplete="current-password"></div><div class="field"><label>كلمة المرور الجديدة</label><input name="newPassword" type="password" autocomplete="new-password" minlength="10"><small class="muted">10 أحرف على الأقل وتحتوي على حرف ورقم.</small></div><button class="btn">حفظ التغييرات</button><p id="adminAccountMsg"></p></form></div>`);
    document.getElementById('adminAccountEditor').addEventListener('submit', async (e) => { e.preventDefault(); const form = e.currentTarget; const btn = form.querySelector('button'); btn.disabled = true; const f = new FormData(form); const body = { fullName: String(f.get('fullName') || '').trim() }; const email = String(f.get('email') || '').trim(); const cp = String(f.get('currentPassword') || ''); const np = String(f.get('newPassword') || ''); if (email)
        body.email = email; if (cp)
        body.currentPassword = cp; if (np)
        body.newPassword = np; try {
        const j = await api('/admin/account', { method: 'PATCH', body: JSON.stringify(body) });
        saveSession(j);
        closeModal();
        await admin();
    }
    catch (x) {
        btn.disabled = false;
        document.getElementById('adminAccountMsg').textContent = x.message;
        document.getElementById('adminAccountMsg').className = 'error';
    } });
}
function openAdminEditor(admin, refresh) {
    const isEdit = !!admin;
    showModal(`<div class="admin-account-modal"><h2>${isEdit ? 'تعديل حساب إداري' : 'إضافة مشرف أو مدير'}</h2><p class="muted">كل حساب مستقل ويمكن إيقافه دون مشاركة كلمة المرور مع بقية الفريق.</p><form id="adminEditor"><div class="grid"><div class="field"><label>الاسم</label><input name="fullName" value="${esc(admin?.fullName || '')}" required minlength="2" maxlength="80"></div><div class="field"><label>الهاتف</label><input name="phone" value="${esc(admin?.phone || '')}" required></div><div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" value="${esc(admin?.email || '')}" required></div><div class="field"><label>${isEdit ? 'كلمة المرور الجديدة (اختياري)' : 'كلمة المرور'}</label><input name="password" type="password" ${isEdit ? '' : 'required'} minlength="10"><small class="muted">10 أحرف على الأقل وتحتوي على حرف ورقم.</small></div><div class="field"><label>الصلاحية</label><select name="adminLevel"><option value="SUPPORT" ${admin?.adminLevel === 'SUPPORT' ? 'selected' : ''}>مشرف</option><option value="ADMIN" ${!admin || admin?.adminLevel === 'ADMIN' ? 'selected' : ''}>مدير</option></select></div></div><button class="btn">${isEdit ? 'حفظ التعديلات' : 'إنشاء الحساب'}</button><p id="adminEditorMsg"></p></form></div>`);
    document.getElementById('adminEditor').addEventListener('submit', async (e) => { e.preventDefault(); const form = e.currentTarget; const btn = form.querySelector('button'); btn.disabled = true; const f = new FormData(form); const body = { fullName: String(f.get('fullName')), phone: String(f.get('phone')), email: String(f.get('email')), adminLevel: String(f.get('adminLevel')) }; const pw = String(f.get('password') || ''); if (pw)
        body.password = pw; try {
        await api(isEdit ? '/admin/admins/' + admin.id : '/admin/admins', { method: isEdit ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        closeModal();
        await refresh();
    }
    catch (x) {
        btn.disabled = false;
        document.getElementById('adminEditorMsg').textContent = x.message;
        document.getElementById('adminEditorMsg').className = 'error';
    } });
}
function openCategoryEditor(cat, refresh) {
    showModal(`<h2>${cat ? 'تعديل القسم' : 'إضافة قسم'}</h2><form id="categoryEditor"><div class="grid"><div class="field"><label>الاسم بالعربية</label><input name="ar" value="${esc(cat?.nameI18n?.ar || cat?.name || '')}" required></div><div class="field"><label>الاسم بالإنجليزية</label><input name="en" value="${esc(cat?.nameI18n?.en || '')}"></div><div class="field"><label>Slug</label><input name="slug" value="${esc(cat?.slug || '')}" ${cat ? 'disabled' : ''} required></div><div class="field"><label>الأيقونة</label><input name="icon" value="${esc(cat?.icon || '')}"></div><div class="field"><label>ترتيب العرض</label><input name="sortOrder" type="number" value="${esc(cat?.sortOrder ?? 0)}"></div>${cat ? `<div class="field"><label>الحالة</label><select name="isActive"><option value="true" ${cat.isActive ? 'selected' : ''}>نشط</option><option value="false" ${!cat.isActive ? 'selected' : ''}>معطل</option></select></div>` : ''}</div><div class="field"><label>الوصف</label><textarea name="description">${esc(cat?.descriptionI18n?.ar || cat?.description || '')}</textarea></div><button class="btn">حفظ</button></form>`);
    document.getElementById('categoryEditor').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const body = { name: { ar: String(f.get('ar')), en: String(f.get('en') || '') }, description: { ar: String(f.get('description') || '') }, icon: String(f.get('icon') || ''), sortOrder: Number(f.get('sortOrder') || 0) }; if (!cat) {
        body.slug = String(f.get('slug'));
    }
    else
        body.isActive = String(f.get('isActive')) === 'true'; try {
        await api(cat ? '/admin/categories/' + cat.id : '/admin/categories', { method: cat ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        document.querySelector('.modal-backdrop')?.remove();
        await refresh();
    }
    catch (x) {
        alert(x.message);
    } });
}
async function openServiceAreas(serviceId, areas, refresh) { try {
    const j = await api('/admin/services/' + encodeURIComponent(serviceId) + '/areas');
    const selected = new Set((j.areas || []).map((x) => x.id));
    showModal(`<h2>مناطق الخدمة</h2><p class="muted">عند تحديد مناطق، لن تُسند الخدمة إلا لطلبات تقع داخلها. اتركها فارغة إذا كانت الخدمة متاحة في كل المناطق.</p><div class="grid">${areas.map((a) => `<label class="card"><input type="checkbox" data-service-area="${esc(a.id)}" ${selected.has(a.id) ? 'checked' : ''}> ${esc(a.name)} <small class="muted">${esc(a.type)}</small></label>`).join('')}</div><button class="btn" id="saveServiceAreas" type="button">حفظ المناطق</button>`);
    document.getElementById('saveServiceAreas')?.addEventListener('click', async () => { const ids = Array.from(document.querySelectorAll('[data-service-area]:checked')).map(x => x.dataset.serviceArea); const btn = document.getElementById('saveServiceAreas'); btn.disabled = true; try {
        await api('/admin/services/' + encodeURIComponent(serviceId) + '/areas', { method: 'PUT', body: JSON.stringify({ areaIds: ids }) });
        closeModal();
        await refresh();
    }
    catch (e) {
        btn.disabled = false;
        alert(e.message);
    } });
}
catch (e) {
    alert(e.message);
} }
function openServiceEditor(sv, cats, refresh) {
    const formSchema = sv?.formSchema || [];
    showModal(`<h2>${sv ? 'تعديل الخدمة' : 'إضافة خدمة'}</h2><form id="serviceEditor"><div class="grid"><div class="field"><label>القسم</label><select name="categoryId" required>${cats.map((c) => `<option value="${esc(c.id)}" ${sv?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Slug</label><input name="slug" value="${esc(sv?.slug || '')}" ${sv ? 'disabled' : ''} required></div><div class="field"><label>الاسم بالعربية</label><input name="ar" value="${esc(sv?.nameI18n?.ar || sv?.name || '')}" required></div><div class="field"><label>الاسم بالإنجليزية</label><input name="en" value="${esc(sv?.nameI18n?.en || '')}"></div><div class="field"><label>الأيقونة</label><input name="icon" value="${esc(sv?.icon || '')}"></div><div class="field"><label>نوع التسعير</label><select name="pricingType"><option value="FIXED" ${sv?.pricingType === 'FIXED' ? 'selected' : ''}>سعر ثابت</option><option value="QUOTE" ${sv?.pricingType === 'QUOTE' ? 'selected' : ''}>عرض سعر</option></select></div><div class="field"><label>السعر الأساسي</label><input name="basePrice" type="number" min="0" step="0.01" value="${esc(sv?.basePrice ?? '')}"></div><div class="row"><label class="card"><input type="checkbox" name="requiresInspection" ${sv?.requiresInspection ? 'checked' : ''}> تحتاج معاينة</label><label class="card"><input type="checkbox" name="requiresVehicle" ${sv?.requiresVehicle ? 'checked' : ''}> تحتاج مركبة</label><label class="card"><input type="checkbox" name="supportsWaiting" ${sv?.supportsWaiting ? 'checked' : ''}> تدعم الانتظار</label></div><div class="field"><label>إثبات التسليم</label><select name="deliveryProofType"><option value="NONE" ${!sv?.deliveryProofType || sv?.deliveryProofType === 'NONE' ? 'selected' : ''}>لا يوجد</option><option value="PIN" ${sv?.deliveryProofType === 'PIN' ? 'selected' : ''}>رمز PIN</option><option value="RECIPIENT_CONFIRMATION" ${sv?.deliveryProofType === 'RECIPIENT_CONFIRMATION' ? 'selected' : ''}>تأكيد المستلم</option><option value="PHOTO" ${sv?.deliveryProofType === 'PHOTO' ? 'selected' : ''}>صورة إثبات</option></select></div><div class="field"><label>الخدمة الموسمية</label><label class="card"><input type="checkbox" name="seasonalEnabled" ${sv?.seasonalEnabled ? 'checked' : ''}> تفعيل الموسم</label></div><div class="grid"><div class="field"><label>بداية الموسم</label><input name="seasonStartAt" type="datetime-local" value="${esc(sv?.seasonStartAt ? new Date(sv.seasonStartAt).toISOString().slice(0, 16) : '')}"></div><div class="field"><label>نهاية الموسم</label><input name="seasonEndAt" type="datetime-local" value="${esc(sv?.seasonEndAt ? new Date(sv.seasonEndAt).toISOString().slice(0, 16) : '')}"></div></div><div class="field"><label>الأولوية</label><select name="defaultPriority"><option value="LOW" ${sv?.defaultPriority === 'LOW' ? 'selected' : ''}>منخفضة</option><option value="NORMAL" ${!sv || sv?.defaultPriority === 'NORMAL' ? 'selected' : ''}>عادية</option><option value="URGENT" ${sv?.defaultPriority === 'URGENT' ? 'selected' : ''}>عاجلة</option></select></div>${sv ? `<div class="field"><label>الحالة</label><select name="isActive"><option value="true" ${sv.isActive !== false ? 'selected' : ''}>نشطة</option><option value="false" ${sv.isActive === false ? 'selected' : ''}>معطلة</option></select></div>` : ''}</div><div class="field"><label>الوصف</label><textarea name="description">${esc(sv?.descriptionI18n?.ar || sv?.description || '')}</textarea></div><div class="field"><label>مخطط نموذج الطلب JSON</label><textarea name="formSchema" style="min-height:180px;font-family:monospace">${esc(JSON.stringify(formSchema, null, 2))}</textarea><small class="muted">يجب أن يكون مصفوفة حقول صحيحة حسب مخطط الخدمة.</small></div><button class="btn">حفظ الخدمة</button></form>`);
    const form = document.getElementById('serviceEditor');
    form.addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(form); let fs; try {
        fs = JSON.parse(String(f.get('formSchema') || '[]'));
    }
    catch {
        alert('مخطط JSON غير صالح');
        return;
    } const body = { categoryId: String(f.get('categoryId')), name: { ar: String(f.get('ar')), en: String(f.get('en') || '') }, description: { ar: String(f.get('description') || '') }, icon: String(f.get('icon') || ''), pricingType: String(f.get('pricingType')), defaultPriority: String(f.get('defaultPriority')), basePrice: String(f.get('basePrice') || '') === '' ? undefined : Number(f.get('basePrice')), formSchema: fs, requiresInspection: f.has('requiresInspection'), requiresVehicle: f.has('requiresVehicle'), supportsWaiting: f.has('supportsWaiting'), deliveryProofType: String(f.get('deliveryProofType') || 'NONE'), seasonalEnabled: f.has('seasonalEnabled'), seasonStartAt: String(f.get('seasonStartAt') || '') || undefined, seasonEndAt: String(f.get('seasonEndAt') || '') || undefined }; if (!sv)
        body.slug = String(f.get('slug'));
    else
        body.isActive = String(f.get('isActive')) === 'true'; try {
        await api(sv ? '/admin/services/' + sv.id : '/admin/services', { method: sv ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        document.querySelector('.modal-backdrop')?.remove();
        await refresh();
    }
    catch (x) {
        alert(x.message);
    } });
}
function openAreaEditor(area, areas, refresh) {
    showModal(`<h2>${area ? 'تعديل المنطقة' : 'إضافة منطقة'}</h2><form id="areaEditor"><div class="grid"><div class="field"><label>الاسم بالعربية</label><input name="ar" value="${esc(area?.nameI18n?.ar || area?.name || '')}" required></div><div class="field"><label>الاسم بالإنجليزية</label><input name="en" value="${esc(area?.nameI18n?.en || '')}"></div><div class="field"><label>نوع الموقع</label><select name="type" ${area ? 'disabled' : ''}><option value="COUNTRY" ${area?.type === 'COUNTRY' ? 'selected' : ''}>دولة</option><option value="CITY" ${area?.type === 'CITY' ? 'selected' : ''}>مدينة</option><option value="DISTRICT" ${area?.type === 'DISTRICT' ? 'selected' : ''}>منطقة/نطاق</option></select></div><div class="field"><label>المستوى المحلي</label><select name="localityType"><option value="COUNTRY" ${area?.localityType === 'COUNTRY' ? 'selected' : ''}>دولة</option><option value="GOVERNORATE" ${area?.localityType === 'GOVERNORATE' ? 'selected' : ''}>محافظة</option><option value="CITY" ${area?.localityType === 'CITY' ? 'selected' : ''}>مدينة</option><option value="DIRECTORATE" ${area?.localityType === 'DIRECTORATE' ? 'selected' : ''}>مديرية</option><option value="ISOLATION" ${area?.localityType === 'ISOLATION' ? 'selected' : ''}>عزلة</option><option value="VILLAGE" ${area?.localityType === 'VILLAGE' ? 'selected' : ''}>قرية</option><option value="NEIGHBORHOOD" ${area?.localityType === 'NEIGHBORHOOD' ? 'selected' : ''}>حارة</option><option value="DISTRICT" ${area?.localityType === 'DISTRICT' ? 'selected' : ''}>حي/منطقة</option></select></div><div class="field"><label>المنطقة الأم</label><select name="parentId"><option value="">بدون</option>${areas.filter((x) => x.id !== area?.id).map((x) => `<option value="${esc(x.id)}" ${area?.parentId === x.id ? 'selected' : ''}>${esc(x.name)} (${esc(x.type)})</option>`).join('')}</select></div><div class="field"><label>خط العرض</label><input name="centerLat" type="number" step="0.000001" value="${esc(area?.centerLat ?? '')}" required></div><div class="field"><label>خط الطول</label><input name="centerLng" type="number" step="0.000001" value="${esc(area?.centerLng ?? '')}" required></div><div class="field"><label>نصف القطر كم</label><input name="radiusKm" type="number" min="0.1" max="5000" step="0.1" value="${esc(area?.radiusKm ?? 25)}" required></div>${area ? `<div class="field"><label>الحالة</label><select name="isActive"><option value="true" ${area.isActive ? 'selected' : ''}>نشطة</option><option value="false" ${!area.isActive ? 'selected' : ''}>معطلة</option></select></div>` : ''}</div><button class="btn">حفظ المنطقة</button></form>`);
    document.getElementById('areaEditor').addEventListener('submit', async (e) => { e.preventDefault(); const f = new FormData(e.target); const body = { name: { ar: String(f.get('ar')), en: String(f.get('en') || '') }, localityType: String(f.get('localityType') || 'DISTRICT'), centerLat: Number(f.get('centerLat')), centerLng: Number(f.get('centerLng')), radiusKm: Number(f.get('radiusKm')) }; if (!area) {
        body.type = String(f.get('type'));
        body.parentId = String(f.get('parentId') || '') || undefined;
    }
    else
        body.isActive = String(f.get('isActive')) === 'true'; try {
        await api(area ? '/admin/areas/' + area.id : '/admin/areas', { method: area ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        document.querySelector('.modal-backdrop')?.remove();
        await refresh();
    }
    catch (x) {
        alert(x.message);
    } });
}
async function editSetting(key, settings, refresh) { const item = settings.find(x => x.key === key); if (!item)
    return; const value = prompt(`القيمة الجديدة للإعداد ${key}\n${item.description}`, JSON.stringify(item.value)); if (value === null)
    return; let parsed; try {
    parsed = JSON.parse(value);
}
catch {
    parsed = value;
} try {
    await api('/admin/settings/' + encodeURIComponent(key), { method: 'PUT', body: JSON.stringify({ value: parsed }) });
    await refresh();
}
catch (e) {
    alert(e.message);
} }
function adminProviderCard(p) {
    const docs = (p.documents || []).filter((x) => x.docType === 'ID' || x.docType === 'LICENSE');
    const actions = p.verificationStatus === 'PENDING' ? `<button class="btn" data-verify="${esc(p.id)}">توثيق الحساب</button><button class="btn secondary" data-reject-provider="${esc(p.id)}">رفض</button>` : '';
    return `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(p.displayName)}</b><div class="muted">${esc(p.fullName)} · ${esc(p.phone)}</div><div class="muted">${esc(p.providerType)} · ${esc(p.email || 'بدون بريد')}</div></div><span class="status">${esc(p.verificationStatus)}</span></div><div class="row" style="margin-top:10px">${docs.map((x) => x.fileUrl ? `<button class="btn secondary small" type="button" data-admin-file="${esc(x.fileUrl)}">${esc(docTypeAr(x.docType))}</button>` : `<span class="muted">${esc(docTypeAr(x.docType))}: لا يوجد ملف</span>`).join('') || '<span class="muted">لا توجد وثائق هوية/ترخيص.</span>'}</div><div class="row" style="margin-top:10px"><span class="muted">${p.isOnline ? '🟢 متصل' : '⚪ غير متصل'} · ${esc(p.availabilityStatusText || 'غير متاح')} · آخر ظهور: ${esc(formatDateTime(p.lastSeenAt || ''))}<br>التقييم: ${esc(p.rating ?? 0)} · مكتملة: ${esc(p.completedOrders ?? 0)} · مقبولة: ${esc(p.acceptanceRate ?? 0)}% · مرفوضة: ${esc(p.rejectedOrders ?? 0)} · بلا استجابة: ${esc(p.noResponseOrders ?? 0)} · ملغاة: ${esc(p.cancelledOrders ?? 0)} · استجابة: ${esc(p.responseTimeText || 'غير متاح')}</span><button class="btn secondary small" type="button" data-feature-provider="${esc(p.id)}">${p.featured ? 'إزالة التميز' : 'تمييز مقدم الخدمة'}</button>${actions}</div></div>`;
}
async function openAdminOrder(id) {
    try {
        const [j, h] = await Promise.all([api('/admin/operations/orders/' + encodeURIComponent(id)), api('/orders/' + encodeURIComponent(id) + '/history').catch(() => ({ history: [] }))]);
        const o = { ...j.order, history: j.history?.length ? j.history : h.history, assignments: j.assignments };
        const loc = o.location || {};
        const hasLoc = Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng));
        const lat = Number(loc.lat), lng = Number(loc.lng);
        const mapUrl = hasLoc ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}` : '';
        showModal(`<h2>${esc(o.code)}</h2><div class="grid"><div class="card"><b>الخدمة</b><p>${esc(o.service?.name || '—')}</p></div><div class="card"><b>الحالة</b><p>${esc(statusAr(o.status))}</p></div><div class="card"><b>العميل</b><p>${esc(o.customer?.fullName || '—')}</p></div><div class="card"><b>مقدم الخدمة</b><p>${esc(o.provider?.displayName || 'غير مسند')}</p></div></div><div class="card"><b>الوصف</b><p>${esc(o.description)}</p><p class="muted">أُنشئ: ${esc(formatDateTime(o.createdAt))}</p>${hasLoc ? `<a class="btn secondary" target="_blank" rel="noopener" href="${mapUrl}">فتح موقع الطلب على الخريطة</a>` : ''}</div><h3>سجل حالة الطلب</h3><div class="order-timeline">${(j.history || []).map((x) => `<div class="timeline-step done"><span class="timeline-dot">✓</span><div><b>${esc(statusAr(x.toStatus))}</b><small>${esc(formatDateTime(x.createdAt))} · ${esc(x.actorRole || '')}</small></div></div>`).join('')}</div>`);
    }
    catch (e) {
        alert(e.message);
    }
}
async function openAdminComplaint(id) {
    try {
        const j = await api('/complaints/' + encodeURIComponent(id));
        const c = j.complaint;
        const msgs = j.messages || [];
        const closed = ['RESOLVED', 'REJECTED', 'CLOSED'].includes(c.status);
        const statusMap = { OPEN: 'جديدة', PROVIDER_REPLIED: 'بانتظار مراجعة الإدارة', UNDER_REVIEW: 'قيد المتابعة', RESOLVED: 'تم الحل', REJECTED: 'مرفوضة', CLOSED: 'مغلقة' };
        const roleMap = { CUSTOMER: 'العميل', PROVIDER: 'مقدم الخدمة', ADMIN: 'الإدارة' };
        showModal(`<div class="complaint-modal" data-complaint-id="${esc(c.id)}"><div class="chat-header"><div><h2>⚠️ محادثة الشكوى ${esc(c.code)}</h2><p><b>الحالة:</b> <span class="status">${esc(statusMap[c.status] || c.status)}</span> · <b>التصنيف:</b> ${esc(c.category)}</p></div><span class="chat-live-badge">● مباشر</span></div><div class="card"><b>وصف الشكوى</b><p>${esc(c.description)}</p></div><h3>المحادثة</h3><div id="adminComplaintThread" class="chat-messages complaint-thread"></div>${!closed ? `<form id="adminComplaintReplyForm" class="chat-form card" style="margin-top:12px"><textarea name="body" minlength="1" maxlength="1000" required placeholder="اكتب رد الإدارة للعميل بوضوح..."></textarea><button class="btn" type="submit">إرسال الرد</button></form><div class="card" style="margin-top:12px"><h3>إنهاء الشكوى</h3><p class="muted">يمكنك الرد دون إغلاق المحادثة. القرار النهائي منفصل.</p><div class="field"><label>القرار</label><select id="adminComplaintAction"><option value="RESTORE_COMPLETED">حل المشكلة وإبقاء الطلب مكتملًا</option><option value="CANCEL_ORDER">إلغاء الطلب</option><option value="WARN_PROVIDER">تنبيه مقدم الخدمة</option><option value="SUSPEND_PROVIDER">إيقاف مقدم الخدمة مؤقتًا</option><option value="DISMISS">رفض الشكوى لعدم ثبوتها</option></select></div><div class="field"><label>ملاحظة القرار</label><textarea id="adminComplaintNote" maxlength="500" placeholder="سبب القرار أو ما تم التحقق منه..."></textarea></div><button class="btn danger" id="closeComplaintBtn" type="button">إغلاق الشكوى وحفظ القرار</button></div>` : `<div class="notice success">تم إنهاء هذه الشكوى. يمكنك مراجعة كامل المراسلات والقرار أعلاه.</div>`}</div>`);
        const renderThread = (items) => { const box = document.getElementById('adminComplaintThread'); if (!box)
            return; box.innerHTML = items.map((m) => `<div class="chat-bubble ${m.authorRole === 'ADMIN' && m.authorId === state.user?.id ? 'mine' : 'theirs'}"><div class="chat-meta"><b>${esc(roleMap[m.authorRole] || m.authorRole)}</b><small>${esc(formatDateTime(m.createdAt))}</small></div><p>${esc(m.body)}</p></div>`).join('') || '<p class="muted">لا توجد رسائل بعد.</p>'; box.scrollTop = box.scrollHeight; };
        renderThread(msgs);
        document.getElementById('adminComplaintReplyForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const form = e.currentTarget; const btn = form.querySelector('button'); const body = String(new FormData(form).get('body') || '').trim(); if (!body)
            return; btn.disabled = true; try {
            await api('/complaints/' + encodeURIComponent(c.id) + '/reply', { method: 'POST', headers: { 'Idempotency-Key': newIdempotencyKey() }, body: JSON.stringify({ body }) });
            const latest = await api('/complaints/' + encodeURIComponent(c.id));
            renderThread(latest.messages || []);
            form.querySelector('textarea').value = '';
        }
        catch (e) {
            alert(e.message);
        }
        finally {
            btn.disabled = false;
        } });
        document.getElementById('closeComplaintBtn')?.addEventListener('click', async () => { const action = String(document.getElementById('adminComplaintAction').value); const note = document.getElementById('adminComplaintNote').value.trim(); const btn = document.getElementById('closeComplaintBtn'); btn.disabled = true; try {
            await api('/admin/complaints/' + encodeURIComponent(id) + '/action', { method: 'POST', body: JSON.stringify({ action, note }) });
            alert('تم حفظ القرار وإغلاق الشكوى');
            closeModal();
            await admin();
        }
        catch (e) {
            btn.disabled = false;
            alert(e.message);
        } });
        const onComplaint = async (ev) => { const d = ev.detail; if (d?.complaintId === c.id) {
            const latest = await api('/complaints/' + encodeURIComponent(c.id));
            renderThread(latest.messages || []);
        } };
        window.addEventListener('khadamat:complaint-message', onComplaint);
        const timer = window.setInterval(async () => { if (!document.querySelector('.complaint-modal')) {
            clearInterval(timer);
            window.removeEventListener('khadamat:complaint-message', onComplaint);
            return;
        } try {
            const latest = await api('/complaints/' + encodeURIComponent(c.id));
            renderThread(latest.messages || []);
        }
        catch { } }, 5000);
    }
    catch (e) {
        alert(e.message);
    }
}
async function resolveAdminComplaint(id, refresh) { await openAdminComplaint(id); }
const restored = restoreSession();
if (restored) {
    startRealtime().catch(() => { });
    startNotificationPolling();
    flushOrderQueue().catch(() => { });
    flushMessageOutbox().catch(() => { });
    if ('Notification' in window && Notification.permission === 'granted')
        registerWebPushSubscription().catch(() => { });
    const expected = roleHome(state.user.role);
    if (location.pathname !== expected)
        location.replace(expected);
    else if (page === 'provider')
        provider();
    else if (page === 'admin')
        admin();
    else
        customer();
}
else if (page === 'provider') {
    authBox('PROVIDER');
}
else if (page === 'admin') {
    authBox('ADMIN');
}
else {
    authBox(location.pathname === '/customer' ? 'CUSTOMER' : null);
}
