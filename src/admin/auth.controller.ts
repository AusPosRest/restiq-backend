import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Public } from '../platform'
import { AcceptInviteDto } from './accept-invite.dto'
import { AcceptInviteResult, AdminAuthService } from './auth.service'

@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto): Promise<AcceptInviteResult> {
    return this.auth.acceptInvite(dto.token, dto.password)
  }
}
