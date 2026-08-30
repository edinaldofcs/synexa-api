import { Module, DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthGuard } from './auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';
import { LocalAuthModule } from './local/local-auth.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Module({})
export class AuthModule {
  static forRoot(): DynamicModule {
    const isDevelopment = process.env.ENVIRONMENT === 'development';

    if (isDevelopment) {
      return {
        module: AuthModule,
        imports: [LocalAuthModule],
        controllers: [AuthController],
        providers: [
          AuthService,
          SessionService,
          RolesGuard,
          {
            provide: APP_GUARD,
            useClass: AuthGuard,
          },
          {
            provide: APP_GUARD,
            useClass: RolesGuard,
          },
        ],
        exports: [RolesGuard],
      };
    }

    return {
      module: AuthModule,
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [AuthController],
      providers: [
        AuthService,
        SessionService,
        JwtStrategy,
        RolesGuard,
        {
          provide: APP_GUARD,
          useClass: AuthGuard,
        },
        {
          provide: APP_GUARD,
          useClass: RolesGuard,
        },
      ],
      exports: [RolesGuard],
    };
  }
}
