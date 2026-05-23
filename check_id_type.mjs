import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Verificar se o update funciona com um id específico
const [updateResult] = await conn.execute(`
  UPDATE inventory SET reservedQuantity = reservedQuantity + 0 WHERE id = 1200041
`);
console.log('Update result:', JSON.stringify(updateResult, null, 2));

// Verificar o valor após o update
const [afterUpdate] = await conn.execute(`
  SELECT id, reservedQuantity FROM inventory WHERE id = 1200041
`);
console.log('Após update:', JSON.stringify(afterUpdate, null, 2));

// Simular incremento
const [incResult] = await conn.execute(`
  UPDATE inventory SET reservedQuantity = reservedQuantity + 10 WHERE id = 1200041
`);
console.log('Incremento result:', JSON.stringify(incResult, null, 2));

const [afterInc] = await conn.execute(`
  SELECT id, reservedQuantity FROM inventory WHERE id = 1200041
`);
console.log('Após incremento:', JSON.stringify(afterInc, null, 2));

// Reverter
await conn.execute(`UPDATE inventory SET reservedQuantity = 0 WHERE id = 1200041`);
console.log('Revertido para 0');

await conn.end();
