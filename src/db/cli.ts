import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from './database.js';
import { migrate } from './migrate.js';
import { seedBase, seedDemo } from './seed.js';
import { createLogger } from '../core/logger.js';

const [cmd, ...flags] = process.argv.slice(2);
const config = loadConfig();
const log = createLogger('info', (l) => console.log(l));
const logShim = { info: (m: string) => log.info(m) };
const db = openDb(config.dbPath);
try {
  if (cmd === 'migrate') {
    console.log(`migrations applied: ${migrate(db, logShim)}`);
  } else if (cmd === 'seed') {
    migrate(db, logShim);
    const r = await seedBase(db, config);
    console.log(`seed: +${r.categories} أقسام، +${r.services} خدمات`);
    if (r.adminCreated) console.log(`تم إنشاء المدير الأول: ${config.admin.email} / ${config.admin.phone}\nكلمة المرور: ${r.adminPassword}` + (config.admin.password ? '' : '\n(احفظها الآن، لن تُعرض مرة أخرى)'));
    if (flags.includes('--demo')) {
      const d = await seedDemo(db, config);
      console.log(`بيانات تجريبية جاهزة. الحسابات: ${d.accounts.join(', ')} — كلمة المرور: ${d.password}`);
    }
  } else if (cmd === 'backup') {
    const dir = path.resolve(path.dirname(config.dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `khadamat-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`backup: ${file}`);
  } else {
    console.log('usage: cli.js migrate | seed [--demo] | backup');
    process.exitCode = 1;
  }
} finally { db.close(); }
