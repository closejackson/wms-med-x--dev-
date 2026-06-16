import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { tenantProcedure, assertSameTenant } from "./_core/tenantGuard";
import {
  getOrderForStage,
  startStageCheck,
  recordStageItem,
  completeStageCheck,
  getActiveStageCheck,
  getStageCheckHistory,
} from "./stage";

/**
 * Router para o módulo de Stage (Conferência de Expedição)
 * Permite conferência cega de pedidos antes da expedição
 */
export const stageRouter = {
  /**
   * Busca pedido por customerOrderNumber para iniciar conferência
   * Apenas pedidos com status 'completed' podem ser conferidos
   */
  getOrderForStage: tenantProcedure
    .input(z.object({
      customerOrderNumber: z.string(),
      tenantId: z.number().optional(), // Global Admin pode filtrar por tenant
    }))
    .query(async ({ input, ctx }) => {
      // Global Admin sem tenantId específico: sem filtro (null = ver todos)
      const tenantId = ctx.isGlobalAdmin
        ? (input.tenantId ?? null)
        : ctx.effectiveTenantId;
      return await getOrderForStage(input.customerOrderNumber, tenantId);
    }),

  /**
   * Inicia conferência de Stage para um pedido
   * Cria registro de stageCheck e retorna itens (sem quantidades esperadas)
   */
  startStageCheck: tenantProcedure
    .input(z.object({
      pickingOrderId: z.number(),
      customerOrderNumber: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Para startStageCheck, sempre usa o tenantId do pedido (via pickingOrderId)
      // Passa null para Global Admin sem tenant selecionado
      const tenantId = ctx.isGlobalAdmin ? null : ctx.effectiveTenantId;
      return await startStageCheck({
        pickingOrderId: input.pickingOrderId,
        customerOrderNumber: input.customerOrderNumber,
        operatorId: ctx.user.id,
        operatorName: ctx.user.name || ctx.user.email || `Usuário #${ctx.user.id}`,
        tenantId,
      });
    }),

  /**
   * Registra item conferido (produto bipado + quantidade informada)
   */
  recordStageItem: tenantProcedure
    .input(z.object({
      stageCheckId: z.number(),
      labelCode: z.string(),
      quantity: z.number().positive().optional(),
      autoIncrement: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return await recordStageItem({
        stageCheckId: input.stageCheckId,
        labelCode: input.labelCode,
        quantity: input.quantity,
        autoIncrement: input.autoIncrement,
        tenantId: ctx.effectiveTenantId,
      });
    }),

  /**
   * Finaliza conferência de Stage
   * Valida divergências, baixa estoque e atualiza status do pedido
   */
  completeStageCheck: tenantProcedure
    .input(z.object({
      stageCheckId: z.number(),
      notes: z.string().optional(),
      force: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return await completeStageCheck({
        stageCheckId: input.stageCheckId,
        notes: input.notes,
        force: input.force,
        tenantId: ctx.effectiveTenantId,
      });
    }),

  /**
   * Busca conferência ativa (in_progress) do operador
   */
  getActiveStageCheck: tenantProcedure
    .query(async ({ ctx }) => {
      // Global Admin sem tenant selecionado: ver todas as conferências ativas
      const tenantId = ctx.isGlobalAdmin ? null : ctx.effectiveTenantId;
      return await getActiveStageCheck(ctx.user.id, tenantId);
    }),

  /**
   * Lista histórico de conferências de Stage
   */
  getStageCheckHistory: tenantProcedure
    .input(z.object({
      limit: z.number().default(50),
      offset: z.number().default(0),
      tenantId: z.number().optional(), // Global Admin pode filtrar por tenant
    }))
    .query(async ({ input, ctx }) => {
      // Global Admin sem tenant selecionado: ver histórico de todos os tenants
      const tenantId = ctx.isGlobalAdmin ? (input.tenantId ?? null) : ctx.effectiveTenantId;
      return await getStageCheckHistory({
        tenantId,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  /**
   * Gera etiquetas de volumes em PDF
   * Retorna PDF em base64 para impressão automática
   */
  generateVolumeLabels: tenantProcedure
    .input(z.object({
      customerOrderNumber: z.string(),
      customerName: z.string(),
      tenantName: z.string(),
      totalVolumes: z.number().min(1),
      stageCheckId: z.number().optional(), // ID da conferência de stage para salvar volumes
    }))
    .mutation(async ({ input }) => {
      const { generateVolumeLabels } = await import("./volumeLabels");
      
      const labels = Array.from({ length: input.totalVolumes }, (_, i) => ({
        customerOrderNumber: input.customerOrderNumber,
        customerName: input.customerName,
        tenantName: input.tenantName,
        volumeNumber: i + 1,
        totalVolumes: input.totalVolumes,
      }));

      const pdfBuffer = await generateVolumeLabels(labels);

      // Salvar totalVolumes no stageCheck correspondente (para uso no romaneio)
      try {
        const { getDb } = await import("./db");
        const { stageChecks } = await import("../drizzle/schema");
        const { eq, desc } = await import("drizzle-orm");
        const db = await getDb();
        if (db) {
          if (input.stageCheckId) {
            // Salvar diretamente pelo ID da conferência
            await db.update(stageChecks)
              .set({ totalVolumes: input.totalVolumes })
              .where(eq(stageChecks.id, input.stageCheckId));
          } else {
            // Fallback: salvar no stageCheck mais recente do pedido
            const [latestCheck] = await db
              .select({ id: stageChecks.id })
              .from(stageChecks)
              .where(eq(stageChecks.customerOrderNumber, input.customerOrderNumber))
              .orderBy(desc(stageChecks.completedAt))
              .limit(1);
            if (latestCheck) {
              await db.update(stageChecks)
                .set({ totalVolumes: input.totalVolumes })
                .where(eq(stageChecks.id, latestCheck.id));
            }
          }
        }
      } catch (e) {
        console.error("[Stage] Erro ao salvar totalVolumes no stageCheck:", e);
      }
      
      return {
        success: true,
        pdfBase64: pdfBuffer.toString("base64"),
        filename: `etiquetas-${input.customerOrderNumber}.pdf`,
      };
    }),

  /**
   * Desfazer última bipagem no stage (LIFO)
   * Decrementa checkedQuantity do item identificado pelo stageCheckItemId
   */
  undoLastStageItem: tenantProcedure
    .input(z.object({
      stageCheckId: z.number(),
      stageCheckItemId: z.number(),
      quantityToUndo: z.number().min(1).default(1),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { stageCheckItems } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [item] = await db
        .select()
        .from(stageCheckItems)
        .where(eq(stageCheckItems.id, input.stageCheckItemId))
        .limit(1);

      if (!item || item.stageCheckId !== input.stageCheckId) {
        throw new Error("Item de conferência não encontrado");
      }
      if (item.checkedQuantity <= 0) {
        throw new Error("Nenhuma bipagem para desfazer neste item");
      }

      const qty = Math.min(input.quantityToUndo, item.checkedQuantity);
      const newChecked = item.checkedQuantity - qty;
      const newDivergence = newChecked - item.expectedQuantity;

       await db.update(stageCheckItems)
        .set({
          checkedQuantity: newChecked,
          divergence: newDivergence,
        })
        .where(eq(stageCheckItems.id, item.id));
      // Buscar nome do produto para retornar ao frontend
      const { products } = await import("../drizzle/schema");
      const [prod] = await db
        .select({ description: products.description })
        .from(products)
        .where(eq(products.id, item.productId))
        .limit(1);
      return {
        ok: true,
        quantityReverted: qty,
        newCheckedQuantity: newChecked,
        newRemainingQuantity: item.expectedQuantity - newChecked,
        productName: prod?.description ?? "",
        message: `Última bipagem desfeita (${qty} un.)`,
      };
    }),

  /**
   * Heartbeat: atualiza lastActivityAt para manter o lock ativo
   */
  stageHeartbeat: tenantProcedure
    .input(z.object({ stageCheckId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { getDb } = await import("./db");
      const { stageChecks } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(stageChecks)
        .set({ lastActivityAt: new Date() })
        .where(
          and(
            eq(stageChecks.id, input.stageCheckId),
            eq(stageChecks.lockedByUserId, ctx.user.id)
          )
        );
      return { ok: true };
    }),

  /**
   * Libera o lock voluntariamente (saída do usuário)
   */
  releaseStageLock: tenantProcedure
    .input(z.object({ stageCheckId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { getDb } = await import("./db");
      const { stageChecks } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(stageChecks)
        .set({ lockedByUserId: null, lockedByName: null })
        .where(
          and(
            eq(stageChecks.id, input.stageCheckId),
            eq(stageChecks.lockedByUserId, ctx.user.id)
          )
        );
      return { ok: true };
    }),

  /**
   * Força liberação do lock (apenas Global Admin)
   */
  forceReleaseStageLock: tenantProcedure
    .input(z.object({ stageCheckId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.isGlobalAdmin) {
        const { TRPCError } = await import("@trpc/server");
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas o administrador global pode forçar a liberação." });
      }
      const { getDb } = await import("./db");
      const { stageChecks } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(stageChecks)
        .set({ lockedByUserId: null, lockedByName: null })
        .where(eq(stageChecks.id, input.stageCheckId));
      return { ok: true, message: "Lock liberado pelo administrador." };
    }),

  /**
   * Cancela conferência de Stage em andamento
   * Deleta registros de stageCheck e stageCheckItems
   */
  cancelStageCheck: tenantProcedure
    .input(z.object({
      stageCheckId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { cancelStageCheck } = await import("./stage");
      // Global Admin: sem filtro de tenant (null = acesso irrestrito)
      const tenantId = ctx.isGlobalAdmin ? null : ctx.effectiveTenantId;
      return await cancelStageCheck({
        stageCheckId: input.stageCheckId,
        tenantId,
      });
    }),

  /**
   * Registrar conferência completa (Global Admin only)
   * Marca o pedido como 'staged' sem exigir bipagem item a item
   */
  completeConferenceFull: protectedProcedure
    .input(z.object({ customerOrderNumber: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if ((ctx.user as any).tenantId !== 1) {
        const { TRPCError } = await import("@trpc/server");
        throw new TRPCError({ code: "FORBIDDEN", message: "Funcionalidade restrita ao Global Admin." });
      }
      const { getDb } = await import("./db");
      const { eq, and, isNull, like, or, sql } = await import("drizzle-orm");
      const {
        pickingOrders, stageChecks, pickingWaves, pickingAllocations,
        inventory, inventoryMovements, warehouseLocations, products, tenants,
      } = await import("../drizzle/schema");
      const { getUniqueCode } = await import("./utils/uniqueCode");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [order] = await db
        .select({ id: pickingOrders.id, status: pickingOrders.status, waveId: pickingOrders.waveId, tenantId: pickingOrders.tenantId, customerOrderNumber: pickingOrders.customerOrderNumber })
        .from(pickingOrders)
        .where(eq(pickingOrders.customerOrderNumber, input.customerOrderNumber))
        .limit(1);

      if (!order) throw new Error(`Pedido '${input.customerOrderNumber}' não encontrado.`);
      if (order.status === "staged") throw new Error("Pedido já está conferido (staged).");
      if (order.status !== "picked") throw new Error(`Pedido deve estar com status 'picked'. Status atual: '${order.status}'.`);

      // -----------------------------------------------------------------------
      // 1. Determinar endereço de expedição (EXP) do cliente
      // -----------------------------------------------------------------------
      const [tenant] = await db
        .select({ shippingAddress: tenants.shippingAddress })
        .from(tenants)
        .where(eq(tenants.id, order.tenantId))
        .limit(1);

      let shippingLocation: { id: number; code: string };

      if (!tenant?.shippingAddress) {
        const [autoLoc] = await db
          .select({ id: warehouseLocations.id, code: warehouseLocations.code })
          .from(warehouseLocations)
          .where(and(
            like(warehouseLocations.code, "EXP%"),
            eq(warehouseLocations.tenantId, order.tenantId),
          ))
          .limit(1);
        if (!autoLoc) throw new Error("Nenhum endereço de expedição (EXP) encontrado para este cliente.");
        shippingLocation = autoLoc;
      } else {
        const [cfgLoc] = await db
          .select({ id: warehouseLocations.id, code: warehouseLocations.code })
          .from(warehouseLocations)
          .where(and(
            eq(warehouseLocations.code, tenant.shippingAddress),
            eq(warehouseLocations.tenantId, order.tenantId),
          ))
          .limit(1);
        if (!cfgLoc) throw new Error(`Endereço de expedição '${tenant.shippingAddress}' não encontrado.`);
        shippingLocation = cfgLoc;
      }

      // -----------------------------------------------------------------------
      // 2. Buscar todas as alocações do pedido e movimentar STORAGE → EXP
      // -----------------------------------------------------------------------
      const allocations = await db
        .select({
          id: pickingAllocations.id,
          productId: pickingAllocations.productId,
          locationId: pickingAllocations.locationId,
          quantity: pickingAllocations.quantity,
          batch: pickingAllocations.batch,
        })
        .from(pickingAllocations)
        .where(eq(pickingAllocations.pickingOrderId, order.id));

      for (const alloc of allocations) {
        const invConditions: any[] = [
          eq(inventory.productId, alloc.productId),
          eq(inventory.locationId, alloc.locationId),
        ];
        if (alloc.batch) {
          invConditions.push(eq(inventory.batch, alloc.batch));
        } else {
          invConditions.push(isNull(inventory.batch));
        }

        const [srcInv] = await db
          .select({
            id: inventory.id,
            locationId: inventory.locationId,
            productId: inventory.productId,
            productSku: products.sku,
            batch: inventory.batch,
            expiryDate: inventory.expiryDate,
            quantity: inventory.quantity,
            tenantId: inventory.tenantId,
            status: inventory.status,
          })
          .from(inventory)
          .leftJoin(products, eq(inventory.productId, products.id))
          .where(and(...invConditions))
          .limit(1);

        if (!srcInv) {
          console.warn(`[STAGE] completeConferenceFull: estoque não encontrado para produto ${alloc.productId} lote ${alloc.batch} end ${alloc.locationId}`);
          continue;
        }

        const qty = Math.min(alloc.quantity, srcInv.quantity);
        if (qty <= 0) continue;

        // Subtrair do STORAGE
        const newQty = srcInv.quantity - qty;
        await db.update(inventory)
          .set({
            quantity: newQty,
            reservedQuantity: 0,
            status: newQty === 0 ? "available" : srcInv.status,
          })
          .where(eq(inventory.id, srcInv.id));

        // Liberar endereço se ficou vazio
        if (newQty === 0) {
          const [others] = await db
            .select({ count: sql<number>`count(*)` })
            .from(inventory)
            .where(and(
              eq(inventory.locationId, srcInv.locationId),
              sql`${inventory.quantity} > 0`,
              sql`${inventory.id} != ${srcInv.id}`,
            ));
          if (others && others.count === 0) {
            await db.update(warehouseLocations)
              .set({ status: "available" })
              .where(eq(warehouseLocations.id, srcInv.locationId));
          }
        }

        // Adicionar ao EXP
        const expConditions: any[] = [
          eq(inventory.locationId, shippingLocation.id),
          eq(inventory.productId, srcInv.productId),
          eq(inventory.tenantId, order.tenantId),
        ];
        if (srcInv.batch) expConditions.push(eq(inventory.batch, srcInv.batch));

        const [existingExp] = await db
          .select({ id: inventory.id, quantity: inventory.quantity })
          .from(inventory)
          .where(and(...expConditions))
          .limit(1);

        if (existingExp) {
          await db.update(inventory)
            .set({ quantity: existingExp.quantity + qty })
            .where(eq(inventory.id, existingExp.id));
        } else {
          await db.insert(inventory).values({
            locationId: shippingLocation.id,
            productId: srcInv.productId,
            batch: srcInv.batch,
            expiryDate: srcInv.expiryDate,
            quantity: qty,
            tenantId: order.tenantId,
            status: "available",
            uniqueCode: getUniqueCode(srcInv.productSku || "", srcInv.batch || ""),
            locationZone: "EXP",
          });
        }

        // Registrar movimentação
        await db.insert(inventoryMovements).values({
          tenantId: order.tenantId,
          productId: srcInv.productId,
          batch: srcInv.batch,
          uniqueCode: getUniqueCode(srcInv.productSku || "", srcInv.batch || ""),
          serialNumber: null,
          fromLocationId: srcInv.locationId,
          toLocationId: shippingLocation.id,
          quantity: qty,
          movementType: "picking",
          referenceType: "picking_order",
          referenceId: order.id,
          performedBy: ctx.user.id,
          notes: `Movimentação automática via Registrar conferência completa (Global Admin) - Pedido ${order.customerOrderNumber}`,
          conversionSource: "manual",
        });
      }

      // -----------------------------------------------------------------------
      // 3. Registrar / atualizar stageCheck
      // -----------------------------------------------------------------------
      const [existingCheck] = await db
        .select({ id: stageChecks.id })
        .from(stageChecks)
        .where(and(eq(stageChecks.pickingOrderId, order.id), eq(stageChecks.status, "in_progress")))
        .limit(1);
      if (existingCheck) {
        await db.update(stageChecks)
          .set({ status: "completed", completedAt: new Date(), notes: "Finalizado via Registrar conferência completa (Global Admin)" })
          .where(eq(stageChecks.id, existingCheck.id));
      } else {
        await db.insert(stageChecks).values({
          tenantId: order.tenantId,
          pickingOrderId: order.id,
          customerOrderNumber: input.customerOrderNumber,
          operatorId: ctx.user.id,
          status: "completed",
          completedAt: new Date(),
          notes: "Registrado via Registrar conferência completa (Global Admin)",
        });
      }

      // -----------------------------------------------------------------------
      // 4. Atualizar status do pedido e da onda
      // -----------------------------------------------------------------------
      await db.update(pickingOrders)
        .set({ status: "staged" })
        .where(eq(pickingOrders.id, order.id));

      if (order.waveId) {
        const waveOrders = await db
          .select({ id: pickingOrders.id, status: pickingOrders.status })
          .from(pickingOrders)
          .where(eq(pickingOrders.waveId, order.waveId));
        const allStaged = waveOrders.every(o => o.status === "staged" || o.id === order.id);
        if (allStaged) {
          await db.update(pickingWaves)
            .set({ status: "staged" })
            .where(eq(pickingWaves.id, order.waveId));
        }
      }

      console.log(`[STAGE] completeConferenceFull: pedido ${input.customerOrderNumber} movimentado para ${shippingLocation.code} e marcado como staged por userId=${ctx.user.id}`);
      return { ok: true, message: `Conferência do pedido ${input.customerOrderNumber} registrada! Produtos movimentados para ${shippingLocation.code}.` };
    }),

  /**
   * Desfazer conferência completa (Global Admin only)
   * Reverte pedido de 'staged' para 'picked' e restaura movimentações de estoque
   */
  undoConferenceFull: protectedProcedure
    .input(z.object({ customerOrderNumber: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if ((ctx.user as any).tenantId !== 1) {
        const { TRPCError } = await import("@trpc/server");
        throw new TRPCError({ code: "FORBIDDEN", message: "Funcionalidade restrita ao Global Admin." });
      }
      const { getDb } = await import("./db");
      const { eq, and } = await import("drizzle-orm");
      const {
        pickingOrders, stageChecks, pickingWaves,
        inventory, inventoryMovements,
      } = await import("../drizzle/schema");
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [order] = await db
        .select({ id: pickingOrders.id, status: pickingOrders.status, waveId: pickingOrders.waveId, tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(eq(pickingOrders.customerOrderNumber, input.customerOrderNumber))
        .limit(1);

      if (!order) throw new Error(`Pedido '${input.customerOrderNumber}' não encontrado.`);
      if (order.status !== "staged") throw new Error(`Não é possível desfazer: pedido está com status '${order.status}', esperado 'staged'.`);

      // Buscar movimentações de picking para reverter
      const movements = await db
        .select()
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.referenceType, "picking_order"),
            eq(inventoryMovements.referenceId, order.id),
            eq(inventoryMovements.movementType, "picking")
          )
        );

      for (const mov of movements) {
        if (!mov.fromLocationId || !mov.toLocationId) continue;

        // Subtrair do endereço de destino (EXP)
        const [destInv] = await db
          .select({ id: inventory.id, quantity: inventory.quantity })
          .from(inventory)
          .where(and(
            eq(inventory.locationId, mov.toLocationId),
            eq(inventory.productId, mov.productId),
            eq(inventory.tenantId, order.tenantId)
          ))
          .limit(1);
        if (destInv) {
          await db.update(inventory)
            .set({ quantity: Math.max(0, destInv.quantity - mov.quantity) })
            .where(eq(inventory.id, destInv.id));
        }

        // Devolver ao endereço de origem (STORAGE)
        const [srcInv] = await db
          .select({ id: inventory.id, quantity: inventory.quantity })
          .from(inventory)
          .where(and(
            eq(inventory.locationId, mov.fromLocationId),
            eq(inventory.productId, mov.productId),
            eq(inventory.tenantId, order.tenantId)
          ))
          .limit(1);
        if (srcInv) {
          await db.update(inventory)
            .set({ quantity: srcInv.quantity + mov.quantity, status: "available" })
            .where(eq(inventory.id, srcInv.id));
        }
      }

      // Reverter stageChecks para in_progress
      await db.update(stageChecks)
        .set({ status: "in_progress", completedAt: null })
        .where(and(eq(stageChecks.pickingOrderId, order.id), eq(stageChecks.status, "completed")));

      // Reverter status do pedido para 'picked'
      await db.update(pickingOrders)
        .set({ status: "picked" })
        .where(eq(pickingOrders.id, order.id));

      // Reverter onda para 'picked'
      if (order.waveId) {
        await db.update(pickingWaves)
          .set({ status: "picked" })
          .where(and(eq(pickingWaves.id, order.waveId), eq(pickingWaves.status, "staged")));
      }

      console.log(`[STAGE] undoConferenceFull: pedido ${input.customerOrderNumber} revertido para 'picked' por userId=${ctx.user.id}`);
      return { ok: true, message: `Conferência do pedido ${input.customerOrderNumber} desfeita. Pedido retornado para status 'picked'.` };
    }),
};
