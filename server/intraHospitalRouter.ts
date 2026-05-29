/**
 * intraHospitalRouter.ts
 * Módulo de Rastreabilidade Intra-Hospitalar — Last Mile Interna
 *
 * Gerencia os pontos de entrega (docas e farmácias) e os checkpoints de
 * movimentação de pedidos dentro do complexo hospitalar.
 *
 * Fluxo de status obrigatório:
 *   ARRIVED_COMPLEX → DEPARTED_TO_UNIT → ARRIVED_UNIT → RECEIVING_STARTED → RECEIVE_COMPLETE
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
import { router } from "./_core/trpc";
import { tenantProcedure, assertSameTenant, tenantFilter } from "./_core/tenantGuard";
import { getDb } from "./db";
import {
  deliveryPoints,
  deliveryLogs,
  pickingOrders,
  pickingOrderItems,
  pickingWaves,
  stageChecks,
  products,
  users,
} from "../drizzle/schema";

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Ordem obrigatória dos status de checkpoint */
const STATUS_ORDER = [
  "ARRIVED_COMPLEX",
  "DEPARTED_TO_UNIT",
  "ARRIVED_UNIT",
  "RECEIVING_STARTED",
  "RECEIVE_COMPLETE",
] as const;

type DeliveryStatus = (typeof STATUS_ORDER)[number];

/** Mapa de transições permitidas: status atual → próximos status válidos */
const ALLOWED_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  ARRIVED_COMPLEX: ["DEPARTED_TO_UNIT"],
  DEPARTED_TO_UNIT: ["ARRIVED_UNIT"],
  ARRIVED_UNIT: ["RECEIVING_STARTED"],
  RECEIVING_STARTED: ["RECEIVE_COMPLETE"],
  RECEIVE_COMPLETE: [], // estado final
};

/** Labels para exibição no frontend */
export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  ARRIVED_COMPLEX: "Chegou à Doca",
  DEPARTED_TO_UNIT: "Saiu para a Farmácia",
  ARRIVED_UNIT: "Chegou à Farmácia",
  RECEIVING_STARTED: "Recebimento Iniciado",
  RECEIVE_COMPLETE: "Recebimento Concluído",
};

// ─── Router ──────────────────────────────────────────────────────────────────

export const intraHospitalRouter = router({

  // =========================================================================
  // CRUD DE PONTOS DE ENTREGA
  // =========================================================================

  /** Lista todos os pontos de entrega do tenant */
  listDeliveryPoints: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      type: z.enum(["DOCK", "PHARMACY"]).optional(),
      includeInactive: z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const conditions = [];
      // Global Admin: usa input.tenantId se fornecido; sem tenantId = visão global (null = sem filtro)
      const filterTenantId = ctx.isGlobalAdmin
        ? (input.tenantId ?? null)
        : ctx.effectiveTenantId;
      const filter = tenantFilter(deliveryPoints.tenantId, filterTenantId, ctx.isGlobalAdmin);
      if (filter) conditions.push(filter);
      if (input.type) conditions.push(eq(deliveryPoints.type, input.type));
      if (!input.includeInactive) conditions.push(eq(deliveryPoints.isActive, true));

      return db
        .select()
        .from(deliveryPoints)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(deliveryPoints.type), asc(deliveryPoints.name));
    }),

  /** Busca um ponto de entrega pelo externalCode (para leitura de QR Code no coletor) */
  getDeliveryPointByCode: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      externalCode: z.string().min(1),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [point] = await db
        .select()
        .from(deliveryPoints)
        .where(and(
          eq(deliveryPoints.tenantId, ctx.effectiveTenantId),
          eq(deliveryPoints.externalCode, input.externalCode),
          eq(deliveryPoints.isActive, true),
        ))
        .limit(1);

      if (!point) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Ponto de entrega com código "${input.externalCode}" não encontrado.`,
        });
      }
      return point;
    }),

  /** Cria um novo ponto de entrega */
  createDeliveryPoint: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      name: z.string().min(1).max(255),
      type: z.enum(["DOCK", "PHARMACY"]),
      externalCode: z.string().min(1).max(100),
      description: z.string().optional(),
      floor: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Global Admin pode especificar o tenant do ponto; outros usam o tenant próprio
      const targetTenantId = (ctx.isGlobalAdmin && input.tenantId) ? input.tenantId : ctx.effectiveTenantId;

      // Verificar duplicidade de externalCode no tenant
      const [existing] = await db
        .select({ id: deliveryPoints.id })
        .from(deliveryPoints)
        .where(and(
          eq(deliveryPoints.tenantId, targetTenantId),
          eq(deliveryPoints.externalCode, input.externalCode),
        ))
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Já existe um ponto de entrega com o código "${input.externalCode}".`,
        });
      }

      await db.insert(deliveryPoints).values({
        tenantId: targetTenantId,
        name: input.name,
        type: input.type,
        externalCode: input.externalCode,
        description: input.description ?? null,
        floor: input.floor ?? null,
        isActive: true,
      });

      const [created] = await db
        .select()
        .from(deliveryPoints)
        .where(and(
          eq(deliveryPoints.tenantId, targetTenantId),
          eq(deliveryPoints.externalCode, input.externalCode),
        ))
        .limit(1);

      return created;
    }),

  /** Atualiza um ponto de entrega */
  updateDeliveryPoint: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      id: z.number(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      floor: z.string().optional(),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [point] = await db
        .select()
        .from(deliveryPoints)
        .where(eq(deliveryPoints.id, input.id))
        .limit(1);

      if (!point) throw new TRPCError({ code: "NOT_FOUND", message: "Ponto de entrega não encontrado." });
      assertSameTenant(point.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "ponto de entrega");

      const updateData: Partial<typeof point> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.floor !== undefined) updateData.floor = input.floor;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;

      await db.update(deliveryPoints).set(updateData).where(eq(deliveryPoints.id, input.id));
      return { success: true };
    }),

  // =========================================================================
  // CHECKPOINTS — REGISTRO DE MOVIMENTAÇÕES
  // =========================================================================

  /**
   * Registra um checkpoint para um único pedido.
   * Valida a transição de status e o tipo do ponto de entrega.
   */
  registerCheckpoint: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      orderId: z.number(),
      deliveryPointId: z.number(),
      status: z.enum(STATUS_ORDER),
      volumes: z.number().int().min(1).optional(),
      notes: z.string().optional(),
      timestamp: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validar pedido
      const [order] = await db
        .select({
          id: pickingOrders.id,
          tenantId: pickingOrders.tenantId,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          waveId: pickingOrders.waveId,
        })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
      assertSameTenant(order.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "pedido");

      // Validar ponto de entrega
      const [point] = await db
        .select()
        .from(deliveryPoints)
        .where(and(
          eq(deliveryPoints.id, input.deliveryPointId),
          eq(deliveryPoints.isActive, true),
        ))
        .limit(1);

      if (!point) throw new TRPCError({ code: "NOT_FOUND", message: "Ponto de entrega não encontrado ou inativo." });
      assertSameTenant(point.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "ponto de entrega");

      // Validar coerência entre tipo do ponto e status
      if (input.status === "ARRIVED_COMPLEX" && point.type !== "DOCK") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Status ARRIVED_COMPLEX só pode ser registrado em pontos do tipo DOCK.",
        });
      }
      if ((input.status === "ARRIVED_UNIT" || input.status === "RECEIVING_STARTED" || input.status === "RECEIVE_COMPLETE") && point.type !== "PHARMACY") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Status ${input.status} só pode ser registrado em pontos do tipo PHARMACY.`,
        });
      }

      // Buscar histórico de checkpoints do pedido (ordenado por timestamp)
      const allLogs = await db
        .select({ status: deliveryLogs.status, deliveryPointId: deliveryLogs.deliveryPointId, pointName: deliveryPoints.name })
        .from(deliveryLogs)
        .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
        .where(and(
          eq(deliveryLogs.orderId, input.orderId),
          eq(deliveryLogs.tenantId, order.tenantId),
        ))
        .orderBy(desc(deliveryLogs.timestamp));

      const lastLog = allLogs[0];

      // Validar transição de status
      if (lastLog) {
        const currentStatus = lastLog.status as DeliveryStatus;
        const allowed = ALLOWED_TRANSITIONS[currentStatus];
        if (!allowed.includes(input.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Transição inválida: ${STATUS_LABELS[currentStatus]} → ${STATUS_LABELS[input.status]}. Próximo status esperado: ${allowed.map(s => STATUS_LABELS[s]).join(" ou ")}.`,
          });
        }
      } else {
        // Primeiro checkpoint: deve ser ARRIVED_COMPLEX
        if (input.status !== "ARRIVED_COMPLEX") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Primeiro checkpoint deve ser "Chegou à Doca" (ARRIVED_COMPLEX). Status recebido: ${STATUS_LABELS[input.status]}.`,
          });
        }
      }

      // ── Validação de consistência de ponto de entrega ──────────────────────
      // Regra: o pedido deve permanecer no mesmo ponto de entrega dentro de
      // cada "fase" (doca ou farmácia). Uma vez que chegou a uma farmácia
      // específica, todos os checkpoints seguintes devem ser nessa mesma farmácia.
      if (input.status === "DEPARTED_TO_UNIT") {
        // Deve usar a mesma doca do ARRIVED_COMPLEX
        const arrivedComplex = allLogs.find(l => l.status === "ARRIVED_COMPLEX");
        if (arrivedComplex && arrivedComplex.deliveryPointId !== input.deliveryPointId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Inconsistência de ponto: pedido chegou via "${arrivedComplex.pointName ?? arrivedComplex.deliveryPointId}". Use o mesmo ponto para registrar a saída.`,
          });
        }
      }
      if (["RECEIVING_STARTED", "RECEIVE_COMPLETE"].includes(input.status)) {
        // Deve usar a mesma farmácia do ARRIVED_UNIT
        const arrivedUnit = allLogs.find(l => l.status === "ARRIVED_UNIT");
        if (arrivedUnit && arrivedUnit.deliveryPointId !== input.deliveryPointId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Inconsistência de ponto: pedido chegou à "${arrivedUnit.pointName ?? arrivedUnit.deliveryPointId}". Todos os checkpoints desta fase devem ser registrados no mesmo ponto.`,
          });
        }
      }

      // Buscar waveNumber do romaneio associado ao pedido
      let waveNumber: string | null = null;
      if (order.waveId) {
        const [wave] = await db
          .select({ waveNumber: pickingWaves.waveNumber })
          .from(pickingWaves)
          .where(eq(pickingWaves.id, order.waveId))
          .limit(1);
        waveNumber = wave?.waveNumber ?? null;
      }

      // Registrar checkpoint — usa tenantId do pedido, não do usuário logado
      await db.insert(deliveryLogs).values({
        tenantId: order.tenantId,
        orderId: input.orderId,
        deliveryPointId: input.deliveryPointId,
        status: input.status,
        timestamp: input.timestamp ?? new Date(),
        userId: ctx.user.id,
        notes: input.notes ?? null,
        waveNumber,
      });

      return {
        success: true,
        orderId: input.orderId,
        status: input.status,
        statusLabel: STATUS_LABELS[input.status],
        pointName: point.name,
      };
    }),

  /**
   * Registra um checkpoint para múltiplos pedidos de uma vez (Batch Update).
   * Ideal para o coletor: operador bipa o ponto e depois bipa vários pedidos.
   */
  batchRegisterCheckpoint: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      orderIds: z.array(z.number()).min(1).max(50),
      deliveryPointId: z.number(),
      status: z.enum(STATUS_ORDER),
      notes: z.string().optional(),
      timestamp: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validar ponto de entrega
      const [point] = await db
        .select()
        .from(deliveryPoints)
        .where(and(
          eq(deliveryPoints.id, input.deliveryPointId),
          eq(deliveryPoints.isActive, true),
        ))
        .limit(1);

      if (!point) throw new TRPCError({ code: "NOT_FOUND", message: "Ponto de entrega não encontrado ou inativo." });
      assertSameTenant(point.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "ponto de entrega");

      // Validar coerência tipo do ponto x status
      if (input.status === "ARRIVED_COMPLEX" && point.type !== "DOCK") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Status ARRIVED_COMPLEX só pode ser registrado em pontos DOCK." });
      }
      if (["ARRIVED_UNIT", "RECEIVING_STARTED", "RECEIVE_COMPLETE"].includes(input.status) && point.type !== "PHARMACY") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Status ${input.status} só pode ser registrado em pontos PHARMACY.` });
      }
      // Validar pedidos e buscar último checkpoint de cada um
      const orders = await db
        .select({ id: pickingOrders.id, tenantId: pickingOrders.tenantId, customerOrderNumber: pickingOrders.customerOrderNumber })
        .from(pickingOrders)
        .where(inArray(pickingOrders.id, input.orderIds));

      const results: { orderId: number; success: boolean; error?: string; orderNumber?: string }[] = [];
      const ts = input.timestamp ?? new Date();

      for (const order of orders) {
        try {
          assertSameTenant(order.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "pedido");

           // Buscar histórico de checkpoints do pedido
          const orderLogs = await db
            .select({ status: deliveryLogs.status, deliveryPointId: deliveryLogs.deliveryPointId, pointName: deliveryPoints.name })
            .from(deliveryLogs)
            .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
            .where(and(
              eq(deliveryLogs.orderId, order.id),
              eq(deliveryLogs.tenantId, order.tenantId),
            ))
            .orderBy(desc(deliveryLogs.timestamp));

          const lastLog = orderLogs[0];

          // Validar transição de status
          if (lastLog) {
            const currentStatus = lastLog.status as DeliveryStatus;
            const allowed = ALLOWED_TRANSITIONS[currentStatus];
            if (!allowed.includes(input.status)) {
              results.push({
                orderId: order.id,
                orderNumber: order.customerOrderNumber ?? undefined,
                success: false,
                error: `Transição inválida: ${STATUS_LABELS[currentStatus]} → ${STATUS_LABELS[input.status]}`,
              });
              continue;
            }
          } else if (input.status !== "ARRIVED_COMPLEX") {
            results.push({
              orderId: order.id,
              orderNumber: order.customerOrderNumber ?? undefined,
              success: false,
              error: `Primeiro checkpoint deve ser ARRIVED_COMPLEX`,
            });
            continue;
          }

          // Validar consistência de ponto de entrega
          if (input.status === "DEPARTED_TO_UNIT") {
            const arrivedComplex = orderLogs.find(l => l.status === "ARRIVED_COMPLEX");
            if (arrivedComplex && arrivedComplex.deliveryPointId !== input.deliveryPointId) {
              results.push({
                orderId: order.id,
                orderNumber: order.customerOrderNumber ?? undefined,
                success: false,
                error: `Inconsistência de ponto: pedido chegou via "${arrivedComplex.pointName ?? arrivedComplex.deliveryPointId}". Use o mesmo ponto para registrar a saída.`,
              });
              continue;
            }
          }
          if (["RECEIVING_STARTED", "RECEIVE_COMPLETE"].includes(input.status)) {
            const arrivedUnit = orderLogs.find(l => l.status === "ARRIVED_UNIT");
            if (arrivedUnit && arrivedUnit.deliveryPointId !== input.deliveryPointId) {
              results.push({
                orderId: order.id,
                orderNumber: order.customerOrderNumber ?? undefined,
                success: false,
                error: `Inconsistência de ponto: pedido chegou à "${arrivedUnit.pointName ?? arrivedUnit.deliveryPointId}". Use o mesmo ponto para registrar esta fase.`,
              });
              continue;
            }
          }

          await db.insert(deliveryLogs).values({
            tenantId: order.tenantId,
            orderId: order.id,
            deliveryPointId: input.deliveryPointId,
            status: input.status,
            timestamp: ts,
            userId: ctx.user.id,
            notes: input.notes ?? null,
          });

          results.push({ orderId: order.id, orderNumber: order.customerOrderNumber ?? undefined, success: true });
        } catch (e: any) {
          results.push({ orderId: order.id, success: false, error: e.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      return {
        successCount,
        failCount,
        results,
        pointName: point.name,
        statusLabel: STATUS_LABELS[input.status],
      };
    }),

  // =========================================================================
  // TIMELINE E RELATÓRIOS
  // =========================================================================

  /**
   * Retorna a timeline completa de checkpoints de um pedido,
   * com cálculo de lead-time entre cada etapa.
   */
  getOrderTimeline: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      orderId: z.number(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validar pedido
      const [order] = await db
        .select({
          id: pickingOrders.id,
          tenantId: pickingOrders.tenantId,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          status: pickingOrders.status,
        })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
      assertSameTenant(order.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "pedido");

      // Buscar logs com join em deliveryPoints e users
      const logs = await db
        .select({
          id: deliveryLogs.id,
          status: deliveryLogs.status,
          timestamp: deliveryLogs.timestamp,
          notes: deliveryLogs.notes,
          pointId: deliveryLogs.deliveryPointId,
          pointName: deliveryPoints.name,
          pointType: deliveryPoints.type,
          pointFloor: deliveryPoints.floor,
          userName: users.name,
        })
        .from(deliveryLogs)
        .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
        .leftJoin(users, eq(deliveryLogs.userId, users.id))
        .where(and(
          eq(deliveryLogs.orderId, input.orderId),
          eq(deliveryLogs.tenantId, order.tenantId),
        ))
        .orderBy(asc(deliveryLogs.timestamp));

      // Calcular lead-time entre checkpoints consecutivos
      const timelineWithLeadTime = logs.map((log, idx) => {
        const prev = logs[idx - 1];
        const leadTimeMs = prev
          ? new Date(log.timestamp).getTime() - new Date(prev.timestamp).getTime()
          : null;
        const leadTimeMinutes = leadTimeMs !== null ? Math.round(leadTimeMs / 60000) : null;

        return {
          ...log,
          statusLabel: STATUS_LABELS[log.status as DeliveryStatus] ?? log.status,
          leadTimeMinutes,
          leadTimeFormatted: leadTimeMinutes !== null
            ? leadTimeMinutes >= 60
              ? `${Math.floor(leadTimeMinutes / 60)}h ${leadTimeMinutes % 60}min`
              : `${leadTimeMinutes}min`
            : null,
        };
      });

      // Calcular tempo total (primeiro ao último checkpoint)
      const totalMs = logs.length >= 2
        ? new Date(logs[logs.length - 1].timestamp).getTime() - new Date(logs[0].timestamp).getTime()
        : null;
      const totalMinutes = totalMs !== null ? Math.round(totalMs / 60000) : null;

      return {
        order: {
          id: order.id,
          customerOrderNumber: order.customerOrderNumber,
          status: order.status,
        },
        timeline: timelineWithLeadTime,
        totalMinutes,
        totalFormatted: totalMinutes !== null
          ? totalMinutes >= 60
            ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}min`
            : `${totalMinutes}min`
          : null,
        isComplete: logs.some(l => l.status === "RECEIVE_COMPLETE"),
        lastStatus: logs.length > 0 ? logs[logs.length - 1].status : null,
        lastStatusLabel: logs.length > 0 ? STATUS_LABELS[logs[logs.length - 1].status as DeliveryStatus] : null,
      };
    }),

  /**
   * Relatório de Tempo Médio de Trânsito Interno por etapa.
   * Calcula o SLA interno por tenant e período.
   */
  getTransitReport: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
      deliveryPointId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const reportTenantId = (ctx.isGlobalAdmin && input.tenantId) ? input.tenantId : ctx.effectiveTenantId;
      // Buscar todos os logs do período
      const conditions: ReturnType<typeof eq>[] = [eq(pickingOrders.tenantId, reportTenantId)];
      if (input.startDate) conditions.push(sql`${deliveryLogs.timestamp} >= ${input.startDate}`);
      if (input.endDate) conditions.push(sql`${deliveryLogs.timestamp} <= ${input.endDate}`);
      if (input.deliveryPointId) conditions.push(eq(deliveryLogs.deliveryPointId, input.deliveryPointId));

      const allLogs = await db
        .select({
          orderId: deliveryLogs.orderId,
          status: deliveryLogs.status,
          timestamp: deliveryLogs.timestamp,
          pointName: deliveryPoints.name,
          pointType: deliveryPoints.type,
        })
        .from(deliveryLogs)
        .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
        .innerJoin(pickingOrders, eq(deliveryLogs.orderId, pickingOrders.id))
        .where(and(...conditions))
        .orderBy(asc(deliveryLogs.orderId), asc(deliveryLogs.timestamp));

      // Agrupar por pedido
      const byOrder = new Map<number, typeof allLogs>();
      for (const log of allLogs) {
        if (!byOrder.has(log.orderId)) byOrder.set(log.orderId, []);
        byOrder.get(log.orderId)!.push(log);
      }

      // Calcular lead-times por transição
      const transitions: Record<string, number[]> = {};
      for (const entry of Array.from(byOrder.entries())) {
        const logs = entry[1];
        for (let i = 1; i < logs.length; i++) {
          const key = `${logs[i - 1].status} → ${logs[i].status}`;
          const diffMin = Math.round(
            (new Date(logs[i].timestamp).getTime() - new Date(logs[i - 1].timestamp).getTime()) / 60000
          );
          if (!transitions[key]) transitions[key] = [];
          transitions[key].push(diffMin);
        }
      }

      // Calcular médias
      const avgByTransition = Object.entries(transitions).map(([transition, times]) => {
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        const [fromStatus, toStatus] = transition.split(" → ");
        return {
          transition,
          fromLabel: STATUS_LABELS[fromStatus as DeliveryStatus] ?? fromStatus,
          toLabel: STATUS_LABELS[toStatus as DeliveryStatus] ?? toStatus,
          avgMinutes: avg,
          avgFormatted: avg >= 60 ? `${Math.floor(avg / 60)}h ${avg % 60}min` : `${avg}min`,
          sampleCount: times.length,
          minMinutes: Math.min(...times),
          maxMinutes: Math.max(...times),
        };
      });

      // Total de pedidos processados e completos
      const totalOrders = byOrder.size;
      const completedOrders = Array.from(byOrder.values()).filter((logs: typeof allLogs) =>
        logs.some((l: typeof allLogs[0]) => l.status === "RECEIVE_COMPLETE")
      ).length;

      return {
        totalOrders,
        completedOrders,
        completionRate: totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100) : 0,
        avgByTransition,
        period: {
          start: input.startDate ?? null,
          end: input.endDate ?? null,
        },
      };
    }),

  /**
   * Lista pedidos com seu último status de rastreio intra-hospitalar.
   * Útil para a tela de monitorização em tempo real.
   */
  listOrdersWithStatus: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      deliveryPointId: z.number().optional(),
      status: z.enum(STATUS_ORDER).optional(),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Subquery: último status de cada pedido
      const latestLogs = await db
        .select({
          orderId: deliveryLogs.orderId,
          status: deliveryLogs.status,
          timestamp: deliveryLogs.timestamp,
          pointName: deliveryPoints.name,
          pointType: deliveryPoints.type,
        })
        .from(deliveryLogs)
        .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
        .where(ctx.isGlobalAdmin && !input.tenantId
          ? undefined
          : eq(deliveryLogs.tenantId, (ctx.isGlobalAdmin && input.tenantId) ? input.tenantId : ctx.effectiveTenantId))
        .orderBy(desc(deliveryLogs.timestamp));

      // Manter apenas o log mais recente por pedido
      const seenOrders = new Set<number>();
      const latestByOrder: typeof latestLogs = [];
      for (const log of latestLogs) {
        if (!seenOrders.has(log.orderId)) {
          seenOrders.add(log.orderId);
          latestByOrder.push(log);
        }
      }

      // Filtrar por status e ponto se solicitado
      const filtered = latestByOrder.filter(log => {
        if (input.status && log.status !== input.status) return false;
        return true;
      }).slice(0, input.limit);

      // Enriquecer com dados do pedido
      if (filtered.length === 0) return [];

      const orderIds = filtered.map(l => l.orderId);
      const orders = await db
        .select({
          id: pickingOrders.id,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          status: pickingOrders.status,
        })
        .from(pickingOrders)
        .where(inArray(pickingOrders.id, orderIds));

      const orderMap = new Map(orders.map(o => [o.id, o]));

      return filtered.map(log => ({
        orderId: log.orderId,
        customerOrderNumber: orderMap.get(log.orderId)?.customerOrderNumber ?? null,
        orderStatus: orderMap.get(log.orderId)?.status ?? null,
        lastDeliveryStatus: log.status,
        lastDeliveryStatusLabel: STATUS_LABELS[log.status as DeliveryStatus] ?? log.status,
        lastPointName: log.pointName,
        lastPointType: log.pointType,
        lastTimestamp: log.timestamp,
      }));
    }),

  /**
   * Resolve um código bipado (customerOrderNumber ou ID numérico) para o ID
   * interno do pedido. Usado pelo coletor intra-hospitalar para aceitar
   * tanto o número do pedido (ex: PED-001) quanto o ID numérico.
   */
  resolveOrderByCode: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      code: z.string().min(1),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const code = input.code.trim();

      // Tenta interpretar como ID numérico primeiro
      const numericId = parseInt(code, 10);
      const isNumeric = !isNaN(numericId) && String(numericId) === code;

      let order: { id: number; customerOrderNumber: string | null; tenantId: number } | undefined;

      if (isNumeric) {
        // Busca por ID
        const [found] = await db
          .select({ id: pickingOrders.id, customerOrderNumber: pickingOrders.customerOrderNumber, tenantId: pickingOrders.tenantId })
          .from(pickingOrders)
          .where(eq(pickingOrders.id, numericId))
          .limit(1);
        order = found;
      }

      if (!order) {
        // Busca por customerOrderNumber (case-insensitive)
        const [found] = await db
          .select({ id: pickingOrders.id, customerOrderNumber: pickingOrders.customerOrderNumber, tenantId: pickingOrders.tenantId })
          .from(pickingOrders)
          .where(eq(pickingOrders.customerOrderNumber, code))
          .limit(1);
        order = found;
      }

      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Pedido "${code}" não encontrado.` });
      }

      assertSameTenant(order.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "pedido");

      return {
        orderId: order.id,
        customerOrderNumber: order.customerOrderNumber ?? String(order.id),
      };
    }),

  /**
   * Dashboard de Rastreabilidade — lista todos os pedidos com seus checkpoints.
   * Retorna pedidos que possuem ao menos um deliveryLog, com a timeline completa
   * de cada um. Suporta filtros por status, ponto de entrega, data e número.
   */
  listOrdersWithCheckpoints: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      status: z.string().optional(), // "ALL" ou um DeliveryStatus
      deliveryPointId: z.number().optional(),
      search: z.string().optional(),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
      limit: z.number().min(1).max(500).default(100),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Montar condições de filtro
      const conditions: ReturnType<typeof eq>[] = [];
      const effectiveTenant = (ctx.isGlobalAdmin && input.tenantId) ? input.tenantId : ctx.effectiveTenantId;
      const filterTenantId = ctx.isGlobalAdmin && !input.tenantId ? null : effectiveTenant;
      const tenantCond = tenantFilter(deliveryLogs.tenantId, filterTenantId, ctx.isGlobalAdmin);
      if (tenantCond) conditions.push(tenantCond as ReturnType<typeof eq>);
      if (input.deliveryPointId) conditions.push(eq(deliveryLogs.deliveryPointId, input.deliveryPointId) as ReturnType<typeof eq>);

      // 1. Buscar todos os logs do tenant (com join em deliveryPoints e users)
      const allLogs = await db
        .select({
          id: deliveryLogs.id,
          orderId: deliveryLogs.orderId,
          status: deliveryLogs.status,
          timestamp: deliveryLogs.timestamp,
          notes: deliveryLogs.notes,
          pointId: deliveryLogs.deliveryPointId,
          pointName: deliveryPoints.name,
          pointType: deliveryPoints.type,
          pointFloor: deliveryPoints.floor,
          userName: users.name,
          userId: deliveryLogs.userId,
        })
        .from(deliveryLogs)
        .leftJoin(deliveryPoints, eq(deliveryLogs.deliveryPointId, deliveryPoints.id))
        .leftJoin(users, eq(deliveryLogs.userId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(deliveryLogs.orderId), asc(deliveryLogs.timestamp));

      if (allLogs.length === 0) return [];

      // 2. Agrupar logs por pedido
      const logsByOrder = new Map<number, typeof allLogs>();
      for (const log of allLogs) {
        if (!logsByOrder.has(log.orderId)) logsByOrder.set(log.orderId, []);
        logsByOrder.get(log.orderId)!.push(log);
      }

      // 3. Filtrar por status e limitar
      const orderIds = Array.from(logsByOrder.keys());
      const filteredOrderIds = orderIds.filter(orderId => {
        const logs = logsByOrder.get(orderId)!;
        const lastStatus = logs[logs.length - 1].status;
        if (input.status && input.status !== "ALL" && lastStatus !== input.status) return false;
        return true;
      }).slice(0, input.limit);

      if (filteredOrderIds.length === 0) return [];

      // 4. Buscar dados dos pedidos
      const orders = await db
        .select({
          id: pickingOrders.id,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          status: pickingOrders.status,
          totalItems: pickingOrders.totalItems,
          totalQuantity: pickingOrders.totalQuantity,
        })
        .from(pickingOrders)
        .where(inArray(pickingOrders.id, filteredOrderIds));

      // 4b. Buscar totalVolumes do Stage por pedido
      const stageVolumesRows = await db
        .select({ pickingOrderId: stageChecks.pickingOrderId, totalVolumes: stageChecks.totalVolumes })
        .from(stageChecks)
        .where(and(
          inArray(stageChecks.pickingOrderId, filteredOrderIds),
          sql`${stageChecks.totalVolumes} IS NOT NULL`
        ))
        .orderBy(desc(stageChecks.id));
      const stageVolumesMap = new Map<number, number>();
      for (const sv of stageVolumesRows) {
        if (!stageVolumesMap.has(sv.pickingOrderId) && sv.totalVolumes != null) {
          stageVolumesMap.set(sv.pickingOrderId, sv.totalVolumes);
        }
      }

      const orderMap = new Map(orders.map(o => [o.id, o]));

      // 5. Aplicar filtro de busca por número do pedido
      const searchLower = input.search?.toLowerCase();

      // 6. Montar resultado final com timeline enriquecida
      const result: Array<{
        orderId: number;
        customerOrderNumber: string;
        orderStatus: string | null;
        lastDeliveryStatus: string;
        lastDeliveryStatusLabel: string;
        lastPointName: string | null;
        lastPointType: string | null;
        lastTimestamp: Date;
        isComplete: boolean;
        checkpointCount: number;
        totalMinutes: number | null;
        totalFormatted: string | null;
        totalItems: number | null;
        totalQuantity: number | null;
        totalVolumes: number | null;
        timeline: Array<{
          id: number;
          status: string;
          statusLabel: string;
          timestamp: Date;
          pointId: number | null;
          pointName: string | null;
          pointType: string | null;
          pointFloor: string | null;
          userName: string | null;
          userId: number | null;
          notes: string | null;
          leadTimeMinutes: number | null;
          leadTimeFormatted: string | null;
        }>;
      }> = [];

      for (const orderId of filteredOrderIds) {
        const order = orderMap.get(orderId);
        if (!order) continue;

        if (searchLower) {
          const num = (order.customerOrderNumber ?? String(orderId)).toLowerCase();
          if (!num.includes(searchLower)) continue;
        }

        const logs = logsByOrder.get(orderId)!;
        const lastLog = logs[logs.length - 1];
        const firstLog = logs[0];

        // Timeline com lead-time entre checkpoints
        const timeline = logs.map((log, idx) => {
          const prev = logs[idx - 1];
          const leadTimeMs = prev
            ? new Date(log.timestamp).getTime() - new Date(prev.timestamp).getTime()
            : null;
          const leadTimeMinutes = leadTimeMs !== null ? Math.round(leadTimeMs / 60000) : null;
          return {
            id: log.id,
            status: log.status,
            statusLabel: STATUS_LABELS[log.status as DeliveryStatus] ?? log.status,
            timestamp: log.timestamp,
            pointId: log.pointId,
            pointName: log.pointName,
            pointType: log.pointType,
            pointFloor: log.pointFloor,
            userName: log.userName,
            userId: log.userId,
            notes: log.notes,
            leadTimeMinutes,
            leadTimeFormatted: leadTimeMinutes !== null
              ? leadTimeMinutes >= 60
                ? `${Math.floor(leadTimeMinutes / 60)}h ${leadTimeMinutes % 60}min`
                : `${leadTimeMinutes}min`
              : null,
          };
        });

        // Tempo total
        const totalMs = logs.length >= 2
          ? new Date(lastLog.timestamp).getTime() - new Date(firstLog.timestamp).getTime()
          : null;
        const totalMinutes = totalMs !== null ? Math.round(totalMs / 60000) : null;

        result.push({
          orderId: order.id,
          customerOrderNumber: order.customerOrderNumber ?? String(order.id),
          orderStatus: order.status,
          lastDeliveryStatus: lastLog.status,
          lastDeliveryStatusLabel: STATUS_LABELS[lastLog.status as DeliveryStatus] ?? lastLog.status,
          lastPointName: lastLog.pointName,
          lastPointType: lastLog.pointType,
          lastTimestamp: lastLog.timestamp,
          isComplete: logs.some(l => l.status === "RECEIVE_COMPLETE"),
          checkpointCount: logs.length,
          totalItems: order.totalItems ?? null,
          totalQuantity: order.totalQuantity ?? null,
          totalVolumes: stageVolumesMap.get(order.id) ?? null,
          totalMinutes,
          totalFormatted: totalMinutes !== null
            ? totalMinutes >= 60
              ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}min`
              : `${totalMinutes}min`
            : null,
          timeline,
        });
      }

      return result;
    }),

  /**
   * Retorna detalhes de um pedido (itens, SKUs, quantidades, volumes) para o modal de detalhes.
   */
  getOrderDetails: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      orderId: z.number(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [order] = await db
        .select({
          id: pickingOrders.id,
          tenantId: pickingOrders.tenantId,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          customerName: pickingOrders.customerName,
          status: pickingOrders.status,
          totalItems: pickingOrders.totalItems,
          totalQuantity: pickingOrders.totalQuantity,
        })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.orderId))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
      assertSameTenant(order.tenantId, ctx.effectiveTenantId, ctx.isGlobalAdmin, "pedido");

      const items = await db
        .select({
          id: pickingOrderItems.id,
          productName: products.description,
          productSku: products.sku,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
          pickedQuantity: pickingOrderItems.pickedQuantity,
          unitsPerBox: pickingOrderItems.unitsPerBox,
          batch: pickingOrderItems.batch,
          expiryDate: pickingOrderItems.expiryDate,
          status: pickingOrderItems.status,
        })
        .from(pickingOrderItems)
        .leftJoin(products, eq(pickingOrderItems.productId, products.id))
        .where(eq(pickingOrderItems.pickingOrderId, order.id));

      const [stageRow] = await db
        .select({ totalVolumes: stageChecks.totalVolumes })
        .from(stageChecks)
        .where(and(
          eq(stageChecks.pickingOrderId, order.id),
          sql`${stageChecks.totalVolumes} IS NOT NULL`
        ))
        .orderBy(desc(stageChecks.id))
        .limit(1);

      return { ...order, items, totalVolumes: stageRow?.totalVolumes ?? null };
    }),

  // =========================================================================
  // IMPORTAÇÃO EM LOTE DE PONTOS DE ENTREGA
  // =========================================================================

  importDeliveryPoints: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      rows: z.array(z.object({
        type: z.enum(["DOCK", "PHARMACY"]),
        name: z.string().min(1).max(255),
        externalCode: z.string().min(1).max(100),
        floor: z.string().optional(),
        description: z.string().optional(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const targetTenantId = (ctx.isGlobalAdmin && input.tenantId) ? input.tenantId : ctx.effectiveTenantId;

      let created = 0;
      let skipped = 0;
      const errors: { row: number; code: string; message: string }[] = [];

      for (let i = 0; i < input.rows.length; i++) {
        const row = input.rows[i];
        try {
          const [existing] = await db
            .select({ id: deliveryPoints.id })
            .from(deliveryPoints)
            .where(and(
              eq(deliveryPoints.tenantId, targetTenantId),
              eq(deliveryPoints.externalCode, row.externalCode),
            ))
            .limit(1);
          if (existing) {
            skipped++;
            errors.push({ row: i + 2, code: row.externalCode, message: `Código "${row.externalCode}" já existe — ignorado` });
            continue;
          }
          await db.insert(deliveryPoints).values({
            tenantId: targetTenantId,
            name: row.name,
            type: row.type,
            externalCode: row.externalCode,
            description: row.description ?? null,
            floor: row.floor ?? null,
            isActive: true,
          });
          created++;
        } catch (err: any) {
          errors.push({ row: i + 2, code: row.externalCode, message: err?.message ?? "Erro desconhecido" });
        }
      }

      return { created, skipped, errors };
    }),

  /**
   * Busca pedidos por chave NF-e (44 dígitos) ou número do pedido.
   * Retorna todos os pedidos vinculados à NF ou o pedido específico.
   */
  getOrdersByNfeKey: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
      code: z.string().min(1),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const code = input.code.trim().replace(/\s/g, "");
      const effectiveTenantId = ctx.isGlobalAdmin && input.tenantId ? input.tenantId : ctx.effectiveTenantId;

      // Detecta se é chave NF-e (44 dígitos numéricos)
      const isNfeKey = /^\d{44}$/.test(code);

      if (isNfeKey) {
        const orders = await db
          .select({
            id: pickingOrders.id,
            customerOrderNumber: pickingOrders.customerOrderNumber,
            tenantId: pickingOrders.tenantId,
            nfeKey: pickingOrders.nfeKey,
            nfeNumber: pickingOrders.nfeNumber,
          })
          .from(pickingOrders)
          .where(and(
            eq(pickingOrders.nfeKey, code),
            eq(pickingOrders.tenantId, effectiveTenantId),
          ));
        if (orders.length === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Nenhum pedido encontrado para a NF-e ${code.slice(0, 9)}...${code.slice(-6)}.` });
        }
        return {
          type: "nfe" as const,
          nfeKey: code,
          nfeNumber: orders[0].nfeNumber ?? null,
          orders: orders.map(o => ({
            orderId: o.id,
            customerOrderNumber: o.customerOrderNumber ?? String(o.id),
          })),
        };
      }

      // Busca por número do pedido (customerOrderNumber ou ID numérico)
      const numericId = parseInt(code, 10);
      const isNumeric = !isNaN(numericId) && String(numericId) === code;
      let order: { id: number; customerOrderNumber: string | null; tenantId: number; nfeKey: string | null; nfeNumber: string | null } | undefined;

      if (isNumeric) {
        const [found] = await db
          .select({ id: pickingOrders.id, customerOrderNumber: pickingOrders.customerOrderNumber, tenantId: pickingOrders.tenantId, nfeKey: pickingOrders.nfeKey, nfeNumber: pickingOrders.nfeNumber })
          .from(pickingOrders)
          .where(and(eq(pickingOrders.id, numericId), eq(pickingOrders.tenantId, effectiveTenantId)))
          .limit(1);
        order = found;
      }
      if (!order) {
        const [found] = await db
          .select({ id: pickingOrders.id, customerOrderNumber: pickingOrders.customerOrderNumber, tenantId: pickingOrders.tenantId, nfeKey: pickingOrders.nfeKey, nfeNumber: pickingOrders.nfeNumber })
          .from(pickingOrders)
          .where(and(eq(pickingOrders.customerOrderNumber, code), eq(pickingOrders.tenantId, effectiveTenantId)))
          .limit(1);
        order = found;
      }
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Pedido "${code}" não encontrado.` });
      }
      return {
        type: "order" as const,
        nfeKey: order.nfeKey ?? null,
        nfeNumber: order.nfeNumber ?? null,
        orders: [{ orderId: order.id, customerOrderNumber: order.customerOrderNumber ?? String(order.id) }],
      };
    }),
});
