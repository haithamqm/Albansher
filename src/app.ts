import http from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { loadConfig, type Config, type ConfigOverrides } from './config.js';
import { createLogger, type Logger } from './core/logger.js';
import { openDb, type Db } from './db/database.js';
import { migrate } from './db/migrate.js';
import { Router, createRequestHandler } from './core/http.js';
import { MemoryRateLimiter, type RateLimiter } from './core/rateLimit.js';
import { SseHub } from './core/sse.js';
import { LocalStorage, type StorageProvider } from './ports/storage.js';
import { RuleIntentParser, type IntentParser } from './ports/intent.js';
import { NearestRatedMatcher, type Matcher } from './ports/matching.js';
import { createSettings, type SettingsSvc } from './modules/settings.js';
import { createAudit, type AuditSvc } from './modules/audit.js';
import { createCatalog, registerCatalogRoutes, registerCatalogAdminRoutes, type Catalog } from './modules/catalog.js';
import { createLocations, type Locations } from './modules/locations.js';
import { createNotifications, registerNotificationRoutes, type Notifications } from './modules/notifications.js';
import { createWebPushService, type WebPushService } from './modules/webpush.js';
import { createAuthService, registerAuthRoutes, type AuthService } from './modules/auth.js';
import { registerUserRoutes } from './modules/users.js';
import { registerFileRoutes } from './modules/files.js';
import { registerSearchRoutes } from './modules/search.js';
import { createProviders, registerProviderRoutes, type Providers } from './modules/providers.js';
import { registerAdminCoreRoutes } from './modules/admin.core.js';
import { registerAdminOperationsRoutes } from './modules/admin.operations.js';
import { registerPlatformRoutes } from './modules/platform.js';
import { createOrders, registerOrderRoutes, type Orders } from './modules/orders.js';
import { createAssignmentService, registerAssignmentRoutes, type AssignmentService } from './modules/assignment.js';
import { registerQuoteRoutes } from './modules/quotes.js';
import { registerRatingRoutes } from './modules/ratings.js';
import { registerComplaintRoutes } from './modules/complaints.js';
import { registerChatRoutes } from './modules/chat.js';
import { registerTripRoutes } from './modules/trips.js';
import { registerTrackingRoutes } from './modules/tracking.js';
import { registerCustomerExperienceRoutes } from './modules/customer-experience.js';
import { registerDeliveryProofRoutes } from './modules/delivery-proof.js';
import { registerExecutionRoutes } from './modules/execution.js';
import { registerProductRoutes } from './modules/product.js';
import { createScheduler, type Scheduler } from './modules/scheduler.js';
import { CashPayment, type PaymentProvider } from './ports/payment.js';

export interface Clock { now(): number }
export interface SseTicket { userId: string; exp: number }

/** الجذر التركيبي (Composition Root): يبني كل الوحدات ويربطها. الاختبارات تستدعيه بإعدادات خاصة. */
export interface App {
  config: Config; log: Logger; db: Db; clock: Clock; sseTickets: Map<string, SseTicket>;
  router: Router; limiter: RateLimiter; sse: SseHub; storage: StorageProvider; intentParser: IntentParser; matcher: Matcher;
  settings: SettingsSvc; audit: AuditSvc; catalog: Catalog; locations: Locations; notifications: Notifications;
  authService: AuthService; providers: Providers; orders: Orders; assignment: AssignmentService; scheduler: Scheduler; payment: PaymentProvider; webPush: WebPushService;
  server: HttpServer; close(): Promise<void>;
}

export function createApp(overrides: ConfigOverrides = {}): App {
  const config = loadConfig(overrides);
  const log = createLogger(config.logLevel as any);
  const db = openDb(config.dbPath);
  migrate(db, log);

  const app = { config, log, db, clock: { now: () => Date.now() }, sseTickets: new Map<string, SseTicket>() } as App;
  app.router = new Router();
  app.limiter = new MemoryRateLimiter(() => app.clock.now());
  app.sse = new SseHub();
  app.storage = new LocalStorage(config.uploadDir);
  app.intentParser = new RuleIntentParser();
  app.settings = createSettings(app);
  app.audit = createAudit(app);
  app.catalog = createCatalog(app);
  app.locations = createLocations(app);
  app.webPush = createWebPushService(app);
  app.notifications = createNotifications(app);
  app.authService = createAuthService(app);
  app.providers = createProviders(app);
  app.matcher = new NearestRatedMatcher(app);
  app.orders = createOrders(app);
  app.assignment = createAssignmentService(app);
  app.payment = new CashPayment(app);
  app.scheduler = createScheduler(app);

  const r = app.router;
  registerAuthRoutes(app, r);
  registerUserRoutes(app, r);
  registerCatalogRoutes(app, r);
  registerCatalogAdminRoutes(app, r);
  registerSearchRoutes(app, r);
  registerFileRoutes(app, r);
  registerProviderRoutes(app, r);
  registerNotificationRoutes(app, r);
  registerAdminCoreRoutes(app, r);
  registerAdminOperationsRoutes(app, r);
  registerPlatformRoutes(app, r);
  registerOrderRoutes(app, r);
  registerAssignmentRoutes(app, r);
  registerQuoteRoutes(app, r);
  registerRatingRoutes(app, r);
  registerComplaintRoutes(app, r);
  registerChatRoutes(app, r);
  registerTripRoutes(app, r);
  registerTrackingRoutes(app, r);
  registerCustomerExperienceRoutes(app, r);
  registerDeliveryProofRoutes(app, r);
  registerExecutionRoutes(app, r);
  registerProductRoutes(app, r);

  app.server = http.createServer(createRequestHandler(app as any));
  app.server.requestTimeout = 30_000;
  app.server.headersTimeout = 15_000;
  if (!config.disableScheduler) app.scheduler.start();
  app.close = () => new Promise<void>((resolve) => {
    app.limiter.stop(); app.sse.closeAll(); app.scheduler.stop();
    app.server.close(() => { try { db.close(); } catch { /* closed */ } resolve(); });
    app.server.closeAllConnections?.();
  });
  return app;
}
