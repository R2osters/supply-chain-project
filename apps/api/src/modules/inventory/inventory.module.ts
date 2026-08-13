import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryLedgerService } from './inventory-ledger.service';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryLedgerService, InventoryService],
  exports: [InventoryLedgerService, InventoryService],
})
export class InventoryModule {}
