/**
 * إعلانات أنواع مصغّرة لوحدات Node المدمجة (node:*) — لا يمكن تثبيت @types/node في هذه البيئة (لا شبكة).
 * تغطي فقط الواجهات المستخدمة فعليًا في هذا المشروع، حتى يعمل `tsc --strict` تحققًا حقيقيًا لا شكليًا.
 * عند توفر الشبكة لاحقًا: `npm i -D @types/node` ثم حذف هذا الملف — لا تغيير في الكود.
 */
declare module 'node:crypto' {
  const crypto: any;
  export default crypto;
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function createHash(alg: string): { update(d: string | Buffer): any; digest(enc: 'hex' | 'base64' | 'base64url'): string };
  export function createHmac(alg: string, key: string | Buffer): { update(d: string): any; digest(enc: 'base64url'): string; digest(): Buffer };
  export function timingSafeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
  export function scrypt(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }, cb: (err: Error | null, derivedKey: Buffer) => void): void;
}
declare module 'node:util' {
  export function promisify<T extends (...args: any[]) => any>(fn: T): (...args: any[]) => Promise<any>;
}
declare module 'node:fs' {
  export function existsSync(p: string): boolean;
  export function statSync(p: string): { isFile(): boolean; isDirectory(): boolean };
  export function mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  export function readFileSync(p: string): Buffer;
  export function readFileSync(p: string, enc: 'utf8'): string;
  export function writeFileSync(p: string, data: string | Buffer, opts?: { mode?: number }): void;
  export function unlinkSync(p: string): void;
  export function readdirSync(p: string): string[];
  export function readdirSync(p: string, opts: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
  export function mkdtempSync(prefix: string): string;
  export function createReadStream(p: string): any;
}
declare module 'node:path' {
  export function resolve(...p: string[]): string;
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
  export function extname(p: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:http' {
  export interface IncomingMessage { url?: string; method?: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string }; on(ev: string, cb: (...a: any[]) => void): any; [Symbol.asyncIterator](): AsyncIterator<Buffer>; }
  export interface ServerResponse { writeHead(status: number, headers?: Record<string, string>): void; write(chunk: string): boolean; end(chunk?: string | Buffer): void; on(ev: string, cb: (...a: any[]) => void): void; }
  export interface Server {
    listen(port: number, cb?: () => void): Server;
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: () => void): void;
    address(): { port: number } | null;
    requestTimeout: number;
    headersTimeout: number;
    closeAllConnections?(): void;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}
declare module 'node:crypto' { export function randomInt(max: number): number; }
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): { get(...params: any[]): any; all(...params: any[]): any[]; run(...params: any[]): { lastInsertRowid: number | bigint; changes: number } };
    close(): void;
  }
}
declare module 'node:test' {
  function test(name: string, fn: () => any | Promise<any>): void;
  export function describe(name: string, fn: () => any): void;
  export function before(fn: () => any | Promise<any>): void;
  export function after(fn: () => any | Promise<any>): void;
  export function beforeEach(fn: () => any | Promise<any>): void;
  export default test;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: any, message?: string): void;
    equal(a: any, b: any, message?: string): void;
    notEqual(a: any, b: any, message?: string): void;
    deepEqual(a: any, b: any, message?: string): void;
    ok(v: any, message?: string): void;
    throws(fn: () => any, matcher?: any, message?: string): void;
    rejects(fn: () => Promise<any>, matcher?: any): Promise<void>;
    match(v: unknown, re: RegExp): void;
  }
  const assert: Assert;
  export default assert;
}
declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): never; on(ev: string, cb: (...a: any[]) => void): void; exitCode?: number; stdout: { write(s: string): void } };
declare const console: { log(...a: any[]): void; error(...a: any[]): void; warn(...a: any[]): void };
interface Headers { get(name: string): string | null }
declare function fetch(url: string, init?: any): Promise<{ status: number; ok: boolean; headers: Headers; text(): Promise<string>; json(): Promise<any> }>;
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBuffer | number[], enc?: string): Buffer;
  static concat(list: Buffer[]): Buffer;
  static alloc(size: number): Buffer;
  toString(enc?: string): string;
  static isBuffer(x: any): x is Buffer;
  writeUInt32BE(value: number, offset: number): Buffer;
  equals(other: Uint8Array): boolean;
  subarray(start?: number, end?: number): Buffer;
}
interface ImportMeta { dirname: string; url: string }
interface TimerHandle { unref?: () => void }
declare function setInterval(cb: () => void, ms: number): TimerHandle;
declare function clearInterval(t: TimerHandle | null | undefined): void;
declare function setTimeout(cb: () => void, ms: number): TimerHandle;
declare function clearTimeout(t: TimerHandle | null | undefined): void;
declare class URL {
  constructor(input: string, base?: string);
  pathname: string;
  href: string;
  protocol: string;
  host: string;
  searchParams: URLSearchParams;
}
declare class URLSearchParams {
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
}
