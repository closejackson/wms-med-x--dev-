/**
 * Seed: Hapvida - Operação Intra-Hospitalar
 * Cria tenant, zonas, endereços, produtos, inventário, recebimentos e pedidos de saída.
 */
import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';

// Usar DATABASE_URL do ambiente
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL não definida no ambiente');

const TENANT_ID = 40001;
const WAREHOUSE_ID = 1; // Usar o armazém existente
const CREATED_BY = 1;   // Global Admin

async function main() {
  const conn = await createConnection(DATABASE_URL);
  console.log('✅ Conectado ao banco');

  // ─────────────────────────────────────────────
  // 1. TENANT
  // ─────────────────────────────────────────────
  await conn.execute(`
    INSERT INTO tenants (id, name, tradeName, cnpj, afe, address, city, state, zipCode, phone, email, pickingRule, status, intraHospitalEnabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name=VALUES(name)
  `, [
    TENANT_ID,
    'Hapvida Saúde',
    'Hapvida',
    '63755452000130',
    'AFE-HAP-2024-001',
    'Av. Bezerra de Menezes, 3000',
    'Fortaleza',
    'CE',
    '60325-003',
    '(85) 3101-5000',
    'logistica@hapvida.com.br',
    'FEFO',
    'active',
    1
  ]);
  console.log('✅ Tenant Hapvida criado (id=40001)');

  // ─────────────────────────────────────────────
  // 2. ZONAS
  // ─────────────────────────────────────────────
  const zones = [
    { code: 'REC', name: 'Recebimento', cond: 'ambient' },
    { code: 'ARM', name: 'Armazenagem', cond: 'ambient' },
    { code: 'REF', name: 'Refrigerado 2-8°C', cond: 'refrigerated_2_8' },
    { code: 'CTR', name: 'Controlados', cond: 'controlled' },
    { code: 'EXP', name: 'Expedição', cond: 'ambient' },
    { code: 'NCG', name: 'Não Conformidade', cond: 'quarantine' },
    { code: 'DEV', name: 'Devolução', cond: 'ambient' },
  ];

  const zoneIds = {};
  for (const z of zones) {
    // Verificar se já existe
    const [existing] = await conn.execute(
      'SELECT id FROM warehouseZones WHERE warehouseId=? AND code=?',
      [WAREHOUSE_ID, `HAP-${z.code}`]
    );
    if (existing.length > 0) {
      zoneIds[z.code] = existing[0].id;
      console.log(`  ↩ Zona ${z.code} já existe (id=${zoneIds[z.code]})`);
      continue;
    }
    const [res] = await conn.execute(`
      INSERT INTO warehouseZones (warehouseId, code, name, storageCondition, status)
      VALUES (?, ?, ?, ?, 'active')
    `, [WAREHOUSE_ID, `HAP-${z.code}`, `[HAP] ${z.name}`, z.cond]);
    zoneIds[z.code] = res.insertId;
    console.log(`  ✅ Zona ${z.code} criada (id=${zoneIds[z.code]})`);
  }

  // ─────────────────────────────────────────────
  // 3. ENDEREÇOS
  // ─────────────────────────────────────────────
  // Padrão: RUA-PREDIO-ANDAR (ex: H01-01-01)
  // ARM: 3 ruas (H01, H02, H03), prédios 01-06, andares 01-04
  // REF: 1 rua (R01), prédios 01-04, andares 01-02
  // CTR: 1 rua (C01), prédios 01-03, andares 01-02
  // REC/EXP/NCG/DEV: 1 posição cada

  const locationsToCreate = [];

  // Zonas simples (1 endereço)
  for (const [zoneCode, locCode] of [
    ['REC', 'HAP-REC-01'],
    ['EXP', 'HAP-EXP-01'],
    ['NCG', 'HAP-NCG-01'],
    ['DEV', 'HAP-DEV-01'],
  ]) {
    locationsToCreate.push({
      zoneId: zoneIds[zoneCode],
      zoneCode,
      code: locCode,
      aisle: zoneCode,
      rack: '01',
      level: '01',
      position: null,
    });
  }

  // ARM: 3 ruas × 6 prédios × 4 andares = 72 endereços
  for (let r = 1; r <= 3; r++) {
    for (let p = 1; p <= 6; p++) {
      for (let a = 1; a <= 4; a++) {
        const rStr = `H0${r}`;
        const pStr = String(p).padStart(2, '0');
        const aStr = String(a).padStart(2, '0');
        locationsToCreate.push({
          zoneId: zoneIds['ARM'],
          zoneCode: 'ARM',
          code: `${rStr}-${pStr}-${aStr}`,
          aisle: rStr,
          rack: pStr,
          level: aStr,
          position: null,
        });
      }
    }
  }

  // REF: 1 rua × 4 prédios × 2 andares = 8 endereços
  for (let p = 1; p <= 4; p++) {
    for (let a = 1; a <= 2; a++) {
      const pStr = String(p).padStart(2, '0');
      const aStr = String(a).padStart(2, '0');
      locationsToCreate.push({
        zoneId: zoneIds['REF'],
        zoneCode: 'REF',
        code: `R01-${pStr}-${aStr}`,
        aisle: 'R01',
        rack: pStr,
        level: aStr,
        position: null,
      });
    }
  }

  // CTR: 1 rua × 3 prédios × 2 andares = 6 endereços
  for (let p = 1; p <= 3; p++) {
    for (let a = 1; a <= 2; a++) {
      const pStr = String(p).padStart(2, '0');
      const aStr = String(a).padStart(2, '0');
      locationsToCreate.push({
        zoneId: zoneIds['CTR'],
        zoneCode: 'CTR',
        code: `C01-${pStr}-${aStr}`,
        aisle: 'C01',
        rack: pStr,
        level: aStr,
        position: null,
      });
    }
  }

  let locCreated = 0;
  const locationIds = {};
  for (const loc of locationsToCreate) {
    const [existing] = await conn.execute(
      'SELECT id FROM warehouseLocations WHERE code=?', [loc.code]
    );
    if (existing.length > 0) {
      locationIds[loc.code] = existing[0].id;
      continue;
    }
    const [res] = await conn.execute(`
      INSERT INTO warehouseLocations (zoneId, zoneCode, tenantId, code, aisle, rack, level, position, locationType, storageRule, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'whole', 'multi', 'available')
    `, [loc.zoneId, loc.zoneCode, TENANT_ID, loc.code, loc.aisle, loc.rack, loc.level, loc.position]);
    locationIds[loc.code] = res.insertId;
    locCreated++;
  }
  console.log(`✅ ${locCreated} endereços criados (${locationsToCreate.length - locCreated} já existiam)`);

  // ─────────────────────────────────────────────
  // 4. PRODUTOS (materiais hospitalares intra-hospitalar)
  // ─────────────────────────────────────────────
  const products = [
    // Medicamentos controlados
    { sku: 'HAP-001', desc: 'MORFINA 10MG/ML SOL INJ AMP 1ML', gtin: '7891234000001', cat: 'Medicamentos Controlados', thClass: 'Analgésicos Opioides', manuf: 'Cristália', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'controlled' },
    { sku: 'HAP-002', desc: 'MIDAZOLAM 5MG/ML SOL INJ AMP 3ML', gtin: '7891234000002', cat: 'Medicamentos Controlados', thClass: 'Benzodiazepínicos', manuf: 'Cristália', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'controlled' },
    { sku: 'HAP-003', desc: 'FENTANIL 50MCG/ML SOL INJ AMP 10ML', gtin: '7891234000003', cat: 'Medicamentos Controlados', thClass: 'Analgésicos Opioides', manuf: 'Janssen', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'controlled' },
    // Medicamentos refrigerados
    { sku: 'HAP-004', desc: 'INSULINA REGULAR 100UI/ML FR 10ML', gtin: '7891234000004', cat: 'Medicamentos Refrigerados', thClass: 'Antidiabéticos', manuf: 'Novo Nordisk', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'refrigerated_2_8' },
    { sku: 'HAP-005', desc: 'ADRENALINA 1MG/ML SOL INJ AMP 1ML', gtin: '7891234000005', cat: 'Medicamentos Refrigerados', thClass: 'Vasopressores', manuf: 'Hipolabor', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'refrigerated_2_8' },
    // Medicamentos gerais
    { sku: 'HAP-006', desc: 'DIPIRONA 500MG/ML SOL INJ AMP 2ML', gtin: '7891234000006', cat: 'Medicamentos', thClass: 'Analgésicos', manuf: 'Sanofi', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-007', desc: 'OMEPRAZOL 40MG PO LIOF IV FR-AMP', gtin: '7891234000007', cat: 'Medicamentos', thClass: 'Inibidores da Bomba de Prótons', manuf: 'EMS', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-008', desc: 'CEFTRIAXONA 1G PO LIOF IV FR-AMP', gtin: '7891234000008', cat: 'Medicamentos', thClass: 'Antibióticos', manuf: 'Eurofarma', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-009', desc: 'SOLUÇÃO FISIOLÓGICA 0,9% FR 500ML', gtin: '7891234000009', cat: 'Soluções Parenterais', thClass: 'Soluções de Reposição', manuf: 'Baxter', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-010', desc: 'SORO GLICOSADO 5% FR 500ML', gtin: '7891234000010', cat: 'Soluções Parenterais', thClass: 'Soluções de Reposição', manuf: 'Baxter', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    // Materiais cirúrgicos
    { sku: 'HAP-011', desc: 'CATETER VENOSO CENTRAL 3 VIAS 7FR', gtin: '7891234000011', cat: 'Materiais Cirúrgicos', thClass: 'Cateteres', manuf: 'Arrow', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: true, cond: 'ambient' },
    { sku: 'HAP-012', desc: 'LUVA CIRÚRGICA ESTÉRIL N7.5 PAR', gtin: '7891234000012', cat: 'Materiais Cirúrgicos', thClass: 'EPIs Cirúrgicos', manuf: 'Supermax', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-013', desc: 'FIO SUTURA VICRYL 2-0 AG 1/2 CIRC', gtin: '7891234000013', cat: 'Materiais Cirúrgicos', thClass: 'Fios de Sutura', manuf: 'Ethicon', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-014', desc: 'BISTURI DESCARTÁVEL N22 ESTÉRIL', gtin: '7891234000014', cat: 'Materiais Cirúrgicos', thClass: 'Instrumentos Cortantes', manuf: 'Solidor', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    // Materiais de enfermagem
    { sku: 'HAP-015', desc: 'SERINGA 10ML C/ AGULHA 25X8', gtin: '7891234000015', cat: 'Materiais de Enfermagem', thClass: 'Seringas e Agulhas', manuf: 'BD', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-016', desc: 'EQUIPO MACRO GOTAS C/ FILTRO', gtin: '7891234000016', cat: 'Materiais de Enfermagem', thClass: 'Equipos', manuf: 'Solidor', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-017', desc: 'CURATIVO TRANSPARENTE 10X12CM', gtin: '7891234000017', cat: 'Materiais de Enfermagem', thClass: 'Curativos', manuf: '3M', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
    { sku: 'HAP-018', desc: 'GAZE ESTÉRIL 7,5X7,5CM PCT 10UN', gtin: '7891234000018', cat: 'Materiais de Enfermagem', thClass: 'Curativos', manuf: 'Cremer', uom: 'UN', reqBatch: true, reqExpiry: true, reqSerial: false, cond: 'ambient' },
  ];

  const productIds = {};
  let prodCreated = 0;
  for (const p of products) {
    const [existing] = await conn.execute('SELECT id FROM products WHERE sku=?', [p.sku]);
    if (existing.length > 0) {
      productIds[p.sku] = existing[0].id;
      continue;
    }
    const [res] = await conn.execute(`
      INSERT INTO products (sku, description, gtin, category, therapeuticClass, manufacturer, unitOfMeasure, status, requiresBatchControl, requiresExpiryControl, requiresSerialControl, storageCondition)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `, [p.sku, p.desc, p.gtin, p.cat, p.thClass, p.manuf, p.uom, p.reqBatch ? 1 : 0, p.reqExpiry ? 1 : 0, p.reqSerial ? 1 : 0, p.cond]);
    productIds[p.sku] = res.insertId;
    // Associar ao tenant
    await conn.execute(`
      INSERT INTO productTenantMappings (productId, tenantId, supplierCode)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE supplierCode=VALUES(supplierCode)
    `, [productIds[p.sku], TENANT_ID, p.sku]);
    prodCreated++;
  }
  // Associar produtos já existentes ao tenant
  for (const [sku, pid] of Object.entries(productIds)) {
    await conn.execute(`
      INSERT INTO productTenantMappings (productId, tenantId, supplierCode)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE supplierCode=VALUES(supplierCode)
    `, [pid, TENANT_ID, sku]);
  }
  console.log(`✅ ${prodCreated} produtos criados (${products.length - prodCreated} já existiam)`);

  // ─────────────────────────────────────────────
  // 5. INVENTÁRIO (estoque atual)
  // ─────────────────────────────────────────────
  // Distribuir produtos nos endereços de ARM, REF e CTR
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  const stockItems = [
    // ARM - Medicamentos gerais e materiais
    { sku: 'HAP-006', loc: 'H01-01-01', batch: 'DIP2024A', expiry: addDays(today, 540), qty: 2400, status: 'available' },
    { sku: 'HAP-006', loc: 'H01-01-02', batch: 'DIP2024B', expiry: addDays(today, 180), qty: 1200, status: 'available' },
    { sku: 'HAP-007', loc: 'H01-02-01', batch: 'OME2024A', expiry: addDays(today, 720), qty: 800, status: 'available' },
    { sku: 'HAP-008', loc: 'H01-02-02', batch: 'CEF2024A', expiry: addDays(today, 365), qty: 600, status: 'available' },
    { sku: 'HAP-008', loc: 'H01-02-03', batch: 'CEF2024B', expiry: addDays(today, 60), qty: 200, status: 'available' }, // próximo do vencimento
    { sku: 'HAP-009', loc: 'H01-03-01', batch: 'SF2024A', expiry: addDays(today, 900), qty: 5000, status: 'available' },
    { sku: 'HAP-009', loc: 'H01-03-02', batch: 'SF2024B', expiry: addDays(today, 450), qty: 3000, status: 'available' },
    { sku: 'HAP-010', loc: 'H01-04-01', batch: 'SG2024A', expiry: addDays(today, 800), qty: 4000, status: 'available' },
    { sku: 'HAP-011', loc: 'H02-01-01', batch: 'CVC2024A', expiry: addDays(today, 1095), qty: 150, status: 'available' },
    { sku: 'HAP-012', loc: 'H02-01-02', batch: 'LUV2024A', expiry: addDays(today, 730), qty: 3000, status: 'available' },
    { sku: 'HAP-013', loc: 'H02-02-01', batch: 'VIC2024A', expiry: addDays(today, 1460), qty: 500, status: 'available' },
    { sku: 'HAP-014', loc: 'H02-02-02', batch: 'BIS2024A', expiry: addDays(today, 1095), qty: 800, status: 'available' },
    { sku: 'HAP-015', loc: 'H02-03-01', batch: 'SER2024A', expiry: addDays(today, 730), qty: 10000, status: 'available' },
    { sku: 'HAP-016', loc: 'H02-03-02', batch: 'EQP2024A', expiry: addDays(today, 730), qty: 2000, status: 'available' },
    { sku: 'HAP-017', loc: 'H02-04-01', batch: 'CUR2024A', expiry: addDays(today, 1095), qty: 1500, status: 'available' },
    { sku: 'HAP-018', loc: 'H03-01-01', batch: 'GAZ2024A', expiry: addDays(today, 730), qty: 5000, status: 'available' },
    // REF - Medicamentos refrigerados
    { sku: 'HAP-004', loc: 'R01-01-01', batch: 'INS2024A', expiry: addDays(today, 365), qty: 400, status: 'available' },
    { sku: 'HAP-004', loc: 'R01-01-02', batch: 'INS2024B', expiry: addDays(today, 45), qty: 80, status: 'available' }, // próximo do vencimento
    { sku: 'HAP-005', loc: 'R01-02-01', batch: 'ADR2024A', expiry: addDays(today, 540), qty: 600, status: 'available' },
    // CTR - Controlados
    { sku: 'HAP-001', loc: 'C01-01-01', batch: 'MOR2024A', expiry: addDays(today, 730), qty: 500, status: 'available' },
    { sku: 'HAP-002', loc: 'C01-01-02', batch: 'MID2024A', expiry: addDays(today, 730), qty: 300, status: 'available' },
    { sku: 'HAP-003', loc: 'C01-02-01', batch: 'FEN2024A', expiry: addDays(today, 730), qty: 200, status: 'available' },
    // NCG - Quarentena
    { sku: 'HAP-008', loc: 'HAP-NCG-01', batch: 'CEF2024C', expiry: addDays(today, 30), qty: 100, status: 'quarantine' },
  ];

  let invCreated = 0;
  for (const item of stockItems) {
    const pid = productIds[item.sku];
    const lid = locationIds[item.loc];
    if (!pid || !lid) { console.warn(`  ⚠ Produto ${item.sku} ou endereço ${item.loc} não encontrado`); continue; }
    const uniqueCode = `${item.sku}:${item.batch}`;
    const [existing] = await conn.execute(
      'SELECT id FROM inventory WHERE tenantId=? AND productId=? AND locationId=? AND batch=?',
      [TENANT_ID, pid, lid, item.batch]
    );
    if (existing.length > 0) continue;
    await conn.execute(`
      INSERT INTO inventory (tenantId, productId, locationId, batch, expiryDate, uniqueCode, locationZone, quantity, reservedQuantity, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [TENANT_ID, pid, lid, item.batch, fmt(item.expiry), uniqueCode, item.loc.startsWith('C') ? 'CTR' : item.loc.startsWith('R') ? 'REF' : item.loc.startsWith('H') ? 'ARM' : item.loc.includes('NCG') ? 'NCG' : 'ARM', item.qty, item.status]);
    invCreated++;
  }
  console.log(`✅ ${invCreated} posições de inventário criadas`);

  // ─────────────────────────────────────────────
  // 6. RECEBIMENTOS (histórico)
  // ─────────────────────────────────────────────
  const recLoc = locationIds['HAP-REC-01'];
  const receivings = [
    {
      orderNumber: 'REC-HAP-2024-001',
      nfeNumber: '000123',
      nfeKey: '35240163755452000130550010001230011234567890',
      supplier: 'Cristália Produtos Químicos Farmacêuticos',
      supplierCnpj: '44734671000151',
      status: 'completed',
      daysAgo: 45,
      items: [
        { sku: 'HAP-001', qty: 500, batch: 'MOR2024A', expiry: addDays(today, 730) },
        { sku: 'HAP-002', qty: 300, batch: 'MID2024A', expiry: addDays(today, 730) },
        { sku: 'HAP-003', qty: 200, batch: 'FEN2024A', expiry: addDays(today, 730) },
      ]
    },
    {
      orderNumber: 'REC-HAP-2024-002',
      nfeNumber: '000456',
      nfeKey: '35240163755452000130550010004560021234567891',
      supplier: 'Baxter Hospitalar Ltda',
      supplierCnpj: '60651809000105',
      status: 'completed',
      daysAgo: 30,
      items: [
        { sku: 'HAP-009', qty: 8000, batch: 'SF2024A', expiry: addDays(today, 900) },
        { sku: 'HAP-009', qty: 3000, batch: 'SF2024B', expiry: addDays(today, 450) },
        { sku: 'HAP-010', qty: 4000, batch: 'SG2024A', expiry: addDays(today, 800) },
      ]
    },
    {
      orderNumber: 'REC-HAP-2024-003',
      nfeNumber: '000789',
      nfeKey: '35240163755452000130550010007890031234567892',
      supplier: 'BD Becton Dickinson Ind. Cirúrgicas',
      supplierCnpj: '33009911000107',
      status: 'completed',
      daysAgo: 15,
      items: [
        { sku: 'HAP-015', qty: 10000, batch: 'SER2024A', expiry: addDays(today, 730) },
        { sku: 'HAP-016', qty: 2000, batch: 'EQP2024A', expiry: addDays(today, 730) },
      ]
    },
    {
      orderNumber: 'REC-HAP-2024-004',
      nfeNumber: '001012',
      nfeKey: '35240163755452000130550010010120041234567893',
      supplier: 'Sanofi-Aventis Farmacêutica Ltda',
      supplierCnpj: '02685377000125',
      status: 'in_quarantine',
      daysAgo: 5,
      items: [
        { sku: 'HAP-006', qty: 3600, batch: 'DIP2024A', expiry: addDays(today, 540) },
        { sku: 'HAP-008', qty: 100, batch: 'CEF2024C', expiry: addDays(today, 30) },
      ]
    },
  ];

  for (const rec of receivings) {
    const [existing] = await conn.execute('SELECT id FROM receivingOrders WHERE orderNumber=?', [rec.orderNumber]);
    if (existing.length > 0) { console.log(`  ↩ Recebimento ${rec.orderNumber} já existe`); continue; }
    const recDate = addDays(today, -rec.daysAgo);
    const [res] = await conn.execute(`
      INSERT INTO receivingOrders (tenantId, orderNumber, nfeKey, nfeNumber, supplierName, supplierCnpj, receivedDate, receivingLocationId, status, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [TENANT_ID, rec.orderNumber, rec.nfeKey, rec.nfeNumber, rec.supplier, rec.supplierCnpj, recDate, recLoc, rec.status, CREATED_BY]);
    const orderId = res.insertId;
    for (const item of rec.items) {
      const pid = productIds[item.sku];
      if (!pid) continue;
      await conn.execute(`
        INSERT INTO receivingOrderItems (tenantId, receivingOrderId, productId, expectedQuantity, receivedQuantity, addressedQuantity, batch, expiryDate, uniqueCode, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [TENANT_ID, orderId, pid, item.qty, rec.status === 'completed' ? item.qty : 0, rec.status === 'completed' ? item.qty : 0, item.batch, fmt(item.expiry), `${item.sku}:${item.batch}`, rec.status === 'completed' ? 'completed' : 'in_quarantine']);
    }
    console.log(`  ✅ Recebimento ${rec.orderNumber} criado`);
  }

  // ─────────────────────────────────────────────
  // 7. PEDIDOS DE SAÍDA (picking)
  // ─────────────────────────────────────────────
  const pickings = [
    {
      orderNumber: 'PED-HAP-2024-001',
      customerOrder: 'UTI-ADULTO-001',
      customer: 'UTI Adulto - Bloco A',
      priority: 'urgent',
      status: 'shipped',
      daysAgo: 20,
      items: [
        { sku: 'HAP-006', qty: 200, batch: 'DIP2024A' },
        { sku: 'HAP-009', qty: 500, batch: 'SF2024A' },
        { sku: 'HAP-015', qty: 1000, batch: 'SER2024A' },
      ]
    },
    {
      orderNumber: 'PED-HAP-2024-002',
      customerOrder: 'CC-ORTOPEDIA-001',
      customer: 'Centro Cirúrgico - Ortopedia',
      priority: 'normal',
      status: 'shipped',
      daysAgo: 14,
      items: [
        { sku: 'HAP-011', qty: 10, batch: 'CVC2024A' },
        { sku: 'HAP-012', qty: 50, batch: 'LUV2024A' },
        { sku: 'HAP-013', qty: 30, batch: 'VIC2024A' },
        { sku: 'HAP-014', qty: 20, batch: 'BIS2024A' },
      ]
    },
    {
      orderNumber: 'PED-HAP-2024-003',
      customerOrder: 'UTI-NEO-001',
      customer: 'UTI Neonatal',
      priority: 'emergency',
      status: 'shipped',
      daysAgo: 7,
      items: [
        { sku: 'HAP-004', qty: 20, batch: 'INS2024A' },
        { sku: 'HAP-005', qty: 30, batch: 'ADR2024A' },
        { sku: 'HAP-007', qty: 50, batch: 'OME2024A' },
      ]
    },
    {
      orderNumber: 'PED-HAP-2024-004',
      customerOrder: 'FARM-CENTRAL-001',
      customer: 'Farmácia Central',
      priority: 'normal',
      status: 'picked',
      daysAgo: 3,
      items: [
        { sku: 'HAP-001', qty: 50, batch: 'MOR2024A' },
        { sku: 'HAP-002', qty: 30, batch: 'MID2024A' },
        { sku: 'HAP-003', qty: 20, batch: 'FEN2024A' },
        { sku: 'HAP-006', qty: 500, batch: 'DIP2024A' },
        { sku: 'HAP-008', qty: 100, batch: 'CEF2024A' },
      ]
    },
    {
      orderNumber: 'PED-HAP-2024-005',
      customerOrder: 'PRONTO-SOCORRO-001',
      customer: 'Pronto-Socorro',
      priority: 'urgent',
      status: 'pending',
      daysAgo: 0,
      items: [
        { sku: 'HAP-009', qty: 200, batch: 'SF2024A' },
        { sku: 'HAP-010', qty: 100, batch: 'SG2024A' },
        { sku: 'HAP-015', qty: 500, batch: 'SER2024A' },
        { sku: 'HAP-016', qty: 100, batch: 'EQP2024A' },
        { sku: 'HAP-017', qty: 200, batch: 'CUR2024A' },
        { sku: 'HAP-018', qty: 300, batch: 'GAZ2024A' },
      ]
    },
  ];

  for (const pick of pickings) {
    const [existing] = await conn.execute('SELECT id FROM pickingOrders WHERE orderNumber=?', [pick.orderNumber]);
    if (existing.length > 0) { console.log(`  ↩ Pedido ${pick.orderNumber} já existe`); continue; }
    const pickDate = addDays(today, -pick.daysAgo);
    const totalQty = pick.items.reduce((s, i) => s + i.qty, 0);
    const [res] = await conn.execute(`
      INSERT INTO pickingOrders (tenantId, orderNumber, customerOrderNumber, customerName, priority, status, totalItems, totalQuantity, scheduledDate, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [TENANT_ID, pick.orderNumber, pick.customerOrder, pick.customer, pick.priority, pick.status, pick.items.length, totalQty, pickDate, CREATED_BY]);
    const orderId = res.insertId;
    for (const item of pick.items) {
      const pid = productIds[item.sku];
      if (!pid) continue;
      const isShipped = pick.status === 'shipped';
      const isPicked = pick.status === 'picked' || isShipped;
      await conn.execute(`
        INSERT INTO pickingOrderItems (pickingOrderId, productId, requestedQuantity, pickedQuantity, batch, uniqueCode, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [orderId, pid, item.qty, isPicked ? item.qty : 0, item.batch, `${item.sku}:${item.batch}`, isPicked ? 'picked' : 'pending']);
    }
    console.log(`  ✅ Pedido ${pick.orderNumber} criado (${pick.status})`);
  }

  // ─────────────────────────────────────────────
  // 8. MOVIMENTAÇÕES DE INVENTÁRIO (histórico)
  // ─────────────────────────────────────────────
  const movements = [
    { sku: 'HAP-006', fromLoc: null, toLoc: 'H01-01-01', qty: 2400, type: 'receiving', batch: 'DIP2024A', daysAgo: 45 },
    { sku: 'HAP-009', fromLoc: null, toLoc: 'H01-03-01', qty: 8000, type: 'receiving', batch: 'SF2024A', daysAgo: 30 },
    { sku: 'HAP-015', fromLoc: null, toLoc: 'H02-03-01', qty: 10000, type: 'receiving', batch: 'SER2024A', daysAgo: 15 },
    { sku: 'HAP-006', fromLoc: 'H01-01-01', toLoc: null, qty: 200, type: 'picking', batch: 'DIP2024A', daysAgo: 20 },
    { sku: 'HAP-009', fromLoc: 'H01-03-01', toLoc: null, qty: 500, type: 'picking', batch: 'SF2024A', daysAgo: 20 },
    { sku: 'HAP-004', fromLoc: null, toLoc: 'R01-01-01', qty: 400, type: 'receiving', batch: 'INS2024A', daysAgo: 60 },
    { sku: 'HAP-001', fromLoc: null, toLoc: 'C01-01-01', qty: 500, type: 'receiving', batch: 'MOR2024A', daysAgo: 45 },
    { sku: 'HAP-001', fromLoc: 'C01-01-01', toLoc: null, qty: 50, type: 'picking', batch: 'MOR2024A', daysAgo: 3 },
  ];

  let movCreated = 0;
  for (const m of movements) {
    const pid = productIds[m.sku];
    if (!pid) continue;
    const fromId = m.fromLoc ? locationIds[m.fromLoc] : null;
    const toId = m.toLoc ? locationIds[m.toLoc] : null;
    const movDate = addDays(today, -m.daysAgo);
    await conn.execute(`
      INSERT INTO inventoryMovements (tenantId, productId, batch, uniqueCode, fromLocationId, toLocationId, quantity, movementType, referenceType, performedBy, conversionSource, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, 'uCom', ?)
    `, [TENANT_ID, pid, m.batch, `${m.sku}:${m.batch}`, fromId, toId, m.qty, m.type, CREATED_BY, movDate]);
    movCreated++;
  }
  console.log(`✅ ${movCreated} movimentações criadas`);

  // ─────────────────────────────────────────────
  // RESUMO FINAL
  // ─────────────────────────────────────────────
  const [invCount] = await conn.execute('SELECT COUNT(*) as c, SUM(quantity) as total FROM inventory WHERE tenantId=?', [TENANT_ID]);
  const [recCount] = await conn.execute('SELECT COUNT(*) as c FROM receivingOrders WHERE tenantId=?', [TENANT_ID]);
  const [pickCount] = await conn.execute('SELECT COUNT(*) as c FROM pickingOrders WHERE tenantId=?', [TENANT_ID]);
  const [locCount] = await conn.execute('SELECT COUNT(*) as c FROM warehouseLocations WHERE tenantId=?', [TENANT_ID]);

  console.log('\n═══════════════════════════════════════');
  console.log('  HAPVIDA - SEED CONCLUÍDO');
  console.log('═══════════════════════════════════════');
  console.log(`  Tenant ID   : ${TENANT_ID}`);
  console.log(`  Endereços   : ${locCount[0].c}`);
  console.log(`  Produtos    : ${products.length}`);
  console.log(`  Inv. posições: ${invCount[0].c} (${invCount[0].total} UN total)`);
  console.log(`  Recebimentos: ${recCount[0].c}`);
  console.log(`  Pedidos     : ${pickCount[0].c}`);
  console.log('═══════════════════════════════════════\n');

  await conn.end();
}

main().catch(e => { console.error('❌ Erro:', e.message); process.exit(1); });
