/**
 * inventoryRouter.ts
 * Módulo de Inventário — Fase 1 (Cíclico e Geral)
 * Procedures: criar, listar, cancelar, fechar, gerar endereços, OMs de sobra, ondas
 */
import { z } from "zod";
import { eq, and, desc, asc, sql, inArray, isNull, isNotNull, ne, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "./_core/trpc";
import { getDb } from "./db";
import {
  inventories,
  inventoryLocations,
  inventoryCountAttempts,
  inventoryDivergences,
  inventoryAuditLog,
  warehouseLocations,
  inventory,
  inventoryMovements,
  labelAssociations,
  products,
  pickingOrders,
  pickingOrderItems,
  pickingWaves,
  users,
  tenants,
} from "../drizzle/schema";
import { getUniqueCode } from "./utils/uniqueCode";

// ─── Helpers de permissão ─────────────────────────────────────────────────────

function canManageInventory(role: string) {
  return ["admin", "manager", "supervisor"].includes(role);
}

function canCancelInventory(role: string) {
  return ["admin", "supervisor"].includes(role);
}

function canExecuteCount(role: string) {
  return ["admin", "manager", "supervisor", "operator", "user"].includes(role);
}

// ─── Gerador de número de inventário ─────────────────────────────────────────

async function generateInventoryNumber(db: any): Promise<string> {
  const [last] = await db
    .select({ inventoryNumber: inventories.inventoryNumber })
    .from(inventories)
    .orderBy(desc(inventories.id))
    .limit(1);
  if (!last) return "INV-000001";
  const num = parseInt(last.inventoryNumber.replace("INV-", ""), 10) + 1;
  return `INV-${String(num).padStart(6, "0")}`;
}

async function generateOrderNumber(db: any): Promise<string> {
  const [last] = await db
    .select({ orderNumber: pickingOrders.orderNumber })
    .from(pickingOrders)
    .where(eq(pickingOrders.orderType, "inventory_surplus"))
    .orderBy(desc(pickingOrders.id))
    .limit(1);
  if (!last) return "OM-000001";
  const match = last.orderNumber.match(/OM-(\d+)/);
  const num = match ? parseInt(match[1], 10) + 1 : 1;
  return `OM-${String(num).padStart(6, "0")}`;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const inventoryRouter = router({

  // ── Criar inventário ────────────────────────────────────────────────────────
  create: protectedProcedure
    .input(z.object({
      inventoryType: z.enum(["cyclic", "general"]),
      referenceDate: z.string().optional(), // YYYY-MM-DD, obrigatório para cíclico
      startDate: z.string(), // ISO datetime
      notes: z.string().optional(),
      tenantId: z.number().optional(), // Para filtrar por tenant (admin global pode omitir)
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canManageInventory(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para criar inventário" });
      }
      if (input.inventoryType === "cyclic" && !input.referenceDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Data de referência obrigatória para inventário cíclico" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      // Verificar se já existe inventário ativo
      const activeTenantId = input.tenantId ?? (ctx.user.role !== "admin" ? ctx.user.tenantId : null);
      const activeCheck = await db
        .select({ id: inventories.id })
        .from(inventories)
        .where(
          and(
            activeTenantId ? eq(inventories.tenantId, activeTenantId) : isNull(inventories.tenantId),
            or(eq(inventories.status, "pending"), eq(inventories.status, "in_progress"))
          )
        )
        .limit(1);
      if (activeCheck.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "Já existe um inventário ativo. Finalize ou cancele antes de criar um novo." });
      }

      // Determinar endereços elegíveis
      let eligibleLocations: { id: number; code: string }[] = [];
      if (input.inventoryType === "cyclic" && input.referenceDate) {
        // Endereços STORAGE que tiveram movimentação na data de referência
        const movDate = input.referenceDate;
        const nextDay = new Date(movDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split("T")[0];
        const moved = await db.execute(
          sql`SELECT DISTINCT wl.id, wl.code
              FROM warehouseLocations wl
              JOIN inventoryMovements im ON im.fromLocationId = wl.id OR im.toLocationId = wl.id
              WHERE wl.zoneCode IN ('STORAGE', 'ARM')
              AND wl.status IN ('available', 'occupied', 'blocked', 'counting', 'quarantine')
              AND DATE(im.createdAt) = ${movDate}
              ${activeTenantId ? sql`AND wl.tenantId = ${activeTenantId}` : sql``}
              ORDER BY wl.code ASC`
        );
        const movedRows = Array.isArray((moved as any)[0]) ? (moved as any)[0] : (moved as any);
        eligibleLocations = (movedRows as any[])
          .filter((r: any) => r.id && r.code)
          .map((r: any) => ({ id: Number(r.id), code: String(r.code) }));
      } else {
        // Geral: todos os endereços com status operável do tenant
        const allLocs = await db
          .select({ id: warehouseLocations.id, code: warehouseLocations.code })
          .from(warehouseLocations)
          .where(
            and(
              inArray(warehouseLocations.zoneCode, ["STORAGE", "ARM"]),
              inArray(warehouseLocations.status, ["available", "occupied", "counting", "quarantine"]),
              activeTenantId ? eq(warehouseLocations.tenantId, activeTenantId) : undefined
            )
          )
          .orderBy(asc(warehouseLocations.code));
        eligibleLocations = allLocs.map((l) => ({ id: l.id, code: l.code ?? "" })).filter((l) => l.code !== "");
      }

      if (eligibleLocations.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Nenhum endereço elegível encontrado para este inventário" });
      }

      return await db.transaction(async (tx: any) => {
        const inventoryNumber = await generateInventoryNumber(tx);
        // Criar inventário
        const [inserted] = await tx.insert(inventories).values({
          tenantId: activeTenantId ?? null,
          inventoryNumber,
          inventoryType: input.inventoryType,
          referenceDate: input.referenceDate ?? null,
          startDate: new Date(input.startDate),
          status: "pending",
          notes: input.notes ?? null,
          totalLocations: eligibleLocations.length,
          countedLocations: 0,
          divergentLocations: 0,
          createdBy: ctx.user.id,
        });
        const inventoryId = (inserted as any).insertId;

        // Criar inventoryLocations para cada endereço
        const locRows = eligibleLocations.map((loc) => ({
          inventoryId,
          locationId: loc.id,
          locationCode: loc.code,
          status: "pending" as const,
          countAttempts: 0,
          isBlocked: false,
        }));
        await tx.insert(inventoryLocations).values(locRows);

        // Log de auditoria
        await tx.insert(inventoryAuditLog).values({
          inventoryId,
          action: "created",
          performedBy: ctx.user.id,
          notes: `Inventário ${inventoryNumber} criado com ${eligibleLocations.length} endereços`,
        });

        return { inventoryId, inventoryNumber, totalLocations: eligibleLocations.length };
      });
    }),

  // ── Listar inventários ──────────────────────────────────────────────────────
  list: protectedProcedure
    .input(z.object({
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
      tenantId: z.number().optional(),
      page: z.number().default(1),
      pageSize: z.number().default(20),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const isGlobalAdmin = ctx.user.role === "admin" && ctx.user.tenantId === 1;
      const effectiveTenantId = isGlobalAdmin ? (input?.tenantId ?? null) : ctx.user.tenantId;
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (effectiveTenantId) conditions.push(eq(inventories.tenantId, effectiveTenantId));
      if (input?.status) conditions.push(eq(inventories.status, input.status));

      const rows = await db
        .select({
          id: inventories.id,
          inventoryNumber: inventories.inventoryNumber,
          inventoryType: inventories.inventoryType,
          referenceDate: inventories.referenceDate,
          startDate: inventories.startDate,
          endDate: inventories.endDate,
          status: inventories.status,
          totalLocations: inventories.totalLocations,
          countedLocations: inventories.countedLocations,
          divergentLocations: inventories.divergentLocations,
          accuracy: inventories.accuracy,
          notes: inventories.notes,
          createdAt: inventories.createdAt,
          createdByName: users.name,
        })
        .from(inventories)
        .leftJoin(users, eq(inventories.createdBy, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(inventories.createdAt))
        .limit(pageSize)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(inventories)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return { rows, total, page, pageSize };
    }),

  // ── Buscar inventário por ID ─────────────────────────────────────────────────
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const [inv] = await db
        .select()
        .from(inventories)
        .where(eq(inventories.id, input.id))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Inventário não encontrado" });

      const locations = await db
        .select()
        .from(inventoryLocations)
        .where(eq(inventoryLocations.inventoryId, input.id))
        .orderBy(asc(inventoryLocations.locationCode));

      const divergences = await db
        .select()
        .from(inventoryDivergences)
        .where(eq(inventoryDivergences.inventoryId, input.id))
        .orderBy(desc(inventoryDivergences.createdAt));

      return { ...inv, locations, divergences };
    }),

  // ── Cancelar inventário ─────────────────────────────────────────────────────
  cancel: protectedProcedure
    .input(z.object({
      id: z.number(),
      reason: z.string().min(5, "Justificativa obrigatória (mínimo 5 caracteres)"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canCancelInventory(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas supervisor ou admin podem cancelar inventário" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const [inv] = await db
        .select({ status: inventories.status })
        .from(inventories)
        .where(eq(inventories.id, input.id))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Inventário não encontrado" });
      if (inv.status === "completed" || inv.status === "cancelled") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Inventário já finalizado ou cancelado" });
      }

      await db.transaction(async (tx: any) => {
        // Desbloquear endereços
        await tx
          .update(inventoryLocations)
          .set({ isBlocked: false, status: "pending" })
          .where(eq(inventoryLocations.inventoryId, input.id));

        // Cancelar inventário
        await tx
          .update(inventories)
          .set({
            status: "cancelled",
            cancellationReason: input.reason,
            cancelledBy: ctx.user.id,
            cancelledAt: new Date(),
          })
          .where(eq(inventories.id, input.id));

        // Log
        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.id,
          action: "cancelled",
          performedBy: ctx.user.id,
          notes: `Cancelado por ${ctx.user.name}: ${input.reason}`,
        });
      });

      return { success: true };
    }),

  // ── Iniciar inventário (pending → in_progress) ──────────────────────────────
  start: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!canManageInventory(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const [inv] = await db
        .select({ status: inventories.status })
        .from(inventories)
        .where(eq(inventories.id, input.id))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Inventário não encontrado" });
      if (inv.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Inventário não está pendente" });
      }

      await db.transaction(async (tx: any) => {
        await tx
          .update(inventories)
          .set({ status: "in_progress" })
          .where(eq(inventories.id, input.id));

        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.id,
          action: "started",
          performedBy: ctx.user.id,
        });
      });

      return { success: true };
    }),

  // ── Fechar inventário (in_progress → completed) ─────────────────────────────
  complete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!canManageInventory(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const [inv] = await db
        .select()
        .from(inventories)
        .where(eq(inventories.id, input.id))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Inventário não encontrado" });
      if (inv.status !== "in_progress") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Inventário não está em andamento" });
      }

      // Calcular acuracidade
      const totalLocs = inv.totalLocations || 1;
      const divergentLocs = inv.divergentLocations || 0;
      const accuracy = (((totalLocs - divergentLocs) / totalLocs) * 100).toFixed(2);

      await db.transaction(async (tx: any) => {
        // Desbloquear endereços
        await tx
          .update(inventoryLocations)
          .set({ isBlocked: false })
          .where(eq(inventoryLocations.inventoryId, input.id));

        await tx
          .update(inventories)
          .set({ status: "completed", endDate: new Date(), accuracy })
          .where(eq(inventories.id, input.id));

        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.id,
          action: "completed",
          performedBy: ctx.user.id,
          notes: `Acuracidade: ${accuracy}%`,
        });
      });

      return { success: true, accuracy };
    }),

  // ── Listar endereços do inventário ──────────────────────────────────────────
  getLocations: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      status: z.enum(["pending", "counting", "counted", "divergent", "blocked"]).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const conditions = [eq(inventoryLocations.inventoryId, input.inventoryId)];
      if (input.status) conditions.push(eq(inventoryLocations.status, input.status));

      return db
        .select()
        .from(inventoryLocations)
        .where(and(...conditions))
        .orderBy(asc(inventoryLocations.locationCode));
    }),

  // ── Registrar contagem de endereço ──────────────────────────────────────────
  recordCount: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      counts: z.array(z.object({
        productId: z.number(),
        productSku: z.string().optional(),
        productDescription: z.string().optional(),
        batch: z.string().optional(),
        expiryDate: z.string().optional(),
        expectedQuantity: z.number(),
        countedQuantity: z.number(),
      })),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para executar contagem" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const [invLoc] = await db
        .select()
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, input.inventoryLocationId))
        .limit(1);
      if (!invLoc) throw new TRPCError({ code: "NOT_FOUND", message: "Endereço de inventário não encontrado" });

      const attemptNumber = (invLoc.countAttempts || 0) + 1;
      if (attemptNumber > 5) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Limite de 5 contagens atingido para este endereço" });
      }

      return await db.transaction(async (tx: any) => {
        // Registrar tentativas de contagem
        const hasDivergence = input.counts.some(c => c.countedQuantity !== c.expectedQuantity);

        for (const count of input.counts) {
          const variance = count.countedQuantity - count.expectedQuantity;
          await tx.insert(inventoryCountAttempts).values({
            inventoryLocationId: input.inventoryLocationId,
            inventoryId: input.inventoryId,
            locationId: input.locationId,
            attemptNumber,
            productId: count.productId,
            productSku: count.productSku ?? null,
            productDescription: count.productDescription ?? null,
            batch: count.batch ?? null,
            expiryDate: count.expiryDate ?? null,
            expectedQuantity: count.expectedQuantity,
            countedQuantity: count.countedQuantity,
            variance,
            countedBy: ctx.user.id,
            notes: input.notes ?? null,
          });
        }

        // Atualizar inventoryLocation
        const newStatus = hasDivergence ? "divergent" : "counted";
        await tx
          .update(inventoryLocations)
          .set({
            countAttempts: attemptNumber,
            status: newStatus,
            countedBy: ctx.user.id,
            countedAt: new Date(),
          })
          .where(eq(inventoryLocations.id, input.inventoryLocationId));

        // Atualizar contadores do inventário
        await tx
          .update(inventories)
          .set({
            countedLocations: sql`countedLocations + 1`,
            divergentLocations: hasDivergence
              ? sql`divergentLocations + 1`
              : inventories.divergentLocations,
          })
          .where(eq(inventories.id, input.inventoryId));

        // Log
        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          action: hasDivergence ? "divergence_detected" : "location_counted",
          locationId: input.locationId,
          performedBy: ctx.user.id,
        });

        return { attemptNumber, hasDivergence, newStatus };
      });
    }),

  // ── Registrar divergência (criar OM de sobra ou mover falta) ────────────────
  registerDivergence: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      locationCode: z.string(),
      productId: z.number(),
      productSku: z.string().optional(),
      productDescription: z.string().optional(),
      batch: z.string().optional(),
      expiryDate: z.string().optional(),
      tenantId: z.number().optional(),
      expectedQuantity: z.number(),
      countedQuantity: z.number(),
      divergenceType: z.enum(["surplus", "shortage"]),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const variance = input.countedQuantity - input.expectedQuantity;

      return await db.transaction(async (tx: any) => {
        // Registrar divergência
        const [divInserted] = await tx.insert(inventoryDivergences).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          locationId: input.locationId,
          locationCode: input.locationCode,
          productId: input.productId,
          productSku: input.productSku ?? null,
          productDescription: input.productDescription ?? null,
          batch: input.batch ?? null,
          expiryDate: input.expiryDate ?? null,
          tenantId: input.tenantId ?? null,
          expectedQuantity: input.expectedQuantity,
          countedQuantity: input.countedQuantity,
          variance,
          divergenceType: input.divergenceType,
          resolution: "pending",
        });
        const divergenceId = (divInserted as any).insertId;

        let movementOrderNumber: string | null = null;

        if (input.divergenceType === "surplus") {
          // Criar OM de sobra (pickingOrder tipo INVENTORY_SURPLUS)
          const orderNumber = await generateOrderNumber(tx);
          const [omInserted] = await tx.insert(pickingOrders).values({
            tenantId: input.tenantId ?? 1,
            orderNumber,
            orderType: "inventory_surplus",
            inventoryId: input.inventoryId,
            status: "pending",
            totalItems: 1,
            totalQuantity: Math.abs(variance),
            notes: `Sobra de inventário ${input.inventoryId} — Endereço ${input.locationCode}`,
            createdBy: ctx.user.id,
          });
          const omId = (omInserted as any).insertId;

          // Item da OM
          await tx.insert(pickingOrderItems).values({
            pickingOrderId: omId,
            productId: input.productId,
            requestedQuantity: Math.abs(variance),
            requestedUM: "unit",
            batch: input.batch ?? null,
            expiryDate: input.expiryDate ?? null,
            fromLocationId: input.locationId,
            status: "pending",
          });

          // Vincular OM à divergência
          await tx
            .update(inventoryDivergences)
            .set({ movementOrderId: omId, resolution: "movement_order_created" })
            .where(eq(inventoryDivergences.id, divergenceId));

          movementOrderNumber = orderNumber;
        }

        // Log
        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          action: "divergence_resolved",
          locationId: input.locationId,
          locationCode: input.locationCode,
          productId: input.productId,
          batch: input.batch ?? null,
          expectedQuantity: input.expectedQuantity,
          countedQuantity: input.countedQuantity,
          performedBy: ctx.user.id,
          notes: input.divergenceType === "surplus"
            ? `Sobra registrada. OM criada: ${movementOrderNumber}`
            : `Falta registrada. Quantidade: ${Math.abs(variance)}`,
        });

        return { success: true, movementOrderNumber, divergenceId };
      });
    }),

  // ── Listar OMs de inventário ─────────────────────────────────────────────────
  listMovementOrders: protectedProcedure
    .input(z.object({
      status: z.string().optional(),
      tenantId: z.number().optional(),
      page: z.number().default(1),
      pageSize: z.number().default(20),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const isGlobalAdmin = ctx.user.role === "admin" && ctx.user.tenantId === 1;
      const effectiveTenantId = isGlobalAdmin ? (input?.tenantId ?? null) : ctx.user.tenantId;
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 20;
      const offset = (page - 1) * pageSize;

      const conditions = [eq(pickingOrders.orderType, "inventory_surplus")];
      if (effectiveTenantId) conditions.push(eq(pickingOrders.tenantId, effectiveTenantId));
      if (input?.status) conditions.push(eq(pickingOrders.status, input.status as any));

      const rows = await db
        .select({
          id: pickingOrders.id,
          orderNumber: pickingOrders.orderNumber,
          status: pickingOrders.status,
          totalItems: pickingOrders.totalItems,
          totalQuantity: pickingOrders.totalQuantity,
          notes: pickingOrders.notes,
          inventoryId: pickingOrders.inventoryId,
          waveId: pickingOrders.waveId,
          createdAt: pickingOrders.createdAt,
          tenantId: pickingOrders.tenantId,
        })
        .from(pickingOrders)
        .where(and(...conditions))
        .orderBy(desc(pickingOrders.createdAt))
        .limit(pageSize)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(pickingOrders)
        .where(and(...conditions));

      return { rows, total, page, pageSize };
    }),

  // ── Criar onda de movimentação (agrupamento de OMs) ──────────────────────────
  createMovementWave: protectedProcedure
    .input(z.object({
      orderIds: z.array(z.number()).min(1),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      // Validar que todas as OMs são INVENTORY_SURPLUS e estão pendentes
      const orders = await db
        .select({ id: pickingOrders.id, status: pickingOrders.status, orderType: pickingOrders.orderType, tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(inArray(pickingOrders.id, input.orderIds));

      for (const o of orders) {
        if (o.orderType !== "inventory_surplus") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Ordem ${o.id} não é uma OM de inventário` });
        }
        if (o.status !== "pending") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Ordem ${o.id} não está pendente` });
        }
      }

      return await db.transaction(async (tx: any) => {
        // Gerar número de onda
        const [lastWave] = await tx
          .select({ waveNumber: pickingWaves.waveNumber })
          .from(pickingWaves)
          .orderBy(desc(pickingWaves.id))
          .limit(1);
        const waveNum = lastWave
          ? parseInt(lastWave.waveNumber.replace("WM-", "").replace("W-", ""), 10) + 1
          : 1;
        const waveNumber = `WM-${String(waveNum).padStart(6, "0")}`;

        const tenantId = orders[0]?.tenantId ?? 1;
        const [waveInserted] = await tx.insert(pickingWaves).values({
          tenantId,
          waveNumber,
          status: "pending",
          totalOrders: orders.length,
          totalItems: orders.reduce((acc: number) => acc + 1, 0),
          totalQuantity: 0,
          pickingRule: "FIFO",
          notes: input.notes ?? `Onda de movimentação de inventário`,
          createdBy: ctx.user.id,
        });
        const waveId = (waveInserted as any).insertId;

        // Vincular OMs à onda
        await tx
          .update(pickingOrders)
          .set({ waveId, status: "in_wave" })
          .where(inArray(pickingOrders.id, input.orderIds));

        return { waveId, waveNumber };
      });
    }),

  // ── Listar ondas de movimentação de inventário ──────────────────────────────────────────
  listMovementWaves: protectedProcedure
    .input(z.object({ page: z.number().default(1), pageSize: z.number().default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const isGlobalAdmin = ctx.user.role === "admin" && ctx.user.tenantId === 1;
      const effectiveTenantId = isGlobalAdmin ? null : ctx.user.tenantId;
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 50;
      const offset = (page - 1) * pageSize;

      const conditions = [
        sql`${pickingWaves.waveNumber} LIKE 'WM-%'`,
        ...(effectiveTenantId ? [eq(pickingWaves.tenantId, effectiveTenantId)] : []),
      ];

      const waves = await db
        .select({
          id: pickingWaves.id,
          waveNumber: pickingWaves.waveNumber,
          status: pickingWaves.status,
          totalOrders: pickingWaves.totalOrders,
          totalItems: pickingWaves.totalItems,
          totalQuantity: pickingWaves.totalQuantity,
          createdAt: pickingWaves.createdAt,
        })
        .from(pickingWaves)
        .where(and(...conditions))
        .orderBy(desc(pickingWaves.id))
        .limit(pageSize)
        .offset(offset);

      return { waves };
    }),

  // ── Dashboard / KPIs ─────────────────────────────────────────────────────────
  dashboard: protectedProcedure
    .input(z.object({ tenantId: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const isGlobalAdmin = ctx.user.role === "admin" && ctx.user.tenantId === 1;
      const effectiveTenantId = isGlobalAdmin ? (input?.tenantId ?? null) : ctx.user.tenantId;

      const conditions = effectiveTenantId ? [eq(inventories.tenantId, effectiveTenantId)] : [];

      const [stats] = await db
        .select({
          total: sql<number>`count(*)`,
          pending: sql<number>`sum(case when status='pending' then 1 else 0 end)`,
          inProgress: sql<number>`sum(case when status='in_progress' then 1 else 0 end)`,
          completed: sql<number>`sum(case when status='completed' then 1 else 0 end)`,
          cancelled: sql<number>`sum(case when status='cancelled' then 1 else 0 end)`,
        })
        .from(inventories)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      // Últimos 5 inventários concluídos com acuracidade
      const recentCompleted = await db
        .select({
          inventoryNumber: inventories.inventoryNumber,
          inventoryType: inventories.inventoryType,
          accuracy: inventories.accuracy,
          endDate: inventories.endDate,
          totalLocations: inventories.totalLocations,
          divergentLocations: inventories.divergentLocations,
        })
        .from(inventories)
        .where(
          and(
            ...(conditions.length > 0 ? conditions : []),
            eq(inventories.status, "completed")
          )
        )
        .orderBy(desc(inventories.endDate))
        .limit(5);

      // OMs pendentes
      const [omStats] = await db
        .select({ total: sql<number>`count(*)` })
        .from(pickingOrders)
        .where(
          and(
            eq(pickingOrders.orderType, "inventory_surplus"),
            eq(pickingOrders.status, "pending"),
            ...(effectiveTenantId ? [eq(pickingOrders.tenantId, effectiveTenantId)] : [])
          )
        );

      return {
        inventoryStats: stats,
        recentCompleted,
        pendingMovementOrders: omStats?.total ?? 0,
      };
    }),

  // ── Verificar bloqueio de endereço ───────────────────────────────────────────
  checkLocationBlocked: protectedProcedure
    .input(z.object({ locationId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { blocked: false };

      const [blocked] = await db
        .select({ id: inventoryLocations.id, inventoryId: inventoryLocations.inventoryId })
        .from(inventoryLocations)
        .where(
          and(
            eq(inventoryLocations.locationId, input.locationId),
            eq(inventoryLocations.isBlocked, true)
          )
        )
        .limit(1);

      return { blocked: !!blocked, inventoryId: blocked?.inventoryId ?? null };
    }),

  // ── Coletor: procedures específicas para o operador de coletor ───────────────

  /** Lista inventários em andamento (status=in_progress) disponíveis para o operador contar */
  listActiveForCollector: protectedProcedure
    .input(z.object({ tenantId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const effectiveTenantId = ctx.user.role === "admin" ? (input.tenantId ?? null) : ctx.user.tenantId;
      const conditions: any[] = [inArray(inventories.status, ["pending", "in_progress"])];
      if (effectiveTenantId !== null && effectiveTenantId !== undefined) {
        conditions.push(eq(inventories.tenantId, effectiveTenantId));
      }
      return db
        .select({
          id: inventories.id,
          inventoryNumber: inventories.inventoryNumber,
          type: inventories.inventoryType,
          totalLocations: inventories.totalLocations,
          countedLocations: inventories.countedLocations,
          divergentLocations: inventories.divergentLocations,
          startedAt: inventories.startDate,
        })
        .from(inventories)
        .where(and(...conditions))
        .orderBy(desc(inventories.startDate));
    }),

  /** Busca um endereço de inventário pelo código escaneado (locationCode) */
  getLocationByCode: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      locationCode: z.string().trim().min(1),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const [invLoc] = await db
        .select()
        .from(inventoryLocations)
        .where(and(
          eq(inventoryLocations.inventoryId, input.inventoryId),
          eq(inventoryLocations.locationCode, input.locationCode.toUpperCase()),
        ))
        .limit(1);
      if (!invLoc) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Endereço '${input.locationCode}' não faz parte deste inventário` });
      }
      if (invLoc.status === "blocked") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Endereço bloqueado para recontagem" });
      }
      return invLoc;
    }),

  /** Retorna o saldo esperado (inventário atual) de um endereço para o operador confirmar */
  getLocationStock: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      locationId: z.number(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const stockRows = await db
        .select({
          id: inventory.id,
          productId: inventory.productId,
          productSku: products.sku,
          productDescription: products.description,
          batch: inventory.batch,
          expiryDate: inventory.expiryDate,
          quantity: inventory.quantity,
          uniqueCode: inventory.uniqueCode,
          labelCode: inventory.labelCode,
        })
        .from(inventory)
        .leftJoin(products, eq(inventory.productId, products.id))
        .where(and(
          eq(inventory.locationId, input.locationId),
          eq(inventory.status, "available"),
        ))
        .orderBy(asc(inventory.productId), asc(inventory.batch));
      const [invLoc] = await db
        .select({ id: inventoryLocations.id, countAttempts: inventoryLocations.countAttempts, status: inventoryLocations.status })
        .from(inventoryLocations)
        .where(and(
          eq(inventoryLocations.inventoryId, input.inventoryId),
          eq(inventoryLocations.locationId, input.locationId),
        ))
        .limit(1);
      return { stockRows, invLoc: invLoc ?? null };
    }),

  /** Solicita recontagem de um endereço já contado (supervisor/admin) */
  requestRecount: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      reason: z.string().min(1, "Justificativa obrigatória"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "supervisor") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas supervisores e administradores podem solicitar recontagem" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      const [invLoc] = await db
        .select()
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, input.inventoryLocationId))
        .limit(1);
      if (!invLoc) throw new TRPCError({ code: "NOT_FOUND", message: "Endereço não encontrado" });
      if (invLoc.status === "pending" || invLoc.status === "counting") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Endereço ainda não foi contado" });
      }
      await db.transaction(async (tx: any) => {
        await tx
          .update(inventoryLocations)
          .set({ status: "pending" as const, countedBy: null, countedAt: null })
          .where(eq(inventoryLocations.id, input.inventoryLocationId));
        if (invLoc.status === "counted" || invLoc.status === "divergent") {
          await tx
            .update(inventories)
            .set({
              countedLocations: sql`GREATEST(0, countedLocations - 1)`,
              divergentLocations: invLoc.status === "divergent"
                ? sql`GREATEST(0, divergentLocations - 1)`
                : inventories.divergentLocations,
            })
            .where(eq(inventories.id, input.inventoryId));
        }
        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          action: "recount_requested" as const,
          locationId: invLoc.locationId,
          locationCode: invLoc.locationCode,
          performedBy: ctx.user.id,
          notes: input.reason,
        });
      });
      return { success: true };
    }),

  // ── Coletor: próximo endereço da fila ──────────────────────────────────────
  getNextLocation: protectedProcedure
    .input(z.object({ inventoryId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });
      // Inventário deve estar pending ou in_progress
      const [inv] = await db
        .select({ status: inventories.status, totalLocations: inventories.totalLocations, countedLocations: inventories.countedLocations })
        .from(inventories)
        .where(eq(inventories.id, input.inventoryId))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Inventário não encontrado" });
      if (inv.status === "cancelled" || inv.status === "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Inventário encerrado" });
      }
      // Próximo endereço pending (ordenado por código)
      const [next] = await db
        .select()
        .from(inventoryLocations)
        .where(and(
          eq(inventoryLocations.inventoryId, input.inventoryId),
          eq(inventoryLocations.status, "pending"),
        ))
        .orderBy(asc(inventoryLocations.locationCode))
        .limit(1);
      return {
        nextLocation: next ?? null,
        totalLocations: inv.totalLocations,
        countedLocations: inv.countedLocations,
      };
    }),

  // ── Coletor: bipa volume (incrementa contador em memória via estado local) ───
  // Valida o labelCode bipado, busca unitsPerBox em labelAssociations e retorna
  // a quantidade correta para incrementar o contador (1 etiqueta = N unidades)
  scanVolume: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      labelCode: z.string().trim().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      // 1. Buscar etiqueta no saldo do endereço pelo labelCode
      const [stockRow] = await db
        .select({
          id: inventory.id,
          productId: inventory.productId,
          productSku: products.sku,
          productDescription: products.description,
          batch: inventory.batch,
          expiryDate: inventory.expiryDate,
          quantity: inventory.quantity,
          labelCode: inventory.labelCode,
          uniqueCode: inventory.uniqueCode,
        })
        .from(inventory)
        .leftJoin(products, eq(inventory.productId, products.id))
        .where(and(
          eq(inventory.locationId, input.locationId),
          eq(inventory.labelCode, input.labelCode),
          eq(inventory.status, "available"),
        ))
        .limit(1);

      if (!stockRow) {
        // Tenta buscar em qualquer endereço (produto existe mas não neste endereço)
        const [anyRow] = await db
          .select({ id: inventory.id, productSku: products.sku, productDescription: products.description })
          .from(inventory)
          .leftJoin(products, eq(inventory.productId, products.id))
          .where(eq(inventory.labelCode, input.labelCode))
          .limit(1);
        if (anyRow) {
          return { found: false, wrongLocation: true, product: anyRow, unitsPerBox: 1 };
        }
        return { found: false, wrongLocation: false, product: null, unitsPerBox: 1 };
      }

      // 2. Buscar unitsPerBox na tabela labelAssociations
      const [labelAssoc] = await db
        .select({ unitsPerBox: labelAssociations.unitsPerBox })
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      // Se não encontrar associação, assume 1 unidade por etiqueta
      const unitsPerBox = labelAssoc?.unitsPerBox ?? 1;

      return {
        found: true,
        wrongLocation: false,
        unitsPerBox,
        product: {
          productId: stockRow.productId,
          productSku: stockRow.productSku,
          productDescription: stockRow.productDescription,
          batch: stockRow.batch,
          expiryDate: stockRow.expiryDate,
          expectedQuantity: stockRow.quantity,
          labelCode: stockRow.labelCode,
          uniqueCode: stockRow.uniqueCode,
        },
      };
    }),

  // ── Coletor: finalizar contagem de endereço ──────────────────────────────────
  finishLocationCount: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      locationCode: z.string(),
      attemptNumber: z.number().min(1),
      counts: z.array(z.object({
        productId: z.number(),
        productSku: z.string().optional(),
        productDescription: z.string().optional(),
        batch: z.string().optional(),
        expiryDate: z.string().optional(),
        expectedQuantity: z.number(),
        countedQuantity: z.number(),
      })),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const hasDivergence = input.counts.some(c => c.countedQuantity !== c.expectedQuantity);
      const newStatus = hasDivergence ? "divergent" : "counted";

      return await db.transaction(async (tx: any) => {
        // Registrar tentativas
        for (const count of input.counts) {
          const variance = count.countedQuantity - count.expectedQuantity;
          await tx.insert(inventoryCountAttempts).values({
            inventoryLocationId: input.inventoryLocationId,
            inventoryId: input.inventoryId,
            locationId: input.locationId,
            attemptNumber: input.attemptNumber,
            productId: count.productId,
            productSku: count.productSku ?? null,
            productDescription: count.productDescription ?? null,
            batch: count.batch ?? null,
            expiryDate: count.expiryDate ?? null,
            expectedQuantity: count.expectedQuantity,
            countedQuantity: count.countedQuantity,
            variance,
            countedBy: ctx.user.id,
            notes: input.notes ?? null,
          });
        }

        // Atualizar inventoryLocation
        await tx
          .update(inventoryLocations)
          .set({ countAttempts: input.attemptNumber, status: newStatus, countedBy: ctx.user.id, countedAt: new Date() })
          .where(eq(inventoryLocations.id, input.inventoryLocationId));

        // Atualizar contadores do inventário (apenas na 1ª tentativa para não duplicar)
        if (input.attemptNumber === 1) {
          await tx
            .update(inventories)
            .set({
              status: "in_progress",
              countedLocations: sql`countedLocations + 1`,
              divergentLocations: hasDivergence ? sql`divergentLocations + 1` : inventories.divergentLocations,
            })
            .where(eq(inventories.id, input.inventoryId));
        } else {
          // Recontagem: atualizar divergentLocations se status mudou
          await tx
            .update(inventories)
            .set({
              divergentLocations: hasDivergence
                ? sql`divergentLocations`  // já estava divergente
                : sql`GREATEST(0, divergentLocations - 1)`,  // resolveu
            })
            .where(eq(inventories.id, input.inventoryId));
        }

        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          action: hasDivergence ? "divergence_detected" : "location_counted",
          locationId: input.locationId,
          locationCode: input.locationCode,
          performedBy: ctx.user.id,
          notes: `Tentativa ${input.attemptNumber}. ${hasDivergence ? "Divergência detectada" : "Sem divergência"}`,
        });

        return { hasDivergence, newStatus, attemptNumber: input.attemptNumber, counts: input.counts };
      });
    }),

  // ── Coletor: resolver divergência (sobra → OM / falta → mover para FAL) ──────
  resolveDivergence: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      locationCode: z.string(),
      action: z.enum(["surplus", "shortage"]),
      items: z.array(z.object({
        productId: z.number(),
        productSku: z.string().optional(),
        productDescription: z.string().optional(),
        batch: z.string().optional(),
        expiryDate: z.string().optional(),
        expectedQuantity: z.number(),
        countedQuantity: z.number(),
        tenantId: z.number().optional(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const results: { orderNumber?: string; falLocation?: string; productSku?: string }[] = [];

      return await db.transaction(async (tx: any) => {
        for (const item of input.items) {
          const variance = item.countedQuantity - item.expectedQuantity;
          if (variance === 0) continue;

          // Registrar divergência
          const [divInserted] = await tx.insert(inventoryDivergences).values({
            inventoryId: input.inventoryId,
            inventoryLocationId: input.inventoryLocationId,
            locationId: input.locationId,
            locationCode: input.locationCode,
            productId: item.productId,
            productSku: item.productSku ?? null,
            productDescription: item.productDescription ?? null,
            batch: item.batch ?? null,
            expiryDate: item.expiryDate ?? null,
            tenantId: item.tenantId ?? null,
            expectedQuantity: item.expectedQuantity,
            countedQuantity: item.countedQuantity,
            variance,
            divergenceType: input.action,
            resolution: "pending",
          });
          const divergenceId = (divInserted as any).insertId;

          if (input.action === "surplus") {
            // Criar OM de sobra
            const orderNumber = await generateOrderNumber(tx);
            const [omInserted] = await tx.insert(pickingOrders).values({
              tenantId: item.tenantId ?? 1,
              orderNumber,
              orderType: "inventory_surplus",
              inventoryId: input.inventoryId,
              status: "pending",
              totalItems: 1,
              totalQuantity: Math.abs(variance),
              notes: `Sobra inventário — ${input.locationCode} — ${item.productSku ?? item.productId}`,
              createdBy: ctx.user.id,
            });
            const omId = (omInserted as any).insertId;
            await tx.insert(pickingOrderItems).values({
              pickingOrderId: omId,
              productId: item.productId,
              requestedQuantity: Math.abs(variance),
              requestedUM: "unit",
              batch: item.batch ?? null,
              expiryDate: item.expiryDate ?? null,
              fromLocationId: input.locationId,
              status: "pending",
            });
            await tx.update(inventoryDivergences)
              .set({ movementOrderId: omId, resolution: "movement_order_created" })
              .where(eq(inventoryDivergences.id, divergenceId));
            results.push({ orderNumber, productSku: item.productSku ?? String(item.productId) });
          } else {
            // Falta: mover estoque para FAL
            const [falLoc] = await tx
              .select({ id: warehouseLocations.id, code: warehouseLocations.code })
              .from(warehouseLocations)
              .where(and(
                eq(warehouseLocations.zoneCode, "FAL"),
                eq(warehouseLocations.status, "available"),
                item.tenantId ? eq(warehouseLocations.tenantId, item.tenantId) : isNull(warehouseLocations.tenantId),
              ))
              .limit(1);
            if (!falLoc) throw new TRPCError({ code: "NOT_FOUND", message: "Nenhum endereço FAL disponível" });

            const absVariance = Math.abs(variance);
            // Reduzir estoque no endereço de origem
            await tx.execute(
              sql`UPDATE inventory SET quantity = GREATEST(0, quantity - ${absVariance})
                  WHERE locationId = ${input.locationId}
                  AND productId = ${item.productId}
                  AND (batch = ${item.batch ?? null} OR (batch IS NULL AND ${item.batch ?? null} IS NULL))
                  AND status = 'available'
                  LIMIT 1`
            );
            // Adicionar/atualizar em FAL com status quarantine
            const [existingFal] = await tx
              .select({ id: inventory.id, quantity: inventory.quantity })
              .from(inventory)
              .where(and(
                eq(inventory.locationId, falLoc.id),
                eq(inventory.productId, item.productId),
                item.batch ? eq(inventory.batch, item.batch) : isNull(inventory.batch),
                eq(inventory.status, "quarantine"),
              ))
              .limit(1);
            if (existingFal) {
              await tx.execute(
                sql`UPDATE inventory SET quantity = quantity + ${absVariance} WHERE id = ${existingFal.id}`
              );
            } else {
              await tx.insert(inventory).values({
                tenantId: item.tenantId ?? null,
                productId: item.productId,
                locationId: falLoc.id,
                batch: item.batch ?? null,
                expiryDate: item.expiryDate ?? null,
                locationZone: "FAL",
                quantity: absVariance,
                reservedQuantity: 0,
                status: "quarantine",
              });
            }
            // Registrar movimento
            await tx.insert(inventoryMovements).values({
              tenantId: item.tenantId ?? null,
              productId: item.productId,
              batch: item.batch ?? null,
              expiryDate: item.expiryDate ?? null,
              fromLocationId: input.locationId,
              toLocationId: falLoc.id,
              quantity: absVariance,
              movementType: "adjustment",
              referenceType: "inventory",
              referenceId: input.inventoryId,
              performedBy: ctx.user.id,
              notes: `Falta de inventário — ${input.locationCode} → ${falLoc.code}`,
            });
            await tx.update(inventoryDivergences)
              .set({ resolution: "adjusted", resolvedBy: ctx.user.id, resolvedAt: new Date() })
              .where(eq(inventoryDivergences.id, divergenceId));
            results.push({ falLocation: falLoc.code, productSku: item.productSku ?? String(item.productId) });
          }

          await tx.insert(inventoryAuditLog).values({
            inventoryId: input.inventoryId,
            inventoryLocationId: input.inventoryLocationId,
            action: "divergence_resolved",
            locationId: input.locationId,
            locationCode: input.locationCode,
            productId: item.productId,
            batch: item.batch ?? null,
            expectedQuantity: item.expectedQuantity,
            countedQuantity: item.countedQuantity,
            performedBy: ctx.user.id,
            notes: input.action === "surplus"
              ? `Sobra registrada. OM criada`
              : `Falta registrada. Movido para FAL`,
          });
        }

        // Marcar endereço como counted após resolução
        await tx
          .update(inventoryLocations)
          .set({ status: "counted" })
          .where(eq(inventoryLocations.id, input.inventoryLocationId));

        return { success: true, results };
      });
    }),

  // ── Coletor: registrar endereço como vazio ─────────────────────────────────
  markLocationEmpty: protectedProcedure
    .input(z.object({
      inventoryId: z.number(),
      inventoryLocationId: z.number(),
      locationId: z.number(),
      locationCode: z.string(),
      attemptNumber: z.number().min(1).default(1),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!canExecuteCount(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      // Verificar se há saldo no endereço
      const stockRows = await db
        .select({ id: inventory.id, quantity: inventory.quantity, productId: inventory.productId,
                  productSku: products.sku, batch: inventory.batch })
        .from(inventory)
        .leftJoin(products, eq(inventory.productId, products.id))
        .where(and(eq(inventory.locationId, input.locationId), eq(inventory.status, "available")))
        .limit(10);

      return await db.transaction(async (tx: any) => {
        const hasSaldoExpected = stockRows.length > 0;

        if (hasSaldoExpected) {
          // Há saldo esperado mas operador declarou vazio → divergência (falta total)
          for (const row of stockRows) {
            await tx.insert(inventoryCountAttempts).values({
              inventoryLocationId: input.inventoryLocationId,
              inventoryId: input.inventoryId,
              locationId: input.locationId,
              attemptNumber: input.attemptNumber,
              productId: row.productId,
              productSku: row.productSku ?? null,
              batch: row.batch ?? null,
              expectedQuantity: row.quantity,
              countedQuantity: 0,
              variance: -row.quantity,
              countedBy: ctx.user.id,
              notes: "Endereço declarado vazio pelo operador",
            });
          }
          // Marcar como divergente
          await tx.update(inventoryLocations)
            .set({ countAttempts: input.attemptNumber, status: "divergent", countedBy: ctx.user.id, countedAt: new Date() })
            .where(eq(inventoryLocations.id, input.inventoryLocationId));

          if (input.attemptNumber === 1) {
            await tx.update(inventories)
              .set({ status: "in_progress", countedLocations: sql`countedLocations + 1`, divergentLocations: sql`divergentLocations + 1` })
              .where(eq(inventories.id, input.inventoryId));
          }
        } else {
          // Endereço realmente vazio (sem saldo esperado) → contagem OK
          await tx.insert(inventoryCountAttempts).values({
            inventoryLocationId: input.inventoryLocationId,
            inventoryId: input.inventoryId,
            locationId: input.locationId,
            attemptNumber: input.attemptNumber,
            productId: 0,
            expectedQuantity: 0,
            countedQuantity: 0,
            variance: 0,
            countedBy: ctx.user.id,
            notes: "Endereço vazio confirmado",
          });
          await tx.update(inventoryLocations)
            .set({ countAttempts: input.attemptNumber, status: "counted", countedBy: ctx.user.id, countedAt: new Date() })
            .where(eq(inventoryLocations.id, input.inventoryLocationId));

          if (input.attemptNumber === 1) {
            await tx.update(inventories)
              .set({ status: "in_progress", countedLocations: sql`countedLocations + 1` })
              .where(eq(inventories.id, input.inventoryId));
          }
        }

        await tx.insert(inventoryAuditLog).values({
          inventoryId: input.inventoryId,
          inventoryLocationId: input.inventoryLocationId,
          action: hasSaldoExpected ? "divergence_detected" : "location_counted",
          locationId: input.locationId,
          locationCode: input.locationCode,
          performedBy: ctx.user.id,
          notes: hasSaldoExpected
            ? `Endereço declarado vazio mas havia saldo esperado (${stockRows.length} produto(s))`
            : "Endereço vazio confirmado",
        });

        return {
          hasDivergence: hasSaldoExpected,
          expectedItems: stockRows.map((r) => ({
            productId: r.productId,
            productSku: r.productSku ?? null,
            batch: r.batch ?? null,
            expectedQuantity: r.quantity,
            countedQuantity: 0,
          })),
        };
      });
    }),

  // ── Log de auditoria ─────────────────────────────────────────────────────────
  getAuditLog: protectedProcedure
    .input(z.object({ inventoryId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      return db
        .select({
          id: inventoryAuditLog.id,
          action: inventoryAuditLog.action,
          locationCode: inventoryAuditLog.locationCode,
          batch: inventoryAuditLog.batch,
          expectedQuantity: inventoryAuditLog.expectedQuantity,
          countedQuantity: inventoryAuditLog.countedQuantity,
          notes: inventoryAuditLog.notes,
          createdAt: inventoryAuditLog.createdAt,
          performedByName: users.name,
        })
        .from(inventoryAuditLog)
        .leftJoin(users, eq(inventoryAuditLog.performedBy, users.id))
        .where(eq(inventoryAuditLog.inventoryId, input.inventoryId))
        .orderBy(desc(inventoryAuditLog.createdAt));
    }),

  // ── Associar etiqueta durante contagem de inventário ────────────────────────
  // Chamado quando scanVolume retorna found:false (etiqueta sem labelAssociation)
  associateLabelForInventory: protectedProcedure
    .input(z.object({
      labelCode: z.string().min(1),
      productId: z.number(),
      batch: z.string().optional(),
      expiryDate: z.string().optional(), // YYYY-MM-DD
      unitsPerBox: z.number().min(1).default(1),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      // Verificar se labelCode já existe (pode ter sido criado em paralelo)
      const existing = await db
        .select({ id: labelAssociations.id, uniqueCode: labelAssociations.uniqueCode })
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);
      if (existing.length > 0) {
        // Já existe — retornar os dados existentes
        const [product] = await db
          .select({ sku: products.sku, description: products.description })
          .from(products)
          .where(eq(products.id, input.productId))
          .limit(1);
        return {
          labelAssociationId: existing[0].id,
          uniqueCode: existing[0].uniqueCode,
          productId: input.productId,
          productSku: product?.sku ?? null,
          productDescription: product?.description ?? null,
          batch: input.batch ?? null,
          expiryDate: input.expiryDate ?? null,
          unitsPerBox: input.unitsPerBox,
          alreadyExisted: true,
        };
      }

      // Buscar produto para gerar uniqueCode
      const [product] = await db
        .select({ id: products.id, sku: products.sku, description: products.description })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Produto não encontrado" });
      }

      const effectiveTenantId = (input.tenantId ?? ctx.user.tenantId) as number;
      const uniqueCode = getUniqueCode(product.sku ?? String(product.id), input.batch ?? null);

      const insertResult = await db.insert(labelAssociations).values({
        tenantId: effectiveTenantId,
        labelCode: input.labelCode,
        uniqueCode,
        productId: product.id,
        batch: input.batch ?? null,
        expiryDate: (input.expiryDate ?? null) as string | null,
        unitsPerBox: input.unitsPerBox,
        associatedBy: ctx.user.id,
        status: "AVAILABLE" as const,
      });

      return {
        labelAssociationId: (insertResult as any).insertId,
        uniqueCode,
        productId: product.id,
        productSku: product.sku ?? null,
        productDescription: product.description ?? null,
        batch: input.batch ?? null,
        expiryDate: input.expiryDate ?? null,
        unitsPerBox: input.unitsPerBox,
        alreadyExisted: false,
      };
    }),

  // ── Buscar produtos para associação de etiqueta ─────────────────────────────
  searchProductsForLabel: protectedProcedure
    .input(z.object({
      query: z.string().min(1),
      tenantId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB indisponível" });

      const effectiveTenantId = (input.tenantId ?? ctx.user.tenantId) as number;
      const q = `%${input.query}%`;

      return db
        .select({
          id: products.id,
          sku: products.sku,
          description: products.description,
          internalCode: products.internalCode,
        })
        .from(products)
        .where(
          and(
            effectiveTenantId ? eq(products.tenantId, effectiveTenantId) : undefined,
            or(
              sql`COALESCE(${products.sku}, '') LIKE ${q}`,
              sql`COALESCE(${products.description}, '') LIKE ${q}`,
              sql`COALESCE(${products.internalCode}, '') LIKE ${q}`
            )
          )
        )
        .orderBy(asc(products.sku))
        .limit(20);
    }),
});
