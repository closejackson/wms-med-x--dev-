import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  // Ver amostra atual
  const [sample] = await db.execute(sql`
    SELECT pa.id, pa.productId, pa.productSku AS currentSku, p.sku AS realSku, p.internalCode
    FROM pickingAllocations pa
    LEFT JOIN products p ON p.id = pa.productId
    LIMIT 5
  `);
  console.log("Amostra atual:");
  sample.forEach(r => console.log(`  id=${r.id} productId=${r.productId} currentSku="${r.currentSku}" realSku="${r.realSku}" internalCode="${r.internalCode}"`));

  // Atualizar productSku = products.sku onde o sku não é null
  const [result] = await db.execute(sql`
    UPDATE pickingAllocations pa
    JOIN products p ON p.id = pa.productId
    SET pa.productSku = COALESCE(p.sku, p.internalCode)
    WHERE p.id IS NOT NULL
  `);
  console.log(`\n✅ ${result.affectedRows} registros atualizados em pickingAllocations.productSku`);

  // Também corrigir o código no servidor para usar product.sku ao inserir
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
