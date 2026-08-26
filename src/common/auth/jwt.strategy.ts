import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const supabaseUrl = configService.get<string>('SUPABASE_URL', '');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      }),
      algorithms: ['ES256', 'RS256'],
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    });
  }

  async validate(payload: { sub: string; email?: string; role?: string }) {
    const dbUser = await this.prisma.users.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        company_id: true,
        companies: { select: { status: true } },
      },
    });

    if (!dbUser || dbUser.companies.status !== 'active') {
      throw new UnauthorizedException('Usuário não autorizado');
    }

    return {
      id: payload.sub,
      email: dbUser.email ?? payload.email,
      role: dbUser.role,
      company_id: dbUser.company_id,
    };
  }
}
