import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Public } from '../platform'
import { AcceptInviteDto } from './accept-invite.dto'
import { AcceptInviteResult, AdminAuthService, OwnerSessionResult } from './auth.service'
import { LoginDto } from './login.dto'

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
  login(@Body() dto: LoginDto): Promise<OwnerSessionResult> {
    return this.auth.login(dto.email, dto.password)
  }
}
