ALTER TABLE `pickingOrders` ADD `orderType` enum('customer_order','inventory_surplus') DEFAULT 'customer_order' NOT NULL;--> statement-breakpoint
ALTER TABLE `pickingOrders` ADD `inventoryId` int;