export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;
export interface Logger { debug(msg: string, fields?: LogFields): void; info(msg: string, fields?: LogFields): void; warn(msg: string, fields?: LogFields): void; error(msg: string, fields?: LogFields): void }

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const REDACT = /pass(word)?|token|authorization|secret|cookie/i;

function redact(obj: unknown, depth = 0): unknown {
  if (obj === null || typeof obj !== 'object' || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = REDACT.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = (line) => process.stdout.write(line + '\n')): Logger {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl: Exclude<LogLevel, 'silent'>) => (msg: string, fields: LogFields = {}) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(redact(fields) as object) }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
