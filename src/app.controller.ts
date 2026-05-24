import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/public.decorator';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('health-test')
  healthTest() {
    return {
      status: 'ok',
      message: 'Backend está funcionando!',
      timestamp: new Date().toISOString(),
    };
  }
}
