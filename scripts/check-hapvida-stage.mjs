import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

const db = drizzle(process.env.DATABASE_URL);

async function run() {
  // Ver romaneios recentes
  const [manifests] = await db.execute(sql`
    SELECT sm.id, sm.manifestNumber, sm.status, sm.shippedAt, sm.tenantId,
           t.name as tenantName
    FROM shipmentManifests sm
    LEFT JOIN tenants t ON t.id = sm.tenantId
    ORDER BY sm.id DESC LIMIT 5
  `);
  console.log("Últimos romaneios:");
  manifests.forEach(m => console.log(`  id=${m.id} num=${m.manifestNumber} status=${m.status} tenant=${m.tenantName}`));

  if (manifests.length === 0) { process.exit(0); }

  // Pegar o romaneio mais recente
  const latestManifest = manifests[0];
  console.log(`\nVerificando romaneio ${latestManifest.manifestNumber} (id=${latestManifest.id}):`);

  // Buscar pedidos do romaneio
  const [items] = await db.execute(sql`
    SELECT smi.pickingOrderId, po.customerOrderNumber, po.status, po.shippingStatus
    FROM shipmentManifestItems smi
    LEFT JOIN pickingOrders po ON po.id = smi.pickingOrderId
    WHERE smi.manifestId = ${latestManifest.id}
  `);
  console.log(`\nPedidos no romaneio:`);
  items.forEach(i => console.log(`  orderId=${i.pickingOrderId} num=${i.customerOrderNumber} status=${i.status} shippingStatus=${i.shippingStatus}`));

  // Verificar Stage Checks de cada pedido
  for (const item of items) {
    const [stages] = await db.execute(sql`
      SELECT id, status, completedAt FROM stageChecks
      WHERE pickingOrderId = ${item.pickingOrderId}
      ORDER BY id DESC LIMIT 3
    `);
    if (stages.length === 0) {
      console.log(`  ⚠️  Pedido ${item.pickingOrderId}: SEM Stage Check`);
    } else {
      stages.forEach(s => console.log(`  Stage pedido ${item.pickingOrderId}: id=${s.id} status=${s.status} completedAt=${s.completedAt}`));
    }
  }

  // Verificar estoque atual na zona EXP para Hapvida
  const [expStock] = await db.execute(sql`
    SELECT i.productId, p.sku, p.description, i.batch, i.quantity, i.reservedQuantity,
           wl.code as location, wz.code as zone
    FROM inventory i
    LEFT JOIN products p ON p.id = i.productId
    LEFT JOIN warehouseLocations wl ON wl.id = i.locationId
    LEFT JOIN warehouseZones wz ON wz.id = wl.zoneId
    WHERE i.tenantId = 40001 AND wz.code = 'EXP'
    ORDER BY i.productId
  `);
  console.log(`\nEstoque EXP Hapvida (tenantId=40001):`);
  expStock.forEach(s => console.log(`  sku=${s.sku} batch=${s.batch} qty=${s.quantity} reserved=${s.reservedQuantity} loc=${s.location}`));

  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
