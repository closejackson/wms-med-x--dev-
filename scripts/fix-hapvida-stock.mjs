import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  // Verificar estoque atual Hapvida na zona EXP
  const [expStock] = await db.execute(sql`
    SELECT i.id, i.productId, p.sku, p.description, i.batch, i.quantity, i.reservedQuantity,
           wl.id as locationId, wl.code as location
    FROM inventory i
    LEFT JOIN products p ON p.id = i.productId
    LEFT JOIN warehouseLocations wl ON wl.id = i.locationId
    LEFT JOIN warehouseZones wz ON wz.id = wl.zoneId
    WHERE i.tenantId = 40001 AND wz.code = 'EXP' AND i.quantity > 0
  `);

  console.log(`Itens a baixar: ${expStock.length}`);
  expStock.forEach(s => console.log(`  id=${s.id} sku=${s.sku} batch=${s.batch} qty=${s.quantity} reserved=${s.reservedQuantity}`));

  if (expStock.length === 0) {
    console.log('Nenhum item para baixar.');
    process.exit(0);
  }

  // Dar baixa em todos os itens da zona EXP da Hapvida
  for (const item of expStock) {
    // Registrar movimentação de saída
    await db.execute(sql`
      INSERT INTO inventoryMovements (productId, batch, fromLocationId, toLocationId, quantity, movementType, referenceType, referenceId, performedBy, notes, tenantId, conversionSource, createdAt)
      VALUES (${item.productId}, ${item.batch}, ${item.locationId}, NULL, ${item.quantity}, 'picking', 'shipment_manifest', 540001, 1, 
              'Baixa manual retroativa - Romaneio ROM-1777614078612 (intra-hospitalar sem baixa)', 
              40001, 'manual', NOW())
    `);

    // Deletar o registro de inventory
    await db.execute(sql`DELETE FROM inventory WHERE id = ${item.id}`);
    console.log(`✅ Baixa: sku=${item.sku} batch=${item.batch} qty=${item.quantity} (id=${item.id})`);
  }

  // Atualizar status do endereço EXP-01-D
  const [locations] = await db.execute(sql`
    SELECT DISTINCT wl.id FROM warehouseLocations wl
    LEFT JOIN warehouseZones wz ON wz.id = wl.zoneId
    WHERE wl.code = 'EXP-01-D' AND wz.code = 'EXP'
  `);
  for (const loc of locations) {
    await db.execute(sql`
      UPDATE warehouseLocations SET status = 'free' WHERE id = ${loc.id}
    `);
    console.log(`✅ Endereço EXP-01-D (id=${loc.id}) marcado como livre`);
  }

  console.log('\nBaixa manual concluída com sucesso!');
  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
