import mysql from 'mysql2/promise';
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [orders] = await conn.execute(`
  SELECT id, orderNumber, status, tenantId, totalQuantity, createdAt 
  FROM pickingOrders 
  ORDER BY createdAt DESC 
  LIMIT 20
`);
console.log('Todos os pedidos recentes:', JSON.stringify(orders, null, 2));

// Verificar se há algum registro com reservedQuantity > 0
const [reserved] = await conn.execute(`
  SELECT COUNT(*) as count, SUM(reservedQuantity) as total FROM inventory WHERE reservedQuantity > 0
`);
console.log('\nTotal de registros com reserva:', JSON.stringify(reserved, null, 2));

await conn.end();
