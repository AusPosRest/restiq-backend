import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Public } from '../../platform'
import { PosLoginDto, PosLoginResult, SelectOutletDto } from './auth.dtos'
import { PosAuthService } from './auth.service'

@Controller('pos/v1/auth')
export class PosAuthController {
  constructor(private readonly auth: PosAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: PosLoginDto): Promise<PosLoginResult> {
    return this.auth.login(dto)
  }

  @Public()
  @Post('select-outlet')
  @HttpCode(200)
  selectOutlet(@Body() dto: SelectOutletDto): Promise<PosLoginResult> {
    return this.auth.selectOutlet(dto)
  }
}
