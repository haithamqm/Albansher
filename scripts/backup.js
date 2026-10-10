import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const source = process.env.DATABASE_PATH || './data/ban-shar.db';
const destination = process.argv[2] || `./backups/ban-shar-${new Date().toISOString().replace(/[:.]/g,'-')}.db`;
if (source === ':memory:' || !fs.existsSync(source)) {
  console.error(`Database file not found or is in-memory: ${source}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  console.log(`Backup completed: ${path.resolve(destination)}`);
} finally { db.close(); }
