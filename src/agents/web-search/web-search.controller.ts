import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator';
import { AskWebSearchDto } from '../dto/ask-web-search.dto';
import { WebSearchService } from './web-search.service';

@Controller('agents/web-search')
export class WebSearchController {
  constructor(private readonly webSearchService: WebSearchService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('ask')
  ask(@Body() dto: AskWebSearchDto) {
    const question = dto.question || dto.pergunta || dto.query || '';
    return this.webSearchService.ask(question);
  }
}
