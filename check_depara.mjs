import { createConnection } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/wms-medax/.env' });

const conn = await createConnection(process.env.DATABASE_URL);

// Verificar o pedido E25000746
const [orders] = await conn.execute(
  "SELECT id, customerOrderNumber, tenantId, status FROM picking_orders WHERE customerOrderNumber = 'E25000746' LIMIT 1"
);
console.log("Pedido E25000746:", orders);

// Verificar os itens do pedido
if (orders.length > 0) {
  const orderId = orders[0].id;
  const tenantId = orders[0].tenantId;
  
  const [items] = await conn.execute(
    `SELECT poi.productId, p.sku, p.internalCode, ptm.internalCode as mappedCode, ptm.tenantId as mappingTenantId
     FROM picking_order_items poi
     LEFT JOIN products p ON poi.productId = p.id
     LEFT JOIN product_tenant_mappings ptm ON ptm.productId = poi.productId AND ptm.tenantId = ?
     WHERE poi.pickingOrderId = ?`,
    [tenantId, orderId]
  );
  console.log("Itens do pedido (tenantId=" + tenantId + "):", items);
  
  // Verificar todos os mapeamentos de De/Para existentes
  const [mappings] = await conn.execute(
    "SELECT productId, tenantId, internalCode FROM product_tenant_mappings WHERE tenantId = ? LIMIT 20",
    [tenantId]
  );
  console.log("Mapeamentos De/Para para tenantId=" + tenantId + ":", mappings);
}

await conn.end();
