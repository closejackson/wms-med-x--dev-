CREATE TABLE `invoicePickingOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`pickingOrderId` int NOT NULL,
	`tenantId` int NOT NULL,
	`linkedAt` timestamp NOT NULL DEFAULT (now()),
	`linkedBy` int,
	CONSTRAINT `invoicePickingOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoicePickingOrders_unique_idx` UNIQUE(`invoiceId`,`pickingOrderId`)
);
--> statement-breakpoint
ALTER TABLE `tenants` ADD `intraHospitalEnabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `invoicePickingOrders_invoiceId_idx` ON `invoicePickingOrders` (`invoiceId`);--> statement-breakpoint
CREATE INDEX `invoicePickingOrders_pickingOrderId_idx` ON `invoicePickingOrders` (`pickingOrderId`);--> statement-breakpoint
CREATE INDEX `invoicePickingOrders_tenantId_idx` ON `invoicePickingOrders` (`tenantId`);