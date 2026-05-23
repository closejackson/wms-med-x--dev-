import { getDb } from "./server/db";

const db = await getDb();
if (!db) {
  console.log("DB not available");
  process.exit(1);
}

try {
  await (db as any).execute(
    "ALTER TABLE systemUsers ADD COLUMN mustResetPassword boolean DEFAULT false NOT NULL"
  );
  console.log("Migration applied: mustResetPassword column added");
} catch (e: any) {
  if (e.message?.includes("Duplicate column") || e.message?.includes("already exists")) {
    console.log("Column already exists — skipping");
  } else {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

process.exit(0);
