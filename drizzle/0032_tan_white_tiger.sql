CREATE TABLE `blindConferenceGroupOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`groupId` int NOT NULL,
	`receivingOrderId` int NOT NULL,
	`tenantId` int NOT NULL,
	`fifoOrder` int NOT NULL DEFAULT 0,
	`linkedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `blindConferenceGroupOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `blindConfGroupOrders_unique_idx` UNIQUE(`groupId`,`receivingOrderId`)
);
--> statement-breakpoint
CREATE TABLE `blindConferenceGroupScans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`groupId` int NOT NULL,
	`tenantId` int NOT NULL,
	`productId` int NOT NULL,
	`labelCode` varchar(100) NOT NULL,
	`uniqueCode` varchar(200) NOT NULL,
	`batch` varchar(100),
	`expiryDate` date,
	`unitsPerBox` int NOT NULL DEFAULT 1,
	`unitsRead` int NOT NULL DEFAULT 1,
	`scannedBy` int NOT NULL,
	`scannedAt` timestamp NOT NULL DEFAULT (now()),
	`isUndone` boolean NOT NULL DEFAULT false,
	CONSTRAINT `blindConferenceGroupScans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `blindConferenceGroups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`groupNumber` varchar(50) NOT NULL,
	`startedBy` int NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	`finishedBy` int,
	`status` enum('active','completed','cancelled') NOT NULL DEFAULT 'active',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `blindConferenceGroups_id` PRIMARY KEY(`id`),
	CONSTRAINT `blindConferenceGroups_groupNumber_unique` UNIQUE(`groupNumber`)
);
--> statement-breakpoint
CREATE INDEX `blindConfGroupOrders_groupId_idx` ON `blindConferenceGroupOrders` (`groupId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupOrders_orderId_idx` ON `blindConferenceGroupOrders` (`receivingOrderId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupOrders_tenantId_idx` ON `blindConferenceGroupOrders` (`tenantId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupScans_groupId_idx` ON `blindConferenceGroupScans` (`groupId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupScans_productId_idx` ON `blindConferenceGroupScans` (`productId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupScans_tenantId_idx` ON `blindConferenceGroupScans` (`tenantId`);--> statement-breakpoint
CREATE INDEX `blindConfGroupScans_labelCode_idx` ON `blindConferenceGroupScans` (`labelCode`);--> statement-breakpoint
CREATE INDEX `blindConfGroupScans_groupProduct_idx` ON `blindConferenceGroupScans` (`groupId`,`productId`);--> statement-breakpoint
CREATE INDEX `blindConfGroups_tenantId_idx` ON `blindConferenceGroups` (`tenantId`);--> statement-breakpoint
CREATE INDEX `blindConfGroups_status_idx` ON `blindConferenceGroups` (`status`);--> statement-breakpoint
CREATE INDEX `blindConfGroups_tenantId_status_idx` ON `blindConferenceGroups` (`tenantId`,`status`);