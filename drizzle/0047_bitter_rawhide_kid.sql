ALTER TABLE `inventories` ADD `currentPhase` enum('phase1','phase2','phase3') DEFAULT 'phase1' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventories` ADD `phase1HasDivergence` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inventories` ADD `phase2HasDivergence` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inventoryLocations` ADD `inventoryPhase` enum('phase1','phase2','phase3') DEFAULT 'phase1' NOT NULL;