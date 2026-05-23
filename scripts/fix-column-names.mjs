import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function renameIfNeeded(table, oldCol, newCol, type) {
  const [cols] = await db.execute(sql.raw(`SHOW COLUMNS FROM ${table} LIKE '${oldCol}'`));
  if (cols.length > 0) {
    await db.execute(sql.raw(`ALTER TABLE ${table} CHANGE COLUMN ${oldCol} ${newCol} ${type}`));
    console.log(`✅ ${table}: ${oldCol} → ${newCol}`);
  } else {
    const [exists] = await db.execute(sql.raw(`SHOW COLUMNS FROM ${table} LIKE '${newCol}'`));
    if (exists.length > 0) {
      console.log(`ℹ️  ${table}: ${newCol} já existe`);
    } else {
      console.log(`⚠️  ${table}: nem ${oldCol} nem ${newCol} encontrado`);
    }
  }
}

async function run() {
  // pickingAllocations: productInternalCode → productSku
  await renameIfNeeded('pickingAllocations', 'productInternalCode', 'productSku', 'VARCHAR(100) NOT NULL');

  // pickingWaveItems: verificar também
  await renameIfNeeded('pickingWaveItems', 'productInternalCode', 'productSku', 'VARCHAR(200) NULL');

  // productLabels: verificar também
  await renameIfNeeded('productLabels', 'productInternalCode', 'productSku', 'VARCHAR(200) NOT NULL');

  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
