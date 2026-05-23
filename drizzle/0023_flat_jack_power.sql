ALTER TABLE `inventory` DROP INDEX `unique_label_tenant_idx`;--> statement-breakpoint
DROP INDEX `blind_adj_session_idx` ON `blindConferenceAdjustments`;--> statement-breakpoint
ALTER TABLE `warehouseLocations` MODIFY COLUMN `status` enum('available','occupied','blocked','counting','quarantine') NOT NULL DEFAULT 'available';--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` ADD `conferenceId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` ADD `productId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` ADD `batch` varchar(100);--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` ADD `oldQuantity` int NOT NULL;--> statement-breakpoint
ALTER TABLE `inventoryMovements` ADD `expiryDate` date;--> statement-breakpoint
ALTER TABLE `stageChecks` ADD `lockedByUserId` int;--> statement-breakpoint
ALTER TABLE `stageChecks` ADD `lockedByName` varchar(200);--> statement-breakpoint
ALTER TABLE `stageChecks` ADD `lastActivityAt` timestamp;--> statement-breakpoint
CREATE INDEX `blind_adj_conference_idx` ON `blindConferenceAdjustments` (`conferenceId`);--> statement-breakpoint
CREATE INDEX `label_code_tenant_idx` ON `inventory` (`labelCode`,`tenantId`);--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` DROP COLUMN `sessionId`;--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` DROP COLUMN `associationId`;--> statement-breakpoint
ALTER TABLE `blindConferenceAdjustments` DROP COLUMN `previousQuantity`;