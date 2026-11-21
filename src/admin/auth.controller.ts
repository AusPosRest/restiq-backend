import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AdminPrincipal, ClientIp, CurrentOwner, OwnerOnly, Public } from '../platform'
import { AcceptInviteDto, InviteDetailsDto, ServiceSessionDto } from './accept-invite.dto'
import { AcceptInviteResult, AdminAuthService, InviteDetails, OwnerSessionResult, ServiceSessionResult } from './auth.service'
import { LoginDto } from './login.dto'
import { ForgotPasswordDto, ResetPasswordDto } from './password-reset.dto'

@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  // issue #193: who the invite is for. POST so the token never sits in a URL or access log.
  @Public()
  @Post('invite-details')
  @HttpCode(200)
  inviteDetails(@Body() dto: InviteDetailsDto): Promise<InviteDetails> {
    return this.auth.inviteDetails(dto.token)
  }

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

  // #314 service mode: the web server swaps an ops handoff code for a 1 h session, at the tenant's own address.
  @Public()
  @Post('service-session')
  @HttpCode(200)
  serviceSession(@Body() dto: ServiceSessionDto, @Req() request: Request): Promise<ServiceSessionResult> {
    return this.auth.serviceSession(dto.code, request)
  }

  // restiq-backend#209: ends every session this owner holds (all browsers), same as operator logout (#203).
  // #314: owner only - it moves the owner's sessionVersion on, which an operator has none of.
  @OwnerOnly()
  @Post('logout')
  @HttpCode(204)
  logout(@CurrentOwner() owner: AdminPrincipal): Promise<void> {
    return this.auth.logout(owner)
  }
}
