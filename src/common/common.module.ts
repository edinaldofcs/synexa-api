import { Module, Global } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ClientMetadataService } from './metadata/client-metadata.service';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [ClientMetadataService],
  exports: [PrismaModule, RedisModule, ClientMetadataService],
})
export class CommonModule {}
