import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../../prisma/prisma.module';
import { LocalAuthService } from './local-auth.service';
import { LocalJwtStrategy } from './local-jwt.strategy';

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is required. Set it in your .env file.');
        }
        if (secret.length < 32) {
          console.warn(
            '[LocalAuthModule] WARNING: JWT_SECRET has less than 32 characters. Use a stronger secret.',
          );
        }
        return {
          secret,
          signOptions: {
            expiresIn: '24h',
            issuer: 'synexa-local',
            algorithm: 'HS256' as const,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [],
  providers: [LocalAuthService, LocalJwtStrategy],
  exports: [LocalAuthService, JwtModule, PassportModule],
})
export class LocalAuthModule {}
