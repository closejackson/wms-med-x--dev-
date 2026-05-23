import { createConnection } from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL não encontrado nas variáveis de ambiente');
  process.exit(1);
}

const conn = await createConnection(DATABASE_URL);
console.log('Conectado ao banco de dados');

// 1. Criar tabela productTenantMappings
await conn.execute(`
  CREATE TABLE IF NOT EXISTS \`productTenantMappings\` (
    \`id\` int AUTO_INCREMENT NOT NULL,
    \`productId\` int NOT NULL,
    \`tenantId\` int NOT NULL,
    \`internalCode\` varchar(100),
    \`customerCode\` varchar(100),
    \`supplierCode\` varchar(100),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY(\`id\`),
    UNIQUE KEY \`ptm_product_tenant\` (\`productId\`,\`tenantId\`)
  )
`);
console.log('✓ Tabela productTenantMappings criada');

// 2. Verificar produtos com códigos existentes
const [productsWithCodes] = await conn.execute(`
  SELECT id, sku, internalCode, supplierCode, customerCode 
  FROM products 
  WHERE internalCode IS NOT NULL OR supplierCode IS NOT NULL OR customerCode IS NOT NULL
`);
console.log(`\nProdutos com códigos para migrar: ${productsWithCodes.length}`);
productsWithCodes.forEach(p => {
  console.log(`  id=${p.id} sku=${p.sku} internalCode=${p.internalCode} supplierCode=${p.supplierCode} customerCode=${p.customerCode}`);
});

// 3. Verificar tenants existentes
const [tenants] = await conn.execute(`SELECT id, name FROM tenants ORDER BY id`);
console.log(`\nTenants existentes: ${tenants.length}`);
tenants.forEach(t => console.log(`  id=${t.id} name=${t.name}`));

// 4. Migrar dados: como não sabemos a qual tenant cada código pertence,
//    vamos criar um mapeamento para cada tenant com os dados do produto global
if (productsWithCodes.length > 0 && tenants.length > 0) {
  console.log('\nMigrando códigos para productTenantMappings...');
  let migrated = 0;
  for (const product of productsWithCodes) {
    for (const tenant of tenants) {
      // Só migrar se o produto tem algum código
      if (product.internalCode || product.supplierCode || product.customerCode) {
        try {
          await conn.execute(`
            INSERT IGNORE INTO productTenantMappings (productId, tenantId, internalCode, supplierCode, customerCode)
            VALUES (?, ?, ?, ?, ?)
          `, [product.id, tenant.id, product.internalCode, product.supplierCode, product.customerCode]);
          migrated++;
        } catch (e) {
          console.log(`  Ignorado: produto ${product.id} tenant ${tenant.id} - ${e.message}`);
        }
      }
    }
  }
  console.log(`✓ ${migrated} mapeamentos criados`);
}

// 5. Verificar resultado
const [mappings] = await conn.execute(`
  SELECT ptm.id, p.sku, ptm.tenantId, ptm.internalCode, ptm.supplierCode, ptm.customerCode
  FROM productTenantMappings ptm
  JOIN products p ON p.id = ptm.productId
  ORDER BY ptm.tenantId, p.sku
`);
console.log(`\nMapeamentos criados: ${mappings.length}`);
mappings.forEach(m => {
  console.log(`  sku=${m.sku} tenant=${m.tenantId} internalCode=${m.internalCode} supplierCode=${m.supplierCode}`);
});

await conn.end();
console.log('\n✓ Migration concluída com sucesso');
