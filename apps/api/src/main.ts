import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { PrismaService } from './prisma/prisma.service';

/**
 * Teach `JSON.stringify` how to handle BigInt.
 *
 * Postgres `COUNT(*)::bigint` comes back from a Prisma raw query as a JavaScript BigInt, and
 * `JSON.stringify` throws on one — which turns an otherwise-working analytics endpoint into a
 * 500 the first time somebody adds an aggregate. Converting at each call site works until
 * someone forgets; doing it once here means no aggregate query can produce that failure again.
 *
 * Values inside the safe-integer range become numbers, which is what a count is. Anything larger
 * becomes a string rather than a silently-wrong number: 2^53 rows is not a count, it is a bug or
 * an id, and neither should be quietly rounded.
 */
(BigInt.prototype as unknown as { toJSON(): number | string }).toJSON = function toJSON() {
  const value = this as unknown as bigint;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
};

async function bootstrap(): Promise<void> {
  // Body parsers are registered below with explicit limits instead of Express's 100 KB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  const config = app.get(ConfigService<AppConfig, true>);
  const logger = new Logger('Bootstrap');

  const port = config.get('port', { infer: true });
  const prefix = config.get('globalPrefix', { infer: true });
  const corsOrigins = config.get('corsOrigins', { infer: true });
  const isProduction = config.get('isProduction', { infer: true });

  app.setGlobalPrefix(prefix);

  // Proof of delivery carries up to five photos in base64 (10 MB each once decoded); nothing else
  // needs more than a couple of megabytes. The large limit applies to that route only, so the rest
  // of the API cannot be fed huge bodies.
  app.use(`/${prefix}/deliveries`, json({ limit: '70mb' }));
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP here would break Swagger UI without
      // protecting anything, so CSP is applied on the Next.js app instead.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Anything not declared on a DTO is dropped rather than forwarded to Prisma — this is what
      // stops mass-assignment of fields like `role` or `companyId`.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  const webDistDir = config.get('webDistDir', { infer: true });
  if (webDistDir && existsSync(webDistDir)) {
    serveStaticExport(app, webDistDir);
    logger.log(`Serving the web UI from ${webDistDir}`);
  }

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new AuditInterceptor(app.get(Reflector), app.get(PrismaService)));

  app.enableShutdownHooks();

  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SCIP API')
      .setDescription(
        'Supply Chain Intelligence Platform — tracking (TRACK) and optimisation (OPTIMIZE) in one API.',
      )
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Authentication, sessions and invitations')
      .addTag('companies', 'Tenant settings')
      .addTag('suppliers', 'Supplier master data and performance')
      .addTag('customers', 'Customer master data')
      .addTag('carriers', 'Carriers and fleet owners')
      .addTag('warehouses', 'Warehouses and storage locations')
      .addTag('vehicles', 'Fleet')
      .addTag('products', 'Catalogue')
      .addTag('inventory', 'Stock, movements and alerts')
      .addTag('purchase-orders', 'Procurement')
      .addTag('shipments', 'Shipments, events and tracking')
      .addTag('gps', 'Telemetry ingest and spatial queries')
      .addTag('deliveries', 'Delivery workflow and proof of delivery')
      .addTag('incidents', 'Incident management')
      .addTag('notifications', 'Alerts')
      .addTag('analytics', 'Dashboards and KPIs')
      .addTag('ai', 'ETA, delay, anomaly, forecasting and optimisation')
      .addTag('recommendations', 'Decision engine')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.log(`Swagger UI: http://localhost:${port}/${prefix}/docs`);
  }

  const host = config.get('host', { infer: true });
  await app.listen(port, host);
  logger.log(
    `SCIP API listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/${prefix}` +
      (host === '127.0.0.1' ? ' (this PC only)' : ' (local network enabled)'),
  );
}

/**
 * Serves a Next.js static export. It names pages `shipments.html` next to a `shipments/` folder
 * (for `shipments/detail.html`), and plain express.static would see the folder first and
 * redirect `/shipments` to a `/shipments/` that has no index. Page routes are therefore mapped
 * to their `.html` file before the static handler runs.
 */
function serveStaticExport(app: NestExpressApplication, rootDir: string): void {
  const root = resolve(rootDir);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || extname(req.path) !== '' || req.path === '/') return next();
    const page = resolve(root, `.${req.path.replace(/\/+$/, '')}.html`);
    // resolve() collapses any `..`; the prefix check keeps the result inside the export.
    if (!page.startsWith(root + sep) || !existsSync(page)) return next();
    // Relative to `root`: send() refuses dot-segments, and the install path itself may have one.
    res.sendFile(relative(root, page), { root });
  });
  app.useStaticAssets(root, { index: 'index.html', redirect: false });
}

void bootstrap();
