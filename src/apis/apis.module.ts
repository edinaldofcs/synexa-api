import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ApisController } from './apis.controller';
import { ApisRepository } from './repositories/apis.repository';
import { ApisService } from './apis.service';

@Module({
  imports: [CommonModule],
  controllers: [ApisController],
  providers: [ApisService, ApisRepository],
  exports: [ApisService, ApisRepository],
})
export class ApisModule {}
