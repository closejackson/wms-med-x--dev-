import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

// Tabelas que o schema Drizzle define com productSku mas o banco pode ter productInternalCode
const tables = [
  { table: 'stageCheckItems', col: 'productSku', type: 'VARCHAR(200) NULL' },
  { table: 'pickingWaveItems', col: 'productSku', type: 'VARCHAR(200) NULL' },
  { table: 'productLabels', col: 'productSku', type: 'VARCHAR(100) NOT NULL' },
  { table: 'pickingAllocations', col: 'productSku', type: 'VARCHAR(100) NOT NULL' },
];

async function run() {
  for (const { table, col, type } of tables) {
    // Verificar se a coluna correta já existe
    const [exists] = await db.execute(sql.raw(`SHOW COLUMNS FROM \`${table}\` LIKE '${col}'`));
    if (exists.length > 0) {
      console.log(`✅ ${table}.${col} já existe`);
      continue;
    }

    // Verificar se existe com nome antigo
    const [old] = await db.execute(sql.raw(`SHOW COLUMNS FROM \`${table}\` LIKE 'productInternalCode'`));
    if (old.length > 0) {
      await db.execute(sql.raw(`ALTER TABLE \`${table}\` CHANGE COLUMN productInternalCode ${col} ${type}`));
      console.log(`✅ ${table}: productInternalCode → ${col}`);
    } else {
      // Verificar todas as colunas para diagnóstico
      const [cols] = await db.execute(sql.raw(`SHOW COLUMNS FROM \`${table}\``));
      const names = cols.map(c => c.Field).join(', ');
      console.log(`⚠️  ${table}: nem productSku nem productInternalCode encontrado. Colunas: ${names}`);
    }
  }
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
