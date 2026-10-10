import fs from 'node:fs';
import path from 'node:path';
export class LocalStorage {
    dir;
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
    }
    safe(key) {
        if (!/^[a-zA-Z0-9-]+$/.test(key))
            throw new Error('invalid storage key');
        return path.join(this.dir, key);
    }
    save(key, buf) { fs.writeFileSync(this.safe(key), buf, { mode: 0o640 }); }
    read(key) { return fs.readFileSync(this.safe(key)); }
    remove(key) { try {
        fs.unlinkSync(this.safe(key));
    }
    catch { /* ignore */ } }
}
//# sourceMappingURL=storage.js.map