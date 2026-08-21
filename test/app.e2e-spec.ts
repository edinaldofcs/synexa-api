import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { RedisService } from '../src/common/redis/redis.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.ENVIRONMENT = 'development';
    process.env.JWT_SECRET = 'synexa-dev-jwt-secret-nao-usar-em-producao-2026';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RedisService)
      .useValue({
        set: jest.fn(),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn(),
        acquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn(),
        checkRateLimit: jest.fn().mockResolvedValue({
          allowed: true,
          remaining: 99,
          resetAt: new Date(),
        }),
        rpush: jest.fn(),
        lrange: jest.fn().mockResolvedValue([]),
        quit: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health-test (GET)', () => {
    return request(app.getHttpServer())
      .get('/health-test')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.message).toBe('Backend está funcionando!');
      });
  });
});

