ALTER TABLE `products` MODIFY COLUMN `storageCondition` enum('ambient','climatized_15_30','controlled_8_25','refrigerated_2_8','frozen_minus_20','controlled') NOT NULL DEFAULT 'ambient';--> statement-breakpoint
ALTER TABLE `products` ADD `specialTransportCategory` enum('thermoLabile_2_8','thermoLabile_extended_2_25','thermoStable_15_30','none') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `unitsPerPallet` int;--> statement-breakpoint
ALTER TABLE `products` ADD `lengthCm` decimal(8,2);--> statement-breakpoint
ALTER TABLE `products` ADD `widthCm` decimal(8,2);--> statement-breakpoint
ALTER TABLE `products` ADD `heightCm` decimal(8,2);--> statement-breakpoint
ALTER TABLE `products` ADD `minOrderQty` int DEFAULT 0;