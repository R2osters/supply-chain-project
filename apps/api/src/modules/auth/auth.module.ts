import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { LocalRecoveryGuard } from './local-recovery.guard';
import { LocalRecoveryService } from './local-recovery.service';
import { PasswordService } from './password.service';
import { TemporaryPasswordService } from './temporary-password.service';
import { TokenService } from './token.service';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtStrategy,
    TemporaryPasswordService,
    LocalRecoveryService,
    LocalRecoveryGuard,
  ],
  exports: [AuthService, PasswordService, TokenService, TemporaryPasswordService],
})
export class AuthModule {}
