import fs from 'node:fs';
import path from 'node:path';

/** Port: StorageProvider. التنفيذ الحالي: قرص محلي. لاحقًا S3/GCS بنفس الواجهة. */
export interface StorageProvider { save(key: string, buf: Buffer): void; read(key: string): Buffer; remove(key: string): void }

export class LocalStorage implements StorageProvider {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private safe(key: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(key)) throw new Error('invalid storage key');
    return path.join(this.dir, key);
  }
  save(key: string, buf: Buffer): void { fs.writeFileSync(this.safe(key), buf, { mode: 0o640 }); }
  read(key: string): Buffer { return fs.readFileSync(this.safe(key)); }
  remove(key: string): void { try { fs.unlinkSync(this.safe(key)); } catch { /* ignore */ } }
}
