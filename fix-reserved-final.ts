import { getDb } from './server/db';

async function main() {
  const db = await getDb();
  if (!db) throw new Error('DB not connected');
  
  // Corrigir: reservedQuantity = requestedQuantity (em unidades) dos itens pendentes
  // inventoryId 1470003: item 870004, requestedQuantity=400 (unidades), status=pending
  // inventoryId 1470004: item 870005, requestedQuantity=140 (unidades), status=pending
  await db.execute('UPDATE inventory SET reservedQuantity = 400 WHERE id = 1470003');
  await db.execute('UPDATE inventory SET reservedQuantity = 140 WHERE id = 1470004');
  
  // Verificar resultado
  const r = await db.execute(`
    SELECT i.id, wl.code, i.batch, i.quantity, i.reservedQuantity,
           (i.quantity - COALESCE(i.reservedQuantity,0)) as available
    FROM inventory i
    JOIN warehouseLocations wl ON i.locationId = wl.id
    WHERE i.id IN (1470001, 1470002, 1470003, 1470004, 1500006, 1500007)
    ORDER BY wl.code
  `);
  console.log(JSON.stringify(r[0], null, 2));
}
main().catch(console.error);
