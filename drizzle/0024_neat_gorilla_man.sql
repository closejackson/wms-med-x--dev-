CREATE TABLE `packagingLevels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(100) NOT NULL,
	`rank` int NOT NULL,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `packagingLevels_id` PRIMARY KEY(`id`),
	CONSTRAINT `packagingLevels_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `productConversions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`productId` int NOT NULL,
	`unitCode` varchar(20) NOT NULL,
	`factorToBase` decimal(18,6) NOT NULL,
	`roundingStrategy` enum('floor','ceil','round') NOT NULL DEFAULT 'round',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productConversions_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_conversion_unique` UNIQUE(`tenantId`,`productId`,`unitCode`)
);
--> statement-breakpoint
CREATE TABLE `unitAliases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`alias` varchar(50) NOT NULL,
	`targetCode` varchar(20) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `unitAliases_id` PRIMARY KEY(`id`),
	CONSTRAINT `unit_alias_tenant_unique` UNIQUE(`tenantId`,`alias`)
);
--> statement-breakpoint
CREATE TABLE `unitPendingQueue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`receivingOrderId` int,
	`nfeKey` varchar(44),
	`nfeNumber` varchar(20),
	`productCode` varchar(100) NOT NULL,
	`productDescription` varchar(500),
	`xmlUnit` varchar(50) NOT NULL,
	`reason` enum('no_alias','no_conversion','new_product') NOT NULL,
	`status` enum('pending','resolved','ignored') NOT NULL DEFAULT 'pending',
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `unitPendingQueue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD `originalUnit` varchar(50);--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD `originalQty` decimal(18,6);--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD `conversionFactor` decimal(18,6);--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD `conversionSource` enum('uTrib','uCom','manual','none');--> statement-breakpoint
CREATE INDEX `product_conversions_tenant_product_idx` ON `productConversions` (`tenantId`,`productId`);--> statement-breakpoint
CREATE INDEX `unit_aliases_tenant_idx` ON `unitAliases` (`tenantId`);--> statement-breakpoint
CREATE INDEX `unit_pending_tenant_idx` ON `unitPendingQueue` (`tenantId`);--> statement-breakpoint
CREATE INDEX `unit_pending_status_idx` ON `unitPendingQueue` (`status`);