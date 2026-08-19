import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  const environment = configService.get<string>('ENVIRONMENT', 'development');
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  const corsOrigins = corsOrigin
    ? corsOrigin.split(',').map((s) => s.trim())
    : ['http://localhost:5173'];

  app.enableCors({
    origin: (origin, callback) => {
      // Permite requisições sem origin (como file://, Postman, cURL) ou qualquer origem em dev
      if (!origin || origin === 'null' || environment === 'development') {
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
      'x-signature',
      'x-timestamp',
      'x-synexa-signature',
      'idempotency-key',
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

  const bodyLimit = configService.get<string>('BODY_LIMIT', '1mb');
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
  console.log(`Backend NestJS rodando em ${await app.getUrl()}`);
}
bootstrap().catch((err) => console.error('Bootstrap Error:', err));
