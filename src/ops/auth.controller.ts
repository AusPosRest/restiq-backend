import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal, Public } from '../platform'
import { LoginResult, OpsAuthService } from './auth.service'
import { LoginDto } from './login.dto'

@Controller('ops/v1/auth')
export class OpsAuthController {
  constructor(private readonly auth: OpsAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password)
  }

  @Get('session')
  session(@CurrentOperator() operator: OpsPrincipal): { operator: OpsPrincipal } {
    return { operator }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentOperator() operator: OpsPrincipal): Promise<void> {
    await this.auth.logout(operator)
  }
}
