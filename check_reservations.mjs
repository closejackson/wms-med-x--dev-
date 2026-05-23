import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Ver pedidos de picking ativos
const [orders] = await conn.execute(`
  SELECT id, orderNumber, status, tenantId, totalQuantity, createdAt 
  FROM pickingOrders 
  WHERE status NOT IN ('cancelled', 'shipped') 
  ORDER BY createdAt DESC 
  LIMIT 10
`);
console.log('Pedidos ativos:', JSON.stringify(orders, null, 2));

// Ver reservedQuantity atual no inventário
const [reserved] = await conn.execute(`
  SELECT id, productId, locationId, tenantId, quantity, reservedQuantity, status
  FROM inventory 
  WHERE reservedQuantity > 0
  LIMIT 20
`);
console.log('\nRegistros com reserva:', JSON.stringify(reserved, null, 2));

// Ver pickingOrderItems com inventoryId
const [items] = await conn.execute(`
  SELECT poi.id, poi.pickingOrderId, poi.productId, poi.requestedQuantity, poi.inventoryId, poi.status
  FROM pickingOrderItems poi
  JOIN pickingOrders po ON poi.pickingOrderId = po.id
  WHERE po.status NOT IN ('cancelled', 'shipped')
  LIMIT 20
`);
console.log('\nItens de pedidos ativos:', JSON.stringify(items, null, 2));

await conn.end();

// Verificar o inventário dos itens do pedido
const conn2 = await mysql.createConnection(process.env.DATABASE_URL);
const [invItems] = await conn2.execute(`
  SELECT i.id, i.productId, i.locationId, i.tenantId, i.quantity, i.reservedQuantity, i.status, i.batch
  FROM inventory i
  WHERE i.id IN (1200041, 1200050)
`);
console.log('\nInventário dos itens do pedido:', JSON.stringify(invItems, null, 2));

// Verificar se há pedidos pending (novos)
const [pendingOrders] = await conn2.execute(`
  SELECT id, orderNumber, status, tenantId, totalQuantity, createdAt 
  FROM pickingOrders 
  WHERE status = 'pending'
  ORDER BY createdAt DESC 
  LIMIT 5
`);
console.log('\nPedidos pending:', JSON.stringify(pendingOrders, null, 2));
await conn2.end();
