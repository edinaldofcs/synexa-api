import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { LocalAuthService } from './local-auth.service';
import { Public } from '../public.decorator';
import { LoginDto } from '../dto/login.dto';

@Controller('auth')
export class LocalAuthController {
  constructor(private readonly localAuthService: LocalAuthService) {}

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.localAuthService.login(body.email, body.password);
  }
}
