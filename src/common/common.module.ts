import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ClientMetadataService } from './metadata/client-metadata.service';
import { CredentialAuditService } from './services/credential-audit.service';
import { CrmDataTransformerService } from './services/crm-data-transformer.service';
import { InboundDataMapperService } from './services/inbound-data-mapper.service';
import { TenantInterceptor } from './interceptors/tenant.interceptor';
import { CorrelationInterceptor } from './interceptors/correlation.interceptor';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [HealthController],
  providers: [
    ClientMetadataService,
    CredentialAuditService,
    CrmDataTransformerService,
    InboundDataMapperService,
    HealthService,
    {
      provide: APP_INTERCEPTOR,
      useClass: CorrelationInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
  ],
  exports: [
    PrismaModule,
    RedisModule,
    ClientMetadataService,
    CredentialAuditService,
    CrmDataTransformerService,
    InboundDataMapperService,
    HealthService,
  ],
})
export class CommonModule {}
