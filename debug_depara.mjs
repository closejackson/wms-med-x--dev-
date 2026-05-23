import { createConnection } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/wms-medax/.env' });

const conn = await createConnection(process.env.DATABASE_URL.replace('mysql2://', 'mysql://'));

// Verificar os produtos 630032 e 630036
const [products] = await conn.execute(
  "SELECT id, sku, internalCode, supplierCode, description FROM products WHERE id IN (630032, 630036)"
);
console.log("Produtos:", JSON.stringify(products, null, 2));

// Verificar mapeamentos De/Para para tenantId=30002
const [mappings] = await conn.execute(
  "SELECT productId, tenantId, internalCode, supplierCode FROM product_tenant_mappings WHERE tenantId = 30002 AND productId IN (630032, 630036)"
);
console.log("Mapeamentos De/Para (tenantId=30002):", JSON.stringify(mappings, null, 2));

// Verificar mapeamentos para tenantId=1 (usuário admin)
const [mappings1] = await conn.execute(
  "SELECT productId, tenantId, internalCode, supplierCode FROM product_tenant_mappings WHERE tenantId = 1 AND productId IN (630032, 630036)"
);
console.log("Mapeamentos De/Para (tenantId=1):", JSON.stringify(mappings1, null, 2));

await conn.end();
