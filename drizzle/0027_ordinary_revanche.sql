CREATE TABLE `deliveryLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`orderId` int NOT NULL,
	`deliveryPointId` int NOT NULL,
	`status` enum('ARRIVED_COMPLEX','DEPARTED_TO_UNIT','ARRIVED_UNIT','RECEIVING_STARTED','RECEIVE_COMPLETE') NOT NULL,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`userId` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deliveryLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deliveryPoints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`type` enum('DOCK','PHARMACY') NOT NULL,
	`externalCode` varchar(100) NOT NULL,
	`description` text,
	`floor` varchar(50),
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deliveryPoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `products` DROP INDEX `products_tenantId_sku_unique`;--> statement-breakpoint
ALTER TABLE `products` ADD `internalCode` varchar(100);--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_tenantId_internalCode_unique` UNIQUE(`tenantId`,`internalCode`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_tenantId_idx` ON `deliveryLogs` (`tenantId`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_orderId_idx` ON `deliveryLogs` (`orderId`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_tenantId_orderId_idx` ON `deliveryLogs` (`tenantId`,`orderId`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_deliveryPointId_idx` ON `deliveryLogs` (`deliveryPointId`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_status_idx` ON `deliveryLogs` (`status`);--> statement-breakpoint
CREATE INDEX `deliveryLogs_timestamp_idx` ON `deliveryLogs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `deliveryPoints_tenantId_idx` ON `deliveryPoints` (`tenantId`);--> statement-breakpoint
CREATE INDEX `deliveryPoints_tenantId_type_idx` ON `deliveryPoints` (`tenantId`,`type`);--> statement-breakpoint
CREATE INDEX `deliveryPoints_externalCode_idx` ON `deliveryPoints` (`tenantId`,`externalCode`);--> statement-breakpoint
CREATE INDEX `blindConferenceItems_tenantId_idx` ON `blindConferenceItems` (`tenantId`);--> statement-breakpoint
CREATE INDEX `blindConferenceSessions_tenantId_idx` ON `blindConferenceSessions` (`tenantId`);--> statement-breakpoint
CREATE INDEX `blindConferenceSessions_tenantId_status_idx` ON `blindConferenceSessions` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `contracts_tenantId_idx` ON `contracts` (`tenantId`);--> statement-breakpoint
CREATE INDEX `contracts_tenantId_status_idx` ON `contracts` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `inventory_tenantId_status_idx` ON `inventory` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `inventory_tenantId_locationId_idx` ON `inventory` (`tenantId`,`locationId`);--> statement-breakpoint
CREATE INDEX `inventory_batch_idx` ON `inventory` (`tenantId`,`batch`);--> statement-breakpoint
CREATE INDEX `inventory_expiryDate_idx` ON `inventory` (`tenantId`,`expiryDate`);--> statement-breakpoint
CREATE INDEX `inventory_quantity_idx` ON `inventory` (`tenantId`,`quantity`);--> statement-breakpoint
CREATE INDEX `inventoryMovements_tenantId_movementType_idx` ON `inventoryMovements` (`tenantId`,`movementType`);--> statement-breakpoint
CREATE INDEX `inventoryMovements_labelCode_idx` ON `inventoryMovements` (`labelCode`);--> statement-breakpoint
CREATE INDEX `inventoryMovements_referenceId_idx` ON `inventoryMovements` (`referenceType`,`referenceId`);--> statement-breakpoint
CREATE INDEX `invoices_tenantId_idx` ON `invoices` (`tenantId`);--> statement-breakpoint
CREATE INDEX `invoices_tenantId_status_idx` ON `invoices` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_pickingOrderId_idx` ON `invoices` (`pickingOrderId`);--> statement-breakpoint
CREATE INDEX `invoices_invoiceNumber_idx` ON `invoices` (`tenantId`,`invoiceNumber`);--> statement-breakpoint
CREATE INDEX `labelAssociations_tenantId_productId_idx` ON `labelAssociations` (`tenantId`,`productId`);--> statement-breakpoint
CREATE INDEX `labelAssociations_tenantId_status_idx` ON `labelAssociations` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `labelAssociations_batch_idx` ON `labelAssociations` (`tenantId`,`batch`);--> statement-breakpoint
CREATE INDEX `pickingAllocations_waveId_idx` ON `pickingAllocations` (`waveId`);--> statement-breakpoint
CREATE INDEX `pickingAllocations_productId_idx` ON `pickingAllocations` (`productId`);--> statement-breakpoint
CREATE INDEX `pickingAllocations_status_idx` ON `pickingAllocations` (`pickingOrderId`,`status`);--> statement-breakpoint
CREATE INDEX `pickingAllocations_labelCode_idx` ON `pickingAllocations` (`labelCode`);--> statement-breakpoint
CREATE INDEX `pickingOrderItems_pickingOrderId_idx` ON `pickingOrderItems` (`pickingOrderId`);--> statement-breakpoint
CREATE INDEX `pickingOrderItems_productId_idx` ON `pickingOrderItems` (`productId`);--> statement-breakpoint
CREATE INDEX `pickingOrderItems_status_idx` ON `pickingOrderItems` (`pickingOrderId`,`status`);--> statement-breakpoint
CREATE INDEX `pickingOrders_tenantId_idx` ON `pickingOrders` (`tenantId`);--> statement-breakpoint
CREATE INDEX `pickingOrders_tenantId_status_idx` ON `pickingOrders` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `pickingOrders_tenantId_shippingStatus_idx` ON `pickingOrders` (`tenantId`,`shippingStatus`);--> statement-breakpoint
CREATE INDEX `pickingOrders_customerOrderNumber_idx` ON `pickingOrders` (`customerOrderNumber`);--> statement-breakpoint
CREATE INDEX `pickingOrders_waveId_idx` ON `pickingOrders` (`waveId`);--> statement-breakpoint
CREATE INDEX `pickingOrders_nfeKey_idx` ON `pickingOrders` (`nfeKey`);--> statement-breakpoint
CREATE INDEX `pickingWaveItems_status_idx` ON `pickingWaveItems` (`waveId`,`status`);--> statement-breakpoint
CREATE INDEX `pickingWaveItems_labelCode_idx` ON `pickingWaveItems` (`labelCode`);--> statement-breakpoint
CREATE INDEX `pickingWaves_tenantId_status_idx` ON `pickingWaves` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `products_tenantId_sku_idx` ON `products` (`tenantId`,`sku`);--> statement-breakpoint
CREATE INDEX `products_tenantId_status_idx` ON `products` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `products_gtin_idx` ON `products` (`gtin`);--> statement-breakpoint
CREATE INDEX `products_supplierCode_idx` ON `products` (`tenantId`,`supplierCode`);--> statement-breakpoint
CREATE INDEX `products_customerCode_idx` ON `products` (`tenantId`,`customerCode`);--> statement-breakpoint
CREATE INDEX `receivingOrderItems_tenantId_idx` ON `receivingOrderItems` (`tenantId`);--> statement-breakpoint
CREATE INDEX `receivingOrderItems_receivingOrderId_idx` ON `receivingOrderItems` (`receivingOrderId`);--> statement-breakpoint
CREATE INDEX `receivingOrderItems_productId_idx` ON `receivingOrderItems` (`productId`);--> statement-breakpoint
CREATE INDEX `receivingOrderItems_status_idx` ON `receivingOrderItems` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `receivingOrders_tenantId_idx` ON `receivingOrders` (`tenantId`);--> statement-breakpoint
CREATE INDEX `receivingOrders_tenantId_status_idx` ON `receivingOrders` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `receivingOrders_nfeKey_idx` ON `receivingOrders` (`nfeKey`);--> statement-breakpoint
CREATE INDEX `shipmentManifestItems_manifestId_idx` ON `shipmentManifestItems` (`manifestId`);--> statement-breakpoint
CREATE INDEX `shipmentManifestItems_pickingOrderId_idx` ON `shipmentManifestItems` (`pickingOrderId`);--> statement-breakpoint
CREATE INDEX `shipmentManifestItems_invoiceId_idx` ON `shipmentManifestItems` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `shipmentManifests_tenantId_idx` ON `shipmentManifests` (`tenantId`);--> statement-breakpoint
CREATE INDEX `shipmentManifests_tenantId_status_idx` ON `shipmentManifests` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `stageChecks_tenantId_status_idx` ON `stageChecks` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `stageChecks_customerOrderNumber_idx` ON `stageChecks` (`customerOrderNumber`);--> statement-breakpoint
CREATE INDEX `systemUsers_tenantId_idx` ON `systemUsers` (`tenantId`);--> statement-breakpoint
CREATE INDEX `systemUsers_active_idx` ON `systemUsers` (`tenantId`,`active`);--> statement-breakpoint
CREATE INDEX `unitPendingQueue_tenantId_status_idx` ON `unitPendingQueue` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `unitPendingQueue_productCode_idx` ON `unitPendingQueue` (`tenantId`,`productCode`);--> statement-breakpoint
CREATE INDEX `unitPendingQueue_receivingOrderId_idx` ON `unitPendingQueue` (`receivingOrderId`);--> statement-breakpoint
CREATE INDEX `users_tenantId_idx` ON `users` (`tenantId`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX `warehouseLocations_tenantId_zoneCode_idx` ON `warehouseLocations` (`tenantId`,`zoneCode`);--> statement-breakpoint
CREATE INDEX `warehouseLocations_code_idx` ON `warehouseLocations` (`code`);