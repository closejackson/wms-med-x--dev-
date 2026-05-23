import { getDb } from './server/db';

async function main() {
  const db = await getDb();
  if (!db) throw new Error('DB not connected');

  // 1. Ver inventory do produto 401460P (productId 690002)
  const inv = await db.execute(`
    SELECT i.id, wl.code, i.batch, i.quantity, i.reservedQuantity, 
           (i.quantity - COALESCE(i.reservedQuantity,0)) as available,
           i.tenantId
    FROM inventory i
    JOIN warehouseLocations wl ON i.locationId = wl.id
    JOIN products p ON i.productId = p.id
    WHERE p.sku = '401460P'
    ORDER BY wl.code
  `);
  console.log('=== INVENTORY 401460P ===');
  console.log(JSON.stringify(inv[0], null, 2));

  // 2. Ver pickingOrderItems ativos para 401460P
  const items = await db.execute(`
    SELECT poi.id, poi.pickingOrderId, po.orderNumber, po.status as orderStatus,
           poi.requestedQuantity, poi.pickedQuantity, poi.batch, poi.status as itemStatus,
           poi.inventoryId, poi.unit
    FROM pickingOrderItems poi
    JOIN pickingOrders po ON poi.pickingOrderId = po.id
    JOIN products p ON poi.productId = p.id
    WHERE p.sku = '401460P'
      AND po.status IN ('pending', 'in_progress', 'separated', 'in_wave')
    ORDER BY poi.id
  `);
  console.log('\n=== PICKING ORDER ITEMS ATIVOS (401460P) ===');
  console.log(JSON.stringify(items[0], null, 2));

  // 3. Soma total reservada por inventoryId
  const sums = await db.execute(`
    SELECT poi.inventoryId, SUM(poi.requestedQuantity) as totalReserved
    FROM pickingOrderItems poi
    JOIN pickingOrders po ON poi.pickingOrderId = po.id
    JOIN products p ON poi.productId = p.id
    WHERE p.sku = '401460P'
      AND po.status IN ('pending', 'in_progress', 'separated', 'in_wave')
    GROUP BY poi.inventoryId
  `);
  console.log('\n=== SOMA POR INVENTORY ID ===');
  console.log(JSON.stringify(sums[0], null, 2));
}

main().catch(console.error);
