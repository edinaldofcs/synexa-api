import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CookieWsAdapter } from './common/ws/cookie-ws.adapter';
import { ValidationPipe, Logger } from '@nestjs/common';
import * as express from 'express';
import { AppModule } from './app.module';
import { WorkerModule } from './worker.module';
import { VoiceStandaloneModule } from './voice.module';
import { ServiceRole } from './common/config/env.validation';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const serviceRole = (
    process.env.SERVICE_ROLE || ServiceRole.API
  ).toLowerCase();

  logger.log(`🚀 Iniciando Synexa Runtime com SERVICE_ROLE: "${serviceRole}"`);

  // ── Cenário 1: Workers Assíncronos (Standalone Context sem HTTP) ──
  if (serviceRole === ServiceRole.WORKER || serviceRole.startsWith('worker-')) {
    const app = await NestFactory.createApplicationContext(WorkerModule);
    app.enableShutdownHooks();

    logger.log(
      `⚙️  Worker Synexa (${serviceRole}) iniciado com sucesso. Aguardando jobs...`,
    );

    const handleShutdown = async (signal: string) => {
      logger.log(
        `🛑 Recebido sinal ${signal}. Encerrando worker de forma controlada...`,
      );
      await app.close();
      logger.log('👋 Worker encerrado com sucesso.');
      process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    return;
  }

  // ── Cenário 2: Voice Gateway Isolado ──
  if (serviceRole === ServiceRole.VOICE) {
    const app = await NestFactory.create(VoiceStandaloneModule);
    app.useWebSocketAdapter(new CookieWsAdapter(app));
    app.enableShutdownHooks();

    const configService = app.get(ConfigService);
    const port = configService.get<number>('VOICE_PORT', 3001);

    await app.listen(port, '0.0.0.0');
    logger.log(`🎙️  Synexa Voice Gateway rodando na porta ${port} (/ws/voice)`);
    return;
  }

  // ── Cenário 3: API HTTP Principal (Padrão) ──
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new CookieWsAdapter(app));
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const environment = configService.get<string>('ENVIRONMENT', 'development');
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  const corsOrigins = corsOrigin
    ? corsOrigin.split(',').map((s) => s.trim())
    : ['http://localhost:5173'];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      // Origin "null" (iframes sandboxed, redirects) com credentials:true
      // só é aceito em development
      if (origin === 'null') {
        if (environment === 'development') {
          return callback(null, true);
        }
        return callback(new Error('Bloqueado por CORS'));
      }
      if (environment === 'development') {
        return callback(null, true);
      }
      if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error('Bloqueado por CORS'));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'x-signature',
      'x-timestamp',
      'x-synexa-signature',
      'idempotency-key',
      'x-request-id',
    ],
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.setGlobalPrefix('api');

  if (environment === 'development') {
    app.use('/uploads', express.static('uploads'));
  }

  const bodyLimit = configService.get<string>('BODY_LIMIT', '5mb');
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ limit: bodyLimit, extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`🌐 Synexa API rodando em ${await app.getUrl()}`);
}

bootstrap().catch((err) => {
  logger.error('Bootstrap Error:', err);
  process.exit(1);
});
