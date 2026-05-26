import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { LocalAuthService } from './local-auth.service';

@Injectable()
export class LocalJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly localAuthService: LocalAuthService,
    private readonly configService: ConfigService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is required. Set it in your .env file.');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
      algorithms: ['HS256'],
      issuer: 'synexa-local',
    });
  }

  async validate(payload: {
    sub: string;
    email?: string;
    role?: string;
    company_id?: string;
  }) {
    const user = await this.localAuthService.validateUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Token inválido');
    }
    return {
      id: user.id,
      email: payload.email,
      role: user.role,
      company_id: user.company_id,
    };
  }
}
