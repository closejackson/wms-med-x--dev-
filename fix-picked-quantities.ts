import { getDb } from './server/db';

async function main() {
  const db = await getDb();
  if (!db) throw new Error('DB not connected');

  // Verificar estado atual
  const before = await db.execute(`
    SELECT poi.id, poi.pickingOrderId, poi.requestedQuantity, poi.pickedQuantity, 
           poi.batch, poi.status, poi.inventoryId
    FROM pickingOrderItems poi
    WHERE poi.id IN (870002, 870003)
  `);
  console.log('Antes da correção:', JSON.stringify(before[0], null, 2));

  // Corrigir: pickedQuantity não pode exceder requestedQuantity
  // Item 870002: requestedQuantity=160, pickedQuantity=320 → corrigir para 160, status='picked'
  // Item 870003: requestedQuantity=160, pickedQuantity=320 → corrigir para 160, status='picked'
  const fix = await db.execute(`
    UPDATE pickingOrderItems
    SET pickedQuantity = requestedQuantity,
        status = 'picked'
    WHERE id IN (870002, 870003)
      AND pickedQuantity > requestedQuantity
  `);
  console.log('Correção aplicada:', JSON.stringify((fix as any)[0]));

  // Verificar estado após correção
  const after = await db.execute(`
    SELECT poi.id, poi.pickingOrderId, poi.requestedQuantity, poi.pickedQuantity, 
           poi.batch, poi.status, poi.inventoryId
    FROM pickingOrderItems poi
    WHERE poi.id IN (870002, 870003)
  `);
  console.log('Após correção:', JSON.stringify(after[0], null, 2));

  // Verificar também pickingAllocations correspondentes
  const allocs = await db.execute(`
    SELECT pa.id, pa.pickingOrderId, pa.quantity, pa.pickedQuantity, pa.batch, pa.status, pa.inventoryId
    FROM pickingAllocations pa
    WHERE pa.pickingOrderId = 870001
    ORDER BY pa.id
  `);
  console.log('\nPickingAllocations do pedido 870001:', JSON.stringify(allocs[0], null, 2));
}

main().catch(console.error);
