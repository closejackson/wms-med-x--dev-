/**
 * Seed: Módulo Intra-Hospitalar — Hapvida (tenantId = 40001)
 * Cria deliveryPoints (docas + farmácias) e deliveryLogs (rastreabilidade last-mile)
 * para os pedidos já existentes do Hapvida.
 */
import { createConnection } from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL não definida no ambiente');

const TENANT_ID = 40001;

// Pedidos existentes do Hapvida
const ORDERS = {
  PED001: 570001, // shipped — UTI Adulto
  PED002: 570002, // shipped — Centro Cirúrgico
  PED003: 570003, // shipped — UTI Neonatal
  PED004: 570004, // picked — Farmácia Central
  PED005: 570005, // pending — Pronto-Socorro
};

// ─── Pontos de Entrega ────────────────────────────────────────────────────────
const DELIVERY_POINTS = [
  // DOCAS (entrada no complexo)
  { externalCode: 'DOCK-A', name: 'Doca A — Entrada Principal', type: 'DOCK', floor: 'Térreo', description: 'Doca principal de recebimento de medicamentos e materiais' },
  { externalCode: 'DOCK-B', name: 'Doca B — Entrada Lateral', type: 'DOCK', floor: 'Térreo', description: 'Doca secundária para materiais cirúrgicos e refrigerados' },

  // FARMÁCIAS (destino final)
  { externalCode: 'FARM-CENTRAL', name: 'Farmácia Central', type: 'PHARMACY', floor: 'Térreo — Bloco A', description: 'Farmácia central de distribuição interna' },
  { externalCode: 'FARM-UTI-ADU', name: 'Farmácia UTI Adulto', type: 'PHARMACY', floor: '3º Andar — Bloco B', description: 'Farmácia satélite da UTI Adulto' },
  { externalCode: 'FARM-UTI-NEO', name: 'Farmácia UTI Neonatal', type: 'PHARMACY', floor: '4º Andar — Bloco B', description: 'Farmácia satélite da UTI Neonatal' },
  { externalCode: 'FARM-CC',      name: 'Farmácia Centro Cirúrgico', type: 'PHARMACY', floor: '2º Andar — Bloco C', description: 'Farmácia satélite do Centro Cirúrgico' },
  { externalCode: 'FARM-PS',      name: 'Farmácia Pronto-Socorro', type: 'PHARMACY', floor: 'Térreo — Bloco D', description: 'Farmácia satélite do Pronto-Socorro' },
  { externalCode: 'FARM-ONCO',    name: 'Farmácia Oncologia', type: 'PHARMACY', floor: '5º Andar — Bloco E', description: 'Farmácia satélite da Oncologia' },
];

// Helper: subtrai minutos de uma data
function minutesAgo(date, minutes) {
  return new Date(date.getTime() - minutes * 60 * 1000);
}

async function main() {
  const conn = await createConnection(DATABASE_URL);
  console.log('✅ Conectado ao banco');

  // ── 1. Habilitar módulo intra-hospitalar para o Hapvida ──────────────────────
  await conn.execute(
    'UPDATE tenants SET intraHospitalEnabled = 1 WHERE id = ?',
    [TENANT_ID]
  );
  console.log('✅ Módulo intra-hospitalar habilitado para Hapvida');

  // ── 2. Criar Pontos de Entrega ───────────────────────────────────────────────
  const dpIds = {};
  for (const dp of DELIVERY_POINTS) {
    const [existing] = await conn.execute(
      'SELECT id FROM deliveryPoints WHERE tenantId = ? AND externalCode = ?',
      [TENANT_ID, dp.externalCode]
    );
    if (existing.length > 0) {
      dpIds[dp.externalCode] = existing[0].id;
      console.log(`  ⏭  DeliveryPoint ${dp.externalCode} já existe (id=${existing[0].id})`);
      continue;
    }
    const [result] = await conn.execute(
      `INSERT INTO deliveryPoints (tenantId, name, type, externalCode, description, floor, isActive)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [TENANT_ID, dp.name, dp.type, dp.externalCode, dp.description, dp.floor]
    );
    dpIds[dp.externalCode] = result.insertId;
    console.log(`  ✅ DeliveryPoint ${dp.externalCode} criado (id=${result.insertId})`);
  }

  // ── 3. Criar DeliveryLogs (rastreabilidade last-mile) ────────────────────────
  // Cada pedido shipped/picked terá um histórico completo de checkpoints
  const now = new Date();

  const scenarios = [
    // PED001 — UTI Adulto — CONCLUÍDO (fluxo completo)
    {
      orderId: ORDERS.PED001,
      dock: 'DOCK-A',
      pharmacy: 'FARM-UTI-ADU',
      baseTime: minutesAgo(now, 480), // 8h atrás
      logs: [
        { status: 'ARRIVED_COMPLEX',   offsetMin: 0,   notes: 'Carga recebida na doca A — 3 volumes' },
        { status: 'DEPARTED_TO_UNIT',  offsetMin: 25,  notes: 'Saiu para UTI Adulto — 3º Andar Bloco B' },
        { status: 'ARRIVED_UNIT',      offsetMin: 55,  notes: 'Entregue na farmácia UTI Adulto' },
        { status: 'RECEIVING_STARTED', offsetMin: 60,  notes: 'Conferência iniciada pela farmacêutica Dra. Ana Lima' },
        { status: 'RECEIVE_COMPLETE',  offsetMin: 75,  notes: 'Recebimento confirmado — 3/3 volumes OK' },
      ],
    },
    // PED002 — Centro Cirúrgico — CONCLUÍDO (fluxo completo)
    {
      orderId: ORDERS.PED002,
      dock: 'DOCK-B',
      pharmacy: 'FARM-CC',
      baseTime: minutesAgo(now, 360), // 6h atrás
      logs: [
        { status: 'ARRIVED_COMPLEX',   offsetMin: 0,   notes: 'Carga refrigerada recebida na doca B — 2 volumes' },
        { status: 'DEPARTED_TO_UNIT',  offsetMin: 15,  notes: 'Saiu para Centro Cirúrgico — 2º Andar Bloco C' },
        { status: 'ARRIVED_UNIT',      offsetMin: 35,  notes: 'Entregue na farmácia do CC' },
        { status: 'RECEIVING_STARTED', offsetMin: 40,  notes: 'Conferência iniciada' },
        { status: 'RECEIVE_COMPLETE',  offsetMin: 58,  notes: 'Recebimento confirmado — 2/2 volumes OK. Temperatura: 4°C' },
      ],
    },
    // PED003 — UTI Neonatal — CONCLUÍDO (com observação)
    {
      orderId: ORDERS.PED003,
      dock: 'DOCK-A',
      pharmacy: 'FARM-UTI-NEO',
      baseTime: minutesAgo(now, 240), // 4h atrás
      logs: [
        { status: 'ARRIVED_COMPLEX',   offsetMin: 0,   notes: 'Carga recebida na doca A — 4 volumes' },
        { status: 'DEPARTED_TO_UNIT',  offsetMin: 20,  notes: 'Saiu para UTI Neonatal — 4º Andar Bloco B' },
        { status: 'ARRIVED_UNIT',      offsetMin: 50,  notes: 'Entregue na farmácia UTI Neonatal' },
        { status: 'RECEIVING_STARTED', offsetMin: 55,  notes: 'Conferência iniciada' },
        { status: 'RECEIVE_COMPLETE',  offsetMin: 80,  notes: 'Recebimento confirmado — 4/4 volumes OK. Obs: 1 embalagem com amassado externo sem dano ao produto' },
      ],
    },
    // PED004 — Farmácia Central — EM TRÂNSITO (parcial)
    {
      orderId: ORDERS.PED004,
      dock: 'DOCK-A',
      pharmacy: 'FARM-CENTRAL',
      baseTime: minutesAgo(now, 90), // 1h30 atrás
      logs: [
        { status: 'ARRIVED_COMPLEX',   offsetMin: 0,   notes: 'Carga recebida na doca A — 5 volumes' },
        { status: 'DEPARTED_TO_UNIT',  offsetMin: 30,  notes: 'Saiu para Farmácia Central — Térreo Bloco A' },
        { status: 'ARRIVED_UNIT',      offsetMin: 50,  notes: 'Entregue na farmácia central' },
        // Não chegou a RECEIVING_STARTED ainda — em espera
      ],
    },
    // PED005 — Pronto-Socorro — AGUARDANDO EXPEDIÇÃO (apenas criado)
    // Sem logs ainda — pedido ainda não saiu do armazém
  ];

  let totalLogs = 0;
  for (const scenario of scenarios) {
    // Usar dock para ARRIVED_COMPLEX e DEPARTED_TO_UNIT; pharmacy para os demais
    for (const log of scenario.logs) {
      const dpCode = ['ARRIVED_COMPLEX', 'DEPARTED_TO_UNIT'].includes(log.status)
        ? scenario.dock
        : scenario.pharmacy;
      const dpId = dpIds[dpCode];
      const ts = new Date(scenario.baseTime.getTime() + log.offsetMin * 60 * 1000);

      await conn.execute(
        `INSERT INTO deliveryLogs (tenantId, orderId, deliveryPointId, status, timestamp, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [TENANT_ID, scenario.orderId, dpId, log.status, ts, log.notes]
      );
      totalLogs++;
    }
    console.log(`  ✅ Logs criados para pedido ${scenario.orderId} (${scenario.logs.length} checkpoints)`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  HAPVIDA — MÓDULO INTRA-HOSPITALAR SEED CONCLUÍDO');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Pontos de Entrega : ${Object.keys(dpIds).length} (2 docas + 6 farmácias)`);
  console.log(`  DeliveryLogs      : ${totalLogs} checkpoints`);
  console.log(`  Pedidos rastreados: 4 de 5 (PED005 aguarda expedição)`);
  console.log('═══════════════════════════════════════════════════');

  await conn.end();
}

main().catch(err => { console.error('❌ Erro:', err.message); process.exit(1); });
