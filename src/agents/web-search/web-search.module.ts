import { Module, Global } from '@nestjs/common';
import { WebSearchService } from './web-search.service';
import { WebSearchController } from './web-search.controller';

@Global()
@Module({
  controllers: [WebSearchController],
  providers: [WebSearchService],
  exports: [WebSearchService],
})
export class WebSearchModule {}
