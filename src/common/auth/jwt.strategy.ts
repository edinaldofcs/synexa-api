import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';

const SUPABASE_URL = process.env.SUPABASE_URL || '';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
      }),
      algorithms: ['RS256'],
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
  }

  async validate(payload: { sub: string; email?: string; role?: string }) {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
