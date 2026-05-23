import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import mysql from "mysql2/promise";

const connection = await mysql.createConnection(process.env.DATABASE_URL);
const db = drizzle(connection);

try {
  await db.execute(sql`ALTER TABLE products DROP INDEX products_sku_unique`);
  console.log("OK: Constraint products_sku_unique removida.");
} catch (e) {
  console.error("Erro:", e.message);
}

await connection.end();
process.exit(0);
