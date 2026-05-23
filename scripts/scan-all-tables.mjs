import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  // Buscar todas as tabelas do banco
  const [tables] = await db.execute(sql`SHOW TABLES`);
  const tableNames = tables.map(t => Object.values(t)[0]);

  console.log(`Total de tabelas: ${tableNames.length}\n`);

  for (const table of tableNames) {
    const [cols] = await db.execute(sql.raw(`SHOW COLUMNS FROM \`${table}\``));
    const colNames = cols.map(c => c.Field);
    if (colNames.includes('productInternalCode')) {
      console.log(`⚠️  ${table}: tem productInternalCode → precisa renomear para productSku`);
    }
  }
  console.log('\nVerificação concluída.');
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
