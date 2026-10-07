import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { ClientIp, Public } from '../platform'
import { AcceptInviteDto } from './accept-invite.dto'
import { AcceptInviteResult, AdminAuthService, OwnerSessionResult } from './auth.service'
import { LoginDto } from './login.dto'
import { ForgotPasswordDto, ResetPasswordDto } from './password-reset.dto'

@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto): Promise<AcceptInviteResult> {
    return this.auth.acceptInvite(dto.token, dto.password)
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @ClientIp() ip: string): Promise<OwnerSessionResult> {
    return this.auth.login(dto.email, dto.password, ip)
  }

  // Always 202: it never says whether the email is registered.
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  forgotPassword(@Body() dto: ForgotPasswordDto, @ClientIp() ip: string): Promise<{ accepted: true }> {
    return this.auth.forgotPassword(dto.email, ip)
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.password)
  }
}
