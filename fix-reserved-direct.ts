import { getDb } from './server/db';

async function main() {
  const db = await getDb();
  if (!db) throw new Error('DB not connected');

  // Corrigir reservedQuantity para os registros de inventory dos itens picked
  // inventoryId 1470002 (M03-09-02, lote 22D08LB108): pedido picked, deve liberar reserva
  // inventoryId 1500006 (M06-09-02, lote 22D08LB108): pedido picked, deve liberar reserva
  // inventoryId 1470003 (M03-09-03, lote 22D10LB111): pedido pending, reserva = 400
  // inventoryId 1470001 (M03-09-01, lote 22D14LA124): pedido picked, deve liberar reserva
  // inventoryId 1470004 (M03-09-04, lote 22D08LA129): pedido pending, reserva = 140

  // Calcular reservas corretas por inventoryId
  const reservas = await db.execute(`
    SELECT poi.inventoryId,
           COALESCE(SUM(
             CASE 
               WHEN poi.unit = 'box' THEN poi.requestedQuantity * COALESCE(p.unitsPerBox, 1)
               ELSE poi.requestedQuantity
             END
           ), 0) as totalReserved
    FROM pickingOrderItems poi
    JOIN pickingOrders po ON poi.pickingOrderId = po.id
    JOIN products p ON poi.productId = p.id
    WHERE poi.inventoryId IN (1470001, 1470002, 1470003, 1470004, 1500006, 1500007)
      AND po.status IN ('pending', 'in_progress', 'separated', 'in_wave')
      AND poi.status NOT IN ('picked', 'cancelled')
    GROUP BY poi.inventoryId
  `);
  console.log('Reservas calculadas:', JSON.stringify(reservas[0], null, 2));

  // Atualizar cada registro
  const inventoryIds = [1470001, 1470002, 1470003, 1470004, 1500006, 1500007];
  const reservaMap = new Map<number, number>();
  for (const r of (reservas[0] as any[])) {
    reservaMap.set(r.inventoryId, Number(r.totalReserved));
  }

  for (const invId of inventoryIds) {
    const newReserved = reservaMap.get(invId) ?? 0;
    const result = await db.execute(`
      UPDATE inventory SET reservedQuantity = ${newReserved} WHERE id = ${invId}
    `);
    console.log(`inventory ${invId}: reservedQuantity → ${newReserved} (changed: ${(result as any)[0].changedRows})`);
  }

  // Verificar resultado final
  const final = await db.execute(`
    SELECT i.id, wl.code, i.batch, i.quantity, i.reservedQuantity,
           (i.quantity - COALESCE(i.reservedQuantity,0)) as available
    FROM inventory i
    JOIN warehouseLocations wl ON i.locationId = wl.id
    WHERE i.id IN (1470001, 1470002, 1470003, 1470004, 1500006, 1500007)
    ORDER BY wl.code
  `);
  console.log('\nEstado final do inventory:', JSON.stringify(final[0], null, 2));
}

main().catch(console.error);
