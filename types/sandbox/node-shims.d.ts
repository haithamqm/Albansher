// تصريحات مبسّطة لواجهات Node المستخدمة فقط — للفحص في بيئة بلا @types/node (بدون شبكة).
// على جهاز فيه شبكة: `npm install` ثم `npm run typecheck` (يستخدم @types/node الحقيقية ولا يحتاج هذا الملف).
interface NodeBuffer extends Uint8Array {
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
  subarray(start?: number, end?: number): NodeBuffer;
}
declare const Buffer: {
  from(data: string | ArrayLike<number> | ArrayBuffer, encoding?: string): NodeBuffer;
  concat(list: Uint8Array[]): NodeBuffer;
  alloc(n: number): NodeBuffer;
};
type Buffer = NodeBuffer;
declare const process: {
  env: Record<string, string | undefined>; argv: string[]; exitCode?: number; exit(code?: number): never;
  on(ev: string, cb: (...a: any[]) => void): void; stdout: { write(s: string): boolean };
};
interface ImportMeta { dirname: string; filename: string }
declare module 'node:fs' {
  interface Stat { isFile(): boolean; isDirectory(): boolean; size: number }
  interface Dirent { name: string; isDirectory(): boolean }
  const fs: {
    mkdirSync(p: string, o?: { recursive?: boolean }): void; existsSync(p: string): boolean;
    readFileSync(p: string): NodeBuffer; readFileSync(p: string, enc: string): string;
    writeFileSync(p: string, d: string | Uint8Array, o?: { mode?: number }): void; readdirSync(p: string): string[];
    readdirSync(p: string, o: { withFileTypes: true }): Dirent[]; statSync(p: string): Stat; unlinkSync(p: string): void;
    createReadStream(p: string): { pipe(d: unknown): unknown }; mkdtempSync(prefix: string): string;
  };
  export default fs;
}
declare module 'node:path' {
  const path: { join(...p: string[]): string; resolve(...p: string[]): string; dirname(p: string): string; extname(p: string): string; relative(a: string, b: string): string; sep: string };
  export default path;
}
declare module 'node:os' { const os: { tmpdir(): string }; export default os; }
declare module 'node:util' { export function promisify(fn: (...a: any[]) => any): (...a: any[]) => Promise<any>; }
declare module 'node:crypto' {
  interface Hash { update(d: string | Uint8Array): Hash; digest(): NodeBuffer; digest(enc: 'hex' | 'base64' | 'base64url'): string }
  const crypto: {
    randomUUID(): string; randomBytes(n: number): NodeBuffer; createHash(a: string): Hash; createHmac(a: string, k: string | Uint8Array): Hash;
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean; scrypt(...a: any[]): void;
  };
  export default crypto;
}
declare module 'node:http' {
  export interface IncomingMessage { headers: Record<string, string | string[] | undefined>; url?: string; method?: string; socket: { remoteAddress?: string }; [Symbol.asyncIterator](): AsyncIterator<NodeBuffer> }
  export interface ServerResponse { writeHead(s: number, h?: Record<string, string | number>): ServerResponse; write(c: unknown): boolean; end(c?: unknown): void; on(ev: string, cb: () => void): ServerResponse }
  export interface Server {
    listen(port: number, host?: string | (() => void), cb?: () => void): Server; close(cb?: () => void): Server; closeAllConnections?(): void;
    address(): { port: number } | string | null; requestTimeout: number; headersTimeout: number;
  }
  const http: { createServer(h: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Server };
  export default http;
}
declare module 'node:sqlite' {
  export interface RunResult { changes: number | bigint; lastInsertRowid: number | bigint }
  export interface StatementSync { get(...p: any[]): Record<string, any> | undefined; all(...p: any[]): Record<string, any>[]; run(...p: any[]): RunResult }
  export class DatabaseSync { constructor(path: string); exec(sql: string): void; prepare(sql: string): StatementSync; close(): void }
}
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
  export function describe(name: string, fn: () => void): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  interface Assert {
    (v: unknown, msg?: string): asserts v; ok(v: unknown, msg?: string): asserts v; equal(a: unknown, b: unknown, msg?: string): void;
    notEqual(a: unknown, b: unknown, msg?: string): void; deepEqual(a: unknown, b: unknown, msg?: string): void;
    match(v: string | null, re: RegExp, msg?: string): void; throws(fn: () => unknown, check?: unknown): void; rejects(fn: () => Promise<unknown>, check?: unknown): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
