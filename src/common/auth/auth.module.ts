import { Module, DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthGuard } from './auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';
import { LocalAuthModule } from './local/local-auth.module';

@Module({})
export class AuthModule {
  static forRoot(): DynamicModule {
    const isDevelopment =
      (process.env.ENVIRONMENT || 'development') === 'development';

    if (isDevelopment) {
      return {
        module: AuthModule,
        imports: [LocalAuthModule],
        providers: [
          RolesGuard,
          {
            provide: APP_GUARD,
            useClass: AuthGuard,
          },
        ],
        exports: [RolesGuard],
      };
    }

    return {
      module: AuthModule,
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      providers: [
        JwtStrategy,
        RolesGuard,
        {
          provide: APP_GUARD,
          useClass: AuthGuard,
        },
      ],
      exports: [RolesGuard],
    };
  }
}
