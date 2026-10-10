const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const REDACT = /pass(word)?|token|authorization|secret|cookie/i;
function redact(obj, depth = 0) {
    if (obj === null || typeof obj !== 'object' || depth > 4)
        return obj;
    if (Array.isArray(obj))
        return obj.map((x) => redact(x, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj))
        out[k] = REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
}
export function createLogger(level = 'info', sink = (line) => process.stdout.write(line + '\n')) {
    const min = LEVELS[level] ?? 20;
    const emit = (lvl) => (msg, fields = {}) => {
        if (LEVELS[lvl] < min)
            return;
        sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...redact(fields) }));
    };
    return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
//# sourceMappingURL=logger.js.map