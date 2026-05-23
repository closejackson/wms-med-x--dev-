CREATE TABLE `productTenantMappings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`productId` int NOT NULL,
	`tenantId` int NOT NULL,
	`internalCode` varchar(100),
	`customerCode` varchar(100),
	`supplierCode` varchar(100),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productTenantMappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `productTenantMappings_productId_tenantId_unique` UNIQUE(`productId`,`tenantId`),
	CONSTRAINT `productTenantMappings_tenantId_internalCode_unique` UNIQUE(`tenantId`,`internalCode`)
);
--> statement-breakpoint
ALTER TABLE `products` DROP INDEX `products_tenantId_internalCode_unique`;--> statement-breakpoint
DROP INDEX `products_tenantId_sku_idx` ON `products`;--> statement-breakpoint
DROP INDEX `products_tenantId_status_idx` ON `products`;--> statement-breakpoint
DROP INDEX `products_supplierCode_idx` ON `products`;--> statement-breakpoint
DROP INDEX `products_customerCode_idx` ON `products`;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_sku_unique` UNIQUE(`sku`);--> statement-breakpoint
CREATE INDEX `ptm_productId_idx` ON `productTenantMappings` (`productId`);--> statement-breakpoint
CREATE INDEX `ptm_tenantId_idx` ON `productTenantMappings` (`tenantId`);--> statement-breakpoint
CREATE INDEX `idx_products_sku` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_products_internal_code` ON `products` (`internalCode`);--> statement-breakpoint
CREATE INDEX `products_status_idx` ON `products` (`status`);--> statement-breakpoint
CREATE INDEX `products_supplierCode_idx` ON `products` (`supplierCode`);--> statement-breakpoint
CREATE INDEX `products_customerCode_idx` ON `products` (`customerCode`);--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `tenantId`;