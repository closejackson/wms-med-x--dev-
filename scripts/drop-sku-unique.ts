import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import mysql from "mysql2/promise";

async function main() {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const db = drizzle(connection);

  // Verificar índices existentes
  const [rows] = await db.execute(sql`SHOW INDEX FROM products`);
  console.log("Índices atuais:", JSON.stringify((rows as any[]).map((r: any) => ({ key: r.Key_name, col: r.Column_name, nonUnique: r.Non_unique }))));

  // Tentar remover o índice unique de sku
  try {
    await db.execute(sql`ALTER TABLE products DROP INDEX products_sku_unique`);
    console.log("OK: Constraint products_sku_unique removida.");
  } catch (e: any) {
    console.error("Erro ao remover constraint:", e.message);
    // Tentar nome alternativo
    try {
      await db.execute(sql`ALTER TABLE products DROP INDEX sku`);
      console.log("OK: Constraint sku removida.");
    } catch (e2: any) {
      console.error("Erro alternativo:", e2.message);
    }
  }

  await connection.end();
}

main().catch(console.error);
