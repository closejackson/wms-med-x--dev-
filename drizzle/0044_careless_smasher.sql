CREATE TABLE `inventories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int,
	`inventoryNumber` varchar(50) NOT NULL,
	`inventoryType` enum('cyclic','general') NOT NULL,
	`referenceDate` date,
	`startDate` timestamp NOT NULL,
	`endDate` timestamp,
	`status` enum('pending','in_progress','completed','cancelled') NOT NULL DEFAULT 'pending',
	`notes` text,
	`cancellationReason` text,
	`cancelledBy` int,
	`cancelledAt` timestamp,
	`totalLocations` int NOT NULL DEFAULT 0,
	`countedLocations` int NOT NULL DEFAULT 0,
	`divergentLocations` int NOT NULL DEFAULT 0,
	`accuracy` varchar(10),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `inventories_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventories_inventoryNumber_unique` UNIQUE(`inventoryNumber`)
);
--> statement-breakpoint
CREATE TABLE `inventoryAuditLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryId` int NOT NULL,
	`inventoryLocationId` int,
	`action` enum('created','started','location_counted','divergence_detected','recount_requested','divergence_resolved','location_blocked','completed','cancelled') NOT NULL,
	`locationId` int,
	`locationCode` varchar(50),
	`productId` int,
	`batch` varchar(50),
	`expectedQuantity` int,
	`countedQuantity` int,
	`performedBy` int NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventoryAuditLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventoryCountAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryLocationId` int NOT NULL,
	`inventoryId` int NOT NULL,
	`locationId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`productId` int NOT NULL,
	`productSku` varchar(100),
	`productDescription` varchar(255),
	`batch` varchar(50),
	`expiryDate` date,
	`expectedQuantity` int NOT NULL DEFAULT 0,
	`countedQuantity` int NOT NULL DEFAULT 0,
	`variance` int NOT NULL DEFAULT 0,
	`countedBy` int NOT NULL,
	`countedAt` timestamp NOT NULL DEFAULT (now()),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventoryCountAttempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventoryDivergences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryId` int NOT NULL,
	`inventoryLocationId` int NOT NULL,
	`locationId` int NOT NULL,
	`locationCode` varchar(50) NOT NULL,
	`productId` int NOT NULL,
	`productSku` varchar(100),
	`productDescription` varchar(255),
	`batch` varchar(50),
	`expiryDate` date,
	`tenantId` int,
	`expectedQuantity` int NOT NULL,
	`countedQuantity` int NOT NULL,
	`variance` int NOT NULL,
	`divergenceType` enum('surplus','shortage') NOT NULL,
	`resolution` enum('pending','movement_order_created','adjusted','cancelled') NOT NULL DEFAULT 'pending',
	`movementOrderId` int,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `inventoryDivergences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventoryLocations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryId` int NOT NULL,
	`locationId` int NOT NULL,
	`locationCode` varchar(50) NOT NULL,
	`status` enum('pending','counting','counted','divergent','blocked') NOT NULL DEFAULT 'pending',
	`countAttempts` int NOT NULL DEFAULT 0,
	`isBlocked` boolean NOT NULL DEFAULT false,
	`blockedAt` timestamp,
	`countedBy` int,
	`countedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `inventoryLocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','operator','quality','manager','supervisor') NOT NULL DEFAULT 'user';--> statement-breakpoint
CREATE INDEX `inventories_tenant_status_idx` ON `inventories` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `inventories_number_idx` ON `inventories` (`inventoryNumber`);--> statement-breakpoint
CREATE INDEX `inventoryAuditLog_inventoryId_idx` ON `inventoryAuditLog` (`inventoryId`);--> statement-breakpoint
CREATE INDEX `inventoryAuditLog_createdAt_idx` ON `inventoryAuditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX `inventoryCountAttempts_invLoc_idx` ON `inventoryCountAttempts` (`inventoryLocationId`);--> statement-breakpoint
CREATE INDEX `inventoryCountAttempts_invId_idx` ON `inventoryCountAttempts` (`inventoryId`);--> statement-breakpoint
CREATE INDEX `inventoryDivergences_inventoryId_idx` ON `inventoryDivergences` (`inventoryId`);--> statement-breakpoint
CREATE INDEX `inventoryDivergences_locationId_idx` ON `inventoryDivergences` (`locationId`);--> statement-breakpoint
CREATE INDEX `inventoryDivergences_resolution_idx` ON `inventoryDivergences` (`resolution`);--> statement-breakpoint
CREATE INDEX `inventoryLocations_inventoryId_idx` ON `inventoryLocations` (`inventoryId`);--> statement-breakpoint
CREATE INDEX `inventoryLocations_locationId_idx` ON `inventoryLocations` (`locationId`);--> statement-breakpoint
CREATE INDEX `inventoryLocations_inv_loc_idx` ON `inventoryLocations` (`inventoryId`,`locationId`);