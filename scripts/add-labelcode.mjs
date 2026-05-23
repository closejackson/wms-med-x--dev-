import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  try {
    // Verificar se a coluna já existe
    const [rows] = await db.execute(sql`SHOW COLUMNS FROM pickingAllocations LIKE 'labelCode'`);
    if (rows.length > 0) {
      console.log("Coluna labelCode já existe em pickingAllocations.");
    } else {
      await db.execute(sql`ALTER TABLE pickingAllocations ADD COLUMN labelCode VARCHAR(100) NULL AFTER uniqueCode`);
      console.log("Coluna labelCode adicionada com sucesso em pickingAllocations.");
    }

    // Verificar índice
    const [idxRows] = await db.execute(sql`SHOW INDEX FROM pickingAllocations WHERE Key_name = 'pickingAllocations_labelCode_idx'`);
    if (idxRows.length === 0) {
      await db.execute(sql`CREATE INDEX pickingAllocations_labelCode_idx ON pickingAllocations (labelCode)`);
      console.log("Índice pickingAllocations_labelCode_idx criado.");
    } else {
      console.log("Índice já existe.");
    }
  } catch (err) {
    console.error("Erro:", err.message);
    process.exit(1);
  }
  process.exit(0);
}

run();
