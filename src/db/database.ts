import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, any>;
/**
 * طبقة قاعدة البيانات (Port). التنفيذ الحالي SQLite (مدمجة في Node — صفر اعتماديات).
 * كل الاستعلامات في الوحدات تستخدم SQL معياريًا (Parameterized) لتسهيل الانتقال إلى PostgreSQL.
 */
export interface RunResult { lastInsertRowid: number | bigint; changes: number | bigint }
export interface Db {
  raw: DatabaseSync;
  exec(sql: string): void;
  get<T = Row>(sql: string, ...p: any[]): T | undefined;
  /** مثل get لكنه يفترض وجود صف (COUNT/aggregate) ويرمي خطأ برمجيًا إن لم يوجد */
  one<T = Row>(sql: string, ...p: any[]): T;
  all<T = Row>(sql: string, ...p: any[]): T[];
  run(sql: string, ...p: any[]): RunResult;
  tx<T>(fn: () => T): T;
  afterCommit(fn: () => void): void;
  performanceSnapshot(): {queries:number; totalMs:number; slowQueries:Array<{sql:string;count:number;avgMs:number;maxMs:number}>};
  close(): void;
}

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  let after: (() => void)[] = [];
  let queryCount = 0; let queryTotalMs = 0; const queryStats = new Map<string,{count:number;totalMs:number;maxMs:number}>();
  const timed = <T>(sql:string, fn:()=>T):T => { const t=Date.now(); try{return fn();} finally { const ms=Date.now()-t; queryCount++; queryTotalMs+=ms; const x=queryStats.get(sql)||{count:0,totalMs:0,maxMs:0}; x.count++; x.totalMs+=ms; x.maxMs=Math.max(x.maxMs,ms); queryStats.set(sql,x); } };

  const db: Db = {
    raw,
    exec: (sql: string) => timed(sql,()=>raw.exec(sql)),
    get: <T = Row>(sql: string, ...p: any[]) => timed(sql,()=>stmt(sql).get(...p) as T | undefined),
    one: <T = Row>(sql: string, ...p: any[]) => {
      const row = timed(sql,()=>stmt(sql).get(...p) as T | undefined);
      if (!row) throw new Error(`db.one(): no row for query: ${sql}`);
      return row;
    },
    all: <T = Row>(sql: string, ...p: any[]) => timed(sql,()=>stmt(sql).all(...p) as T[]),
    run: (sql: string, ...p: any[]) => timed(sql,()=>stmt(sql).run(...p) as RunResult),
    /** معاملة ذرّية. المتداخلة تُدمج في الخارجية. */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        raw.exec('COMMIT');
        depth = 0;
        const cbs = after; after = [];
        for (const cb of cbs) { try { cb(); } catch (e) { console.error('afterCommit error', e); } }
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        depth = 0; after = [];
        throw e;
      }
    },
    /** ينفَّذ بعد نجاح الـCOMMIT فقط (إشعارات لحظية…) أو فورًا خارج معاملة. */
    afterCommit(fn: () => void): void { if (depth > 0) after.push(fn); else fn(); },
    performanceSnapshot: () => ({queries:queryCount,totalMs:queryTotalMs,slowQueries:Array.from(queryStats.entries()).sort((a,b)=>b[1].totalMs-a[1].totalMs).slice(0,30).map(([sql,x])=>({sql,count:x.count,avgMs:Number((x.totalMs/x.count).toFixed(2)),maxMs:x.maxMs}))}),
    close(): void { raw.close(); },
  };
  return db;
}
