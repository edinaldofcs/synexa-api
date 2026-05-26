import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  const corsOrigins = corsOrigin
    ? corsOrigin.split(',').map((s) => s.trim())
    : ['http://localhost:5173'];

  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.use(helmet());

  app.setGlobalPrefix('api');

  const environment = configService.get<string>('ENVIRONMENT', 'development');
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
