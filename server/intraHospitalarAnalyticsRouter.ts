/**
 * intraHospitalarAnalyticsRouter.ts
 * Dashboard de Performance — Módulo Intra-Hospitalar
 *
 * Queries de analytics sobre a View v_delivery_analytics:
 *   - getLeadTimeStats: médias de tempo por farmácia e por doca
 *   - getWipStatus:     contagem de pedidos em cada estágio
 *   - getAlerts:        pedidos que excederam o SLA configurado
 *   - getArrivalsByHour: volume de chegadas na doca por hora do dia
 *   - getWaveDeliveryTimes: tempo total de entrega por romaneio
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "./_core/trpc";
import { tenantProcedure } from "./_core/tenantGuard";
import { getDb } from "./db";
import { sql } from "drizzle-orm";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMinutes(minutes: number | null): string | null {
  if (minutes === null || minutes === undefined) return null;
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/** Formata uma Date para string MySQL 'YYYY-MM-DD HH:MM:SS' */
function toMysqlDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Retorna cláusulas SQL de período para a coluna `col` */
function dateRangeClause(col: string, startDate?: Date, endDate?: Date): string {
  const parts: string[] = [];
  if (startDate) parts.push(`${col} >= '${toMysqlDatetime(startDate)}'`);
  if (endDate) {
    // endDate é o fim do dia selecionado
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    parts.push(`${col} <= '${toMysqlDatetime(end)}'`);
  }
  return parts.length ? parts.map(p => `AND ${p}`).join("\n          ") : "";
}

// Schema de período reutilizável
const periodSchema = z.object({
  tenantId: z.number().optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const intraHospitalarAnalyticsRouter = router({

  /**
   * getLeadTimeStats
   * Retorna médias de tempo de ciclo por farmácia (ARRIVED_UNIT) e por doca.
   * Inclui também as médias globais do tenant.
   */
  getLeadTimeStats: tenantProcedure
    .input(periodSchema)
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId
        ? input.tenantId
        : ctx.effectiveTenantId;

      if (!effectiveTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "tenantId obrigatório" });

      const dateClause = dateRangeClause("last_timestamp", input.startDate, input.endDate);

      // Médias globais do tenant
      const [globalRows] = await (db as any).execute(sql.raw(`
        SELECT
          COUNT(*) AS total_pedidos,
          ROUND(AVG(tempo_permanencia_doca), 1)    AS avg_doca,
          ROUND(AVG(tempo_transito_interno), 1)    AS avg_transito,
          ROUND(AVG(tempo_conferencia_unidade), 1) AS avg_conferencia,
          ROUND(AVG(tempo_total_interno), 1)       AS avg_total,
          SUM(is_complete)                         AS total_concluidos
        FROM v_delivery_analytics
        WHERE tenantId = ${effectiveTenantId}
          ${dateClause}
      `));

      // Médias por farmácia (deliveryPoint)
      const [byPharmacyRows] = await (db as any).execute(sql.raw(`
        SELECT
          va.delivery_point_id,
          dp.name AS point_name,
          dp.type AS point_type,
          dp.floor AS point_floor,
          COUNT(*) AS total_pedidos,
          ROUND(AVG(va.tempo_conferencia_unidade), 1) AS avg_conferencia,
          ROUND(AVG(va.tempo_total_interno), 1)       AS avg_total,
          SUM(va.is_complete)                         AS total_concluidos
        FROM v_delivery_analytics va
        LEFT JOIN deliveryPoints dp ON dp.id = va.delivery_point_id
        WHERE va.tenantId = ${effectiveTenantId}
          AND va.delivery_point_id IS NOT NULL
          ${dateClause}
        GROUP BY va.delivery_point_id, dp.name, dp.type, dp.floor
        ORDER BY avg_total DESC
      `));

      const global = Array.isArray(globalRows) ? globalRows[0] : globalRows;

      return {
        global: {
          totalPedidos: Number(global?.total_pedidos ?? 0),
          totalConcluidos: Number(global?.total_concluidos ?? 0),
          avgDoca: Number(global?.avg_doca ?? 0) || null,
          avgTransito: Number(global?.avg_transito ?? 0) || null,
          avgConferencia: Number(global?.avg_conferencia ?? 0) || null,
          avgTotal: Number(global?.avg_total ?? 0) || null,
          avgDocaFormatted: formatMinutes(Number(global?.avg_doca) || null),
          avgTransitoFormatted: formatMinutes(Number(global?.avg_transito) || null),
          avgConferenciaFormatted: formatMinutes(Number(global?.avg_conferencia) || null),
          avgTotalFormatted: formatMinutes(Number(global?.avg_total) || null),
        },
        byPharmacy: (Array.isArray(byPharmacyRows) ? byPharmacyRows : []).map((row: any) => ({
          pointId: Number(row.delivery_point_id),
          pointName: row.point_name ?? `Ponto ${row.delivery_point_id}`,
          pointType: row.point_type ?? "PHARMACY",
          pointFloor: row.point_floor ?? null,
          totalPedidos: Number(row.total_pedidos),
          totalConcluidos: Number(row.total_concluidos),
          avgConferencia: Number(row.avg_conferencia) || null,
          avgTotal: Number(row.avg_total) || null,
          avgConferenciaFormatted: formatMinutes(Number(row.avg_conferencia) || null),
          avgTotalFormatted: formatMinutes(Number(row.avg_total) || null),
        })),
      };
    }),

  /**
   * getWipStatus
   * Retorna contagem de pedidos em cada estágio do fluxo intra-hospitalar.
   * WIP = Work In Progress (pedidos ainda não concluídos).
   */
  getWipStatus: tenantProcedure
    .input(periodSchema)
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId
        ? input.tenantId
        : ctx.effectiveTenantId;

      if (!effectiveTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "tenantId obrigatório" });

      const dateClause = dateRangeClause("last_timestamp", input.startDate, input.endDate);

      const [rows] = await (db as any).execute(sql.raw(`
        SELECT
          current_status,
          COUNT(*) AS total
        FROM v_delivery_analytics
        WHERE tenantId = ${effectiveTenantId}
          ${dateClause}
        GROUP BY current_status
      `));

      const statusMap: Record<string, number> = {};
      for (const row of (Array.isArray(rows) ? rows : [])) {
        statusMap[row.current_status] = Number(row.total);
      }

      const total = Object.values(statusMap).reduce((a, b) => a + b, 0);
      const concluidos = statusMap["RECEIVE_COMPLETE"] ?? 0;
      const emAberto = total - concluidos;

      return {
        total,
        concluidos,
        emAberto,
        porStatus: {
          ARRIVED_COMPLEX:   statusMap["ARRIVED_COMPLEX"]   ?? 0,
          DEPARTED_TO_UNIT:  statusMap["DEPARTED_TO_UNIT"]  ?? 0,
          ARRIVED_UNIT:      statusMap["ARRIVED_UNIT"]      ?? 0,
          RECEIVING_STARTED: statusMap["RECEIVING_STARTED"] ?? 0,
          RECEIVE_COMPLETE:  statusMap["RECEIVE_COMPLETE"]  ?? 0,
        },
        // Agrupamentos para cards de resumo
        naDoca:     (statusMap["ARRIVED_COMPLEX"] ?? 0) + (statusMap["DEPARTED_TO_UNIT"] ?? 0),
        emTransito: statusMap["DEPARTED_TO_UNIT"] ?? 0,
        naFarmacia: (statusMap["ARRIVED_UNIT"] ?? 0) + (statusMap["RECEIVING_STARTED"] ?? 0),
      };
    }),

  /**
   * getAlerts
   * Retorna pedidos que excederam o SLA configurado em qualquer checkpoint.
   * slaMinutes: tempo máximo permitido em qualquer fase (padrão: 120min = 2h)
   */
  getAlerts: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      slaMinutes: z.number().min(1).max(1440).default(120),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId
        ? input.tenantId
        : ctx.effectiveTenantId;

      if (!effectiveTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "tenantId obrigatório" });

      const sla = input.slaMinutes;
      const dateClause = dateRangeClause("va.last_timestamp", input.startDate, input.endDate);

      const [rows] = await (db as any).execute(sql.raw(`
        SELECT
          va.orderId,
          va.current_status,
          va.tempo_permanencia_doca,
          va.tempo_transito_interno,
          va.tempo_conferencia_unidade,
          va.tempo_total_interno,
          va.last_timestamp,
          va.delivery_point_id,
          dp.name AS point_name,
          po.customerOrderNumber,
          -- Fase com maior atraso
          GREATEST(
            COALESCE(va.tempo_permanencia_doca, 0),
            COALESCE(va.tempo_transito_interno, 0),
            COALESCE(va.tempo_conferencia_unidade, 0)
          ) AS max_fase_minutos,
          -- Tempo em aberto desde o último checkpoint
          TIMESTAMPDIFF(MINUTE, va.last_timestamp, NOW()) AS tempo_em_aberto
        FROM v_delivery_analytics va
        LEFT JOIN deliveryPoints dp ON dp.id = va.delivery_point_id
        LEFT JOIN pickingOrders po ON po.id = va.orderId
        WHERE va.tenantId = ${effectiveTenantId}
          AND va.is_complete = 0
          ${dateClause}
          AND (
            va.tempo_permanencia_doca    > ${sla}
            OR va.tempo_transito_interno > ${sla}
            OR va.tempo_conferencia_unidade > ${sla}
            OR TIMESTAMPDIFF(MINUTE, va.last_timestamp, NOW()) > ${sla}
          )
        ORDER BY max_fase_minutos DESC
        LIMIT 100
      `));

      return (Array.isArray(rows) ? rows : []).map((row: any) => ({
        orderId: Number(row.orderId),
        customerOrderNumber: row.customerOrderNumber ?? `#${row.orderId}`,
        currentStatus: row.current_status,
        pointName: row.point_name ?? null,
        tempoPermanenciaDoca: Number(row.tempo_permanencia_doca) || null,
        tempoTransitoInterno: Number(row.tempo_transito_interno) || null,
        tempoConferenciaUnidade: Number(row.tempo_conferencia_unidade) || null,
        tempoTotalInterno: Number(row.tempo_total_interno) || null,
        tempoEmAberto: Number(row.tempo_em_aberto) || null,
        maxFaseMinutos: Number(row.max_fase_minutos) || null,
        maxFaseFormatted: formatMinutes(Number(row.max_fase_minutos) || null),
        lastTimestamp: row.last_timestamp,
        slaMinutes: sla,
        slaExceededBy: Math.max(0, (Number(row.max_fase_minutos) || 0) - sla),
      }));
    }),

  /**
   * getArrivalsByHour
   * Retorna o volume de chegadas na doca (ARRIVED_COMPLEX) por hora do dia.
   * Útil para o gráfico de área de distribuição horária.
   */
  getArrivalsByHour: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      days: z.number().min(1).max(90).default(30),
      // offset do fuso horário do cliente em minutos (ex: -180 para UTC-3)
      tzOffsetMinutes: z.number().min(-840).max(840).default(0),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId
        ? input.tenantId
        : ctx.effectiveTenantId;

      if (!effectiveTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "tenantId obrigatório" });

      // Converter offset em minutos para string HH:MM (ex: -180 → '-03:00')
      const sign = input.tzOffsetMinutes >= 0 ? '+' : '-';
      const absMin = Math.abs(input.tzOffsetMinutes);
      const tzStr = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;

      // Se há período definido, usa startDate/endDate; caso contrário, usa `days`
      let timeFilter: string;
      if (input.startDate || input.endDate) {
        const parts: string[] = [];
        if (input.startDate) parts.push(`AND timestamp >= '${toMysqlDatetime(input.startDate)}'`);
        if (input.endDate) {
          const end = new Date(input.endDate);
          end.setHours(23, 59, 59, 999);
          parts.push(`AND timestamp <= '${toMysqlDatetime(end)}'`);
        }
        timeFilter = parts.join("\n          ");
      } else {
        timeFilter = `AND timestamp >= DATE_SUB(NOW(), INTERVAL ${input.days} DAY)`;
      }

      const [rows] = await (db as any).execute(sql.raw(`
        SELECT
          HOUR(CONVERT_TZ(timestamp, '+00:00', '${tzStr}')) AS hora,
          COUNT(*) AS total
        FROM deliveryLogs
        WHERE tenantId = ${effectiveTenantId}
          AND status = 'ARRIVED_COMPLEX'
          ${timeFilter}
        GROUP BY HOUR(CONVERT_TZ(timestamp, '+00:00', '${tzStr}'))
        ORDER BY hora ASC
      `));

      // Preencher todas as 24 horas (mesmo as sem registros)
      const hourMap: Record<number, number> = {};
      for (const row of (Array.isArray(rows) ? rows : [])) {
        hourMap[Number(row.hora)] = Number(row.total);
      }

      return Array.from({ length: 24 }, (_, h) => ({
        hora: h,
        horaLabel: `${String(h).padStart(2, "0")}:00`,
        total: hourMap[h] ?? 0,
      }));
    }),

  /**
   * getWaveDeliveryTimes
   * Tempo total de entrega por romaneio (wave):
   * do primeiro ARRIVED_COMPLEX (chegada na doca) até o último RECEIVE_COMPLETE
   * (conclusão da última farmácia) dentre todos os pedidos do romaneio.
   */
  getWaveDeliveryTimes: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      days: z.number().min(1).max(90).default(30),
      limit: z.number().min(1).max(200).default(50),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId
        ? input.tenantId
        : ctx.effectiveTenantId;

      if (!effectiveTenantId) throw new TRPCError({ code: "BAD_REQUEST", message: "tenantId obrigatório" });

      // Filtro de período para pickingWaves.createdAt
      let waveDateFilter: string;
      if (input.startDate || input.endDate) {
        const parts: string[] = [];
        if (input.startDate) parts.push(`AND pw.createdAt >= '${toMysqlDatetime(input.startDate)}'`);
        if (input.endDate) {
          const end = new Date(input.endDate);
          end.setHours(23, 59, 59, 999);
          parts.push(`AND pw.createdAt <= '${toMysqlDatetime(end)}'`);
        }
        waveDateFilter = parts.join("\n          ");
      } else {
        waveDateFilter = `AND pw.createdAt >= DATE_SUB(NOW(), INTERVAL ${input.days} DAY)`;
      }

      const [rows] = await (db as any).execute(sql.raw(`
        SELECT
          pw.id                                    AS waveId,
          pw.waveNumber                            AS romaneio,
          COUNT(DISTINCT po.id)                    AS totalOrders,
          MIN(dl_first.firstArrival)               AS inicioEntrega,
          MAX(dl_last.lastComplete)                AS fimEntrega,
          TIMESTAMPDIFF(
            MINUTE,
            MIN(dl_first.firstArrival),
            MAX(dl_last.lastComplete)
          )                                        AS duracaoMinutos
        FROM pickingWaves pw
        JOIN pickingOrders po
          ON po.waveId = pw.id
          AND po.tenantId = ${effectiveTenantId}
        -- Primeira chegada na doca por pedido
        LEFT JOIN (
          SELECT orderId, MIN(timestamp) AS firstArrival
          FROM deliveryLogs
          WHERE status = 'ARRIVED_COMPLEX'
            AND tenantId = ${effectiveTenantId}
          GROUP BY orderId
        ) dl_first ON dl_first.orderId = po.id
        -- Última conclusão de recebimento por pedido
        LEFT JOIN (
          SELECT orderId, MAX(timestamp) AS lastComplete
          FROM deliveryLogs
          WHERE status = 'RECEIVE_COMPLETE'
            AND tenantId = ${effectiveTenantId}
          GROUP BY orderId
        ) dl_last ON dl_last.orderId = po.id
        WHERE pw.tenantId = ${effectiveTenantId}
          ${waveDateFilter}
          -- Só romaneios que têm ao menos uma chegada na doca registrada
          AND dl_first.firstArrival IS NOT NULL
        GROUP BY pw.id, pw.waveNumber
        HAVING fimEntrega IS NOT NULL
        ORDER BY inicioEntrega DESC
        LIMIT ${input.limit}
      `));

      return (Array.isArray(rows) ? rows : []).map((r: any) => ({
        waveId:         Number(r.waveId),
        romaneio:       String(r.romaneio),
        totalOrders:    Number(r.totalOrders),
        inicioEntrega:  r.inicioEntrega ? new Date(r.inicioEntrega) : null,
        fimEntrega:     r.fimEntrega    ? new Date(r.fimEntrega)    : null,
        duracaoMinutos: r.duracaoMinutos !== null ? Number(r.duracaoMinutos) : null,
        duracaoLabel:   r.duracaoMinutos !== null ? formatMinutes(Number(r.duracaoMinutos)) : null,
      }));
    }),
});
