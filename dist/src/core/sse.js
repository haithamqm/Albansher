/** SseHub: قناة الوقت الحقيقي (خادم ← عميل). Port قابل للاستبدال بـWebSocket/Push لاحقًا. */
export class SseHub {
    maxPerUser;
    clients = new Map();
    timer;
    constructor(maxPerUser = 5) {
        this.maxPerUser = maxPerUser;
        this.timer = setInterval(() => this.ping(), 25_000);
        this.timer.unref?.();
    }
    add(userId, res) {
        const set = this.clients.get(userId) || new Set();
        if (set.size >= this.maxPerUser) {
            const oldest = set.values().next().value;
            if (oldest) {
                oldest.end();
                set.delete(oldest);
            }
        }
        set.add(res);
        this.clients.set(userId, set);
        res.on('close', () => { set.delete(res); if (!set.size)
            this.clients.delete(userId); });
    }
    send(userId, event, data) {
        for (const res of this.clients.get(userId) || []) {
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
            catch { /* connection closed */ }
        }
    }
    broadcast(event, data) { for (const set of this.clients.values())
        for (const res of set)
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
            catch { /* connection closed */ } }
    ping() { for (const set of this.clients.values())
        for (const res of set)
            try {
                res.write(': ping\n\n');
            }
            catch { /* ignore */ } }
    stats() { let connections = 0; for (const set of this.clients.values())
        connections += set.size; return { users: this.clients.size, connections }; }
    closeAll() { clearInterval(this.timer); for (const set of this.clients.values())
        for (const r of set)
            r.end(); this.clients.clear(); }
}
//# sourceMappingURL=sse.js.map