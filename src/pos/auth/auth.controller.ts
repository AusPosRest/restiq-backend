import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common'
import { AnyStaff, CurrentStaff, PosPrincipal, Public } from '../../platform'
import { PosLoginDto, PosLoginResult, SelectOutletDto } from './auth.dtos'
import { PosAuthService } from './auth.service'

@Controller('pos/v1/auth')
export class PosAuthController {
  constructor(private readonly auth: PosAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  // req.ip - the client address as resolved through TRUST_PROXY_HOPS (main.ts), never a raw X-Forwarded-For.
  login(@Body() dto: PosLoginDto, @Ip() ip: string): Promise<PosLoginResult> {
    return this.auth.login(dto, ip)
  }

  @Public()
  @Post('select-outlet')
  @HttpCode(200)
  selectOutlet(@Body() dto: SelectOutletDto): Promise<PosLoginResult> {
    return this.auth.selectOutlet(dto)
  }

  // restiq-backend#169: signs this staff member out on every device.
  @Post('logout')
  @AnyStaff()
  @HttpCode(204)
  logout(@CurrentStaff() staff: PosPrincipal): Promise<void> {
    return this.auth.logout(staff)
  }
}
