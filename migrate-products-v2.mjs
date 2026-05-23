import { createConnection } from "mysql2/promise";

const db = await createConnection(process.env.DATABASE_URL);

const migrations = [
  `ALTER TABLE \`products\` MODIFY COLUMN \`storageCondition\` enum('ambient','climatized_15_30','controlled_8_25','refrigerated_2_8','frozen_minus_20','controlled') NOT NULL DEFAULT 'ambient'`,
  `ALTER TABLE \`products\` ADD COLUMN \`specialTransportCategory\` enum('thermoLabile_2_8','thermoLabile_extended_2_25','thermoStable_15_30','none') DEFAULT 'none' NOT NULL`,
  `ALTER TABLE \`products\` ADD COLUMN \`unitsPerPallet\` int`,
  `ALTER TABLE \`products\` ADD COLUMN \`lengthCm\` decimal(8,2)`,
  `ALTER TABLE \`products\` ADD COLUMN \`widthCm\` decimal(8,2)`,
  `ALTER TABLE \`products\` ADD COLUMN \`heightCm\` decimal(8,2)`,
  `ALTER TABLE \`products\` ADD COLUMN \`minOrderQty\` int DEFAULT 0`,
];

for (const sql of migrations) {
  try {
    await db.execute(sql);
    console.log("✓", sql.substring(0, 70));
  } catch (e) {
    if (e.code === "ER_DUP_FIELDNAME" || e.message.includes("Duplicate column")) {
      console.log("⚠ Already exists:", sql.substring(0, 70));
    } else {
      console.log("✗ Error:", e.message.substring(0, 100));
    }
  }
}

await db.end();
console.log("Migration complete.");
