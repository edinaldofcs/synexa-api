import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ClientMetadataService } from './metadata/client-metadata.service';
import { TenantInterceptor } from './interceptors/tenant.interceptor';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    ClientMetadataService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
  ],
  exports: [PrismaModule, RedisModule, ClientMetadataService],
})
export class CommonModule {}
