import { Body, Controller, Header, Module, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/auth/public.decorator';
import { LandingChatDto } from './landing-chat.dto';
import { LandingChatService } from './landing-chat.service';

@Controller('landing')
export class LandingController {
  constructor(private readonly chat: LandingChatService) {}
  @Public()
  @Post('chat')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  reply(@Body() body: LandingChatDto) {
    return this.chat.reply(body);
  }
}
@Module({ controllers: [LandingController], providers: [LandingChatService] })
export class LandingModule {}
