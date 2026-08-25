import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { PosOrdersController } from './orders/orders.controller'
import { OrdersService } from './orders/orders.service'

@Module({
  imports: [PlatformModule],
  controllers: [PosOrdersController],
  providers: [OrdersService],
})
export class PosModule {}
