import { createApp } from './app.js';
import { seedBase } from './db/seed.js';

const app = createApp();

// Railway/production must initialize the catalog and first admin automatically.
// seedBase is idempotent: it adds missing defaults without overwriting admin edits.
const seedResult = await seedBase(app.db, app.config);
app.log.info('startup_seed_complete', {
  categoriesAdded: seedResult.categories,
  servicesAdded: seedResult.services,
  adminCreated: seedResult.adminCreated,
});
if (seedResult.adminCreated) {
  app.log.info('startup_admin_created', { email: app.config.admin.email, initialAdminCredential: seedResult.adminPassword, message: 'احفظ كلمة المرور الآن؛ لن تظهر مرة أخرى بعد إنشاء المدير الأول.' });
}

app.server.listen(app.config.port, () => app.log.info('server_started', { port: app.config.port, env: app.config.env }));

let stopping = false;
async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info('shutdown', { sig });
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e: unknown) => app.log.error('unhandledRejection', { err: String(e) }));
