import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const srcMigrations = path.join(root, 'src', 'db', 'migrations');
const distMigrations = path.join(dist, 'src', 'db', 'migrations');
fs.mkdirSync(distMigrations, { recursive: true });
for (const file of fs.readdirSync(srcMigrations)) {
  if (file.endsWith('.sql')) fs.copyFileSync(path.join(srcMigrations, file), path.join(distMigrations, file));
}
fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
const srcPublic = path.join(root, 'public');
const distPublic = path.join(dist, 'public');
fs.rmSync(distPublic, { recursive: true, force: true });
fs.cpSync(srcPublic, distPublic, { recursive: true });
console.log('Build assets copied.');
