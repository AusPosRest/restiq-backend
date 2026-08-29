import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { KitchenController } from './tickets.controller'
import { KitchenTicketsService } from './tickets.service'

// AD-2 module boundaries: KitchenTicketsService is exported so pos/orders and
// pos/order-lines can invoke the fire hook inside their own transaction
// (AD-16) - PosModule imports this module for that; AppModule imports it too
// so KitchenController itself is wired up.
@Module({
  imports: [PlatformModule],
  controllers: [KitchenController],
  providers: [KitchenTicketsService],
  exports: [KitchenTicketsService],
})
export class KitchenModule {}
