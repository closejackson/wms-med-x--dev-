import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  // Ver definição atual das colunas
  const [cols] = await db.execute(sql`SHOW COLUMNS FROM pickingAllocations`);
  console.log("Colunas atuais:");
  for (const col of cols) {
    console.log(`  ${col.Field}: ${col.Type} | Null: ${col.Null} | Default: ${col.Default}`);
  }

  // Corrigir waveId: deve ser INT NULL (sem NOT NULL)
  const waveIdCol = cols.find(c => c.Field === 'waveId');
  if (waveIdCol && waveIdCol.Null === 'NO') {
    console.log("\nCorrigindo waveId para NULL...");
    await db.execute(sql`ALTER TABLE pickingAllocations MODIFY COLUMN waveId INT NULL`);
    console.log("waveId corrigido.");
  } else if (!waveIdCol) {
    console.log("\nAdicionando coluna waveId...");
    await db.execute(sql`ALTER TABLE pickingAllocations ADD COLUMN waveId INT NULL AFTER pickingOrderId`);
    console.log("waveId adicionado.");
  } else {
    console.log("\nwaveId já está NULL OK.");
  }

  // Corrigir inventoryId: deve ser INT NULL
  const invCol = cols.find(c => c.Field === 'inventoryId');
  if (invCol && invCol.Null === 'NO') {
    console.log("Corrigindo inventoryId para NULL...");
    await db.execute(sql`ALTER TABLE pickingAllocations MODIFY COLUMN inventoryId INT NULL`);
    console.log("inventoryId corrigido.");
  } else if (!invCol) {
    console.log("Adicionando coluna inventoryId...");
    await db.execute(sql`ALTER TABLE pickingAllocations ADD COLUMN inventoryId INT NULL AFTER waveId`);
    console.log("inventoryId adicionado.");
  } else {
    console.log("inventoryId já está NULL OK.");
  }

  // Corrigir labelCode: deve ser VARCHAR(100) NULL
  const labelCol = cols.find(c => c.Field === 'labelCode');
  if (!labelCol) {
    console.log("Adicionando coluna labelCode...");
    await db.execute(sql`ALTER TABLE pickingAllocations ADD COLUMN labelCode VARCHAR(100) NULL AFTER uniqueCode`);
    console.log("labelCode adicionado.");
  } else {
    console.log("labelCode já existe OK.");
  }

  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
