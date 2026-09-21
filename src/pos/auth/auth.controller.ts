import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { AnyStaff, ClientIp, CurrentStaff, PosPrincipal, Public } from '../../platform'
import { PosLoginDto, PosLoginResult, SelectOutletDto } from './auth.dtos'
import { PosAuthService } from './auth.service'

@Controller('pos/v1/auth')
export class PosAuthController {
  constructor(private readonly auth: PosAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  // The browser's address as passed by our own web server, else req.ip - see platform/client-ip.ts.
  login(@Body() dto: PosLoginDto, @ClientIp() ip: string): Promise<PosLoginResult> {
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
