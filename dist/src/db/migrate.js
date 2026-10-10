import fs from 'node:fs';
import path from 'node:path';
const dir = path.join(import.meta.dirname, 'migrations');
export function migrate(db, log = { info: (m) => console.log(m) }) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set(db.all('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let n = 0;
    for (const f of files) {
        if (done.has(f))
            continue;
        db.tx(() => {
            db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
            db.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
        });
        n++;
        log.info?.(`migration applied: ${f}`);
    }
    return n;
}
//# sourceMappingURL=migrate.js.map