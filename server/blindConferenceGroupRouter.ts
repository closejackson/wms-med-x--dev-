/**
 * Router: Recebimento Cego Agrupado (Multi-NF)
 *
 * Permite selecionar múltiplas NFs e realizar uma única conferência cega unificada.
 * A distribuição das bipagens entre as NFs é feita virtualmente (FIFO) e persistida
 * apenas na finalização, garantindo que o operador possa corrigir erros sem bagunçar
 * os saldos individuais de cada nota prematuramente.
 *
 * Fluxo:
 *  1. createGroup       → cria grupo, bloqueia NFs (status → in_progress)
 *  2. getGroupSummary   → retorna itens consolidados + progresso atual
 *  3. scanLabel         → registra bipagem em blindConferenceGroupScans
 *  4. undoLastScan      → desfaz última bipagem (LIFO)
 *  5. finalizeGroup     → distribui FIFO, persiste inventory por NF, fecha grupo
 *  6. cancelGroup       → libera bloqueio das NFs
 *  7. getActiveGroup    → retorna grupo ativo do tenant (para retomada)
 */

import { router } from "./_core/trpc";
import { tenantProcedure } from "./_core/tenantGuard";
import { getDb } from "./db";
import {
  blindConferenceGroups,
  blindConferenceGroupOrders,
  blindConferenceGroupScans,
  receivingOrders,
  receivingOrderItems,
  products,
  inventory,
  inventoryMovements,
  warehouseLocations,
  warehouseZones,
  labelAssociations,
} from "../drizzle/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getUniqueCode } from "./utils/uniqueCode";

/** Extrai a parte YYYY-MM-DD de um Date ou string, ignorando timezone. */
function toDateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") {
    const trimmed = d.trim();
    if (!trimmed) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
    const datePart = trimmed.split("T")[0].split(" ")[0];
    const parsed = new Date(datePart + "T00:00:00Z");
    if (isNaN(parsed.getTime())) return null;
    return datePart;
  }
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const blindConferenceGroupRouter = router({
  /**
   * 1. Criar Grupo de Conferência Agrupada
   * Valida as NFs, cria o grupo e bloqueia as NFs (status → in_progress).
   */
  createGroup: tenantProcedure
    .input(z.object({
      receivingOrderIds: z.array(z.number()).min(2, "Selecione ao menos 2 NFs para conferência agrupada"),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;

      // Buscar todas as NFs e validar
      const orders = await db.select()
        .from(receivingOrders)
        .where(inArray(receivingOrders.id, input.receivingOrderIds));

      if (orders.length !== input.receivingOrderIds.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Uma ou mais NFs não foram encontradas." });
      }

      // Validar que todas pertencem ao mesmo tenant
      const tenantIds = Array.from(new Set(orders.map(o => o.tenantId)));
      if (tenantIds.length > 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Todas as NFs devem pertencer ao mesmo cliente." });
      }
      const orderTenantId = tenantIds[0];

      // Validar que todas estão com status "scheduled"
      const notScheduled = orders.filter(o => o.status !== "scheduled");
      if (notScheduled.length > 0) {
        const nums = notScheduled.map(o => o.nfeNumber || o.orderNumber).join(", ");
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `As seguintes NFs não estão com status "Agendado": ${nums}. Apenas NFs agendadas podem ser agrupadas.`
        });
      }

      // Verificar se alguma NF já está em outro grupo ativo
      const existingGroupOrders = await db.select({
        receivingOrderId: blindConferenceGroupOrders.receivingOrderId,
        groupId: blindConferenceGroupOrders.groupId,
      })
        .from(blindConferenceGroupOrders)
        .innerJoin(blindConferenceGroups, eq(blindConferenceGroupOrders.groupId, blindConferenceGroups.id))
        .where(
          and(
            inArray(blindConferenceGroupOrders.receivingOrderId, input.receivingOrderIds),
            eq(blindConferenceGroups.status, "active")
          )
        );

      if (existingGroupOrders.length > 0) {
        const lockedIds = existingGroupOrders.map(g => g.receivingOrderId);
        const lockedNFs = orders.filter(o => lockedIds.includes(o.id)).map(o => o.nfeNumber || o.orderNumber).join(", ");
        throw new TRPCError({
          code: "CONFLICT",
          message: `As seguintes NFs já estão em uma conferência agrupada ativa: ${lockedNFs}.`
        });
      }

      // Criar o grupo
      const groupNumber = `GRP-${Date.now()}`;
      await db.insert(blindConferenceGroups).values({
        tenantId: orderTenantId,
        groupNumber,
        startedBy: userId,
        status: "active",
      });

      // Buscar o grupo criado
      const [newGroup] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.groupNumber, groupNumber))
        .limit(1);

      // Vincular NFs ao grupo (ordem FIFO = ordem de seleção)
      for (let i = 0; i < input.receivingOrderIds.length; i++) {
        await db.insert(blindConferenceGroupOrders).values({
          groupId: newGroup.id,
          receivingOrderId: input.receivingOrderIds[i],
          tenantId: orderTenantId,
          fifoOrder: i,
        });
      }

      // Bloquear NFs (status → in_progress)
      await db.update(receivingOrders)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(inArray(receivingOrders.id, input.receivingOrderIds));

      return {
        success: true,
        groupId: newGroup.id,
        groupNumber: newGroup.groupNumber,
        message: `Grupo criado com ${orders.length} NFs. Conferência agrupada iniciada.`,
      };
    }),

  /**
   * 2. Buscar Resumo do Grupo (visão unificada para o coletor)
   * Retorna itens consolidados (soma de todas as NFs) + progresso atual das bipagens.
   */
  getGroupSummary: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      tenantId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Buscar grupo
      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Grupo de conferência não encontrado." });

      const orderTenantId = group.tenantId;

      // Buscar NFs do grupo (ordem FIFO)
      const groupOrders = await db.select({
        id: blindConferenceGroupOrders.id,
        receivingOrderId: blindConferenceGroupOrders.receivingOrderId,
        fifoOrder: blindConferenceGroupOrders.fifoOrder,
        orderNumber: receivingOrders.orderNumber,
        nfeNumber: receivingOrders.nfeNumber,
        supplierName: receivingOrders.supplierName,
        status: receivingOrders.status,
      })
        .from(blindConferenceGroupOrders)
        .innerJoin(receivingOrders, eq(blindConferenceGroupOrders.receivingOrderId, receivingOrders.id))
        .where(eq(blindConferenceGroupOrders.groupId, input.groupId))
        .orderBy(blindConferenceGroupOrders.fifoOrder);

      const orderIds = groupOrders.map(o => o.receivingOrderId);

      // Buscar itens esperados de todas as NFs (consolidado por productId + batch)
      const expectedItems = await db.select({
        productId: receivingOrderItems.productId,
        batch: receivingOrderItems.batch,
        expiryDate: receivingOrderItems.expiryDate,
        totalExpected: sql<number>`SUM(${receivingOrderItems.expectedQuantity})`,
        productSku: products.sku,
        productName: products.description,
        productUnitsPerBox: products.unitsPerBox,
      })
        .from(receivingOrderItems)
        .leftJoin(products, eq(receivingOrderItems.productId, products.id))
        .where(
          and(
            inArray(receivingOrderItems.receivingOrderId, orderIds),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        )
        .groupBy(receivingOrderItems.productId, receivingOrderItems.batch, receivingOrderItems.expiryDate, products.sku, products.description, products.unitsPerBox);

      // Buscar bipagens ativas do grupo (não desfeitas)
      const scans = await db.select({
        productId: blindConferenceGroupScans.productId,
        batch: blindConferenceGroupScans.batch,
        totalUnitsRead: sql<number>`SUM(${blindConferenceGroupScans.unitsRead})`,
        totalPackages: sql<number>`COUNT(*)`,
      })
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        )
        .groupBy(blindConferenceGroupScans.productId, blindConferenceGroupScans.batch);

      // Mapa de bipagens: "productId|batch" → { unitsRead, packages }
      const scansMap = new Map<string, { unitsRead: number; packages: number }>();
      for (const s of scans) {
        const key = `${s.productId}|${s.batch ?? ""}`;
        scansMap.set(key, {
          unitsRead: Number(s.totalUnitsRead) || 0,
          packages: Number(s.totalPackages) || 0,
        });
      }

      // Consolidar itens
      const consolidatedItems = expectedItems.map(item => {
        const key = `${item.productId}|${item.batch ?? ""}`;
        const scan = scansMap.get(key) || { unitsRead: 0, packages: 0 };
        const totalExpected = Number(item.totalExpected) || 0;
        const unitsRead = scan.unitsRead;
        const isExcess = unitsRead > totalExpected;
        return {
          productId: item.productId,
          productSku: item.productSku || "",
          productName: item.productName || "",
          productUnitsPerBox: item.productUnitsPerBox ?? 1,
          batch: item.batch || null,
          expiryDate: item.expiryDate || null,
          totalExpected,
          unitsRead,
          packagesRead: scan.packages,
          pendingUnits: Math.max(0, totalExpected - unitsRead),
          isExcess,
          isComplete: unitsRead >= totalExpected && totalExpected > 0,
        };
      });

      // Buscar última bipagem (para botão Desfazer)
      const [lastScan] = await db.select()
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        )
        .orderBy(desc(blindConferenceGroupScans.id))
        .limit(1);

      const totalExpected = consolidatedItems.reduce((sum, i) => sum + i.totalExpected, 0);
      const totalRead = consolidatedItems.reduce((sum, i) => sum + i.unitsRead, 0);

      return {
        group: {
          id: group.id,
          groupNumber: group.groupNumber,
          status: group.status,
          startedAt: group.startedAt,
        },
        orders: groupOrders,
        consolidatedItems,
        totalExpected,
        totalRead,
        progress: totalExpected > 0 ? Math.min(100, Math.round((totalRead / totalExpected) * 100)) : 0,
        hasExcess: consolidatedItems.some(i => i.isExcess),
        canUndo: !!lastScan,
        lastScanId: lastScan?.id ?? null,
      };
    }),

  /**
   * 3. Bipar Etiqueta no Grupo
   * Registra a leitura em blindConferenceGroupScans (distribuição FIFO é feita na finalização).
   */
  scanLabel: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      labelCode: z.string().min(1),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;

      // Buscar grupo
      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group || group.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
      }

      const orderTenantId = group.tenantId;

      // Buscar etiqueta (labelAssociations é global, sem filtro de tenant)
      const [label] = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      if (!label) {
        return {
          isNewLabel: true,
          message: "Etiqueta não cadastrada no sistema.",
          association: null,
        };
      }

      // Buscar produto
      const [product] = await db.select()
        .from(products)
        .where(eq(products.id, label.productId))
        .limit(1);

      // Verificar se este produto está em alguma das NFs do grupo
      const groupOrders = await db.select({ receivingOrderId: blindConferenceGroupOrders.receivingOrderId })
        .from(blindConferenceGroupOrders)
        .where(eq(blindConferenceGroupOrders.groupId, input.groupId));

      const orderIds = groupOrders.map(o => o.receivingOrderId);

      const matchingItems = await db.select({
        totalExpected: sql<number>`SUM(${receivingOrderItems.expectedQuantity})`,
      })
        .from(receivingOrderItems)
        .where(
          and(
            inArray(receivingOrderItems.receivingOrderId, orderIds),
            eq(receivingOrderItems.productId, label.productId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        );

      const totalExpected = Number(matchingItems[0]?.totalExpected) || 0;

      // Calcular total já bipado para este produto+lote
      const [currentScans] = await db.select({
        totalUnitsRead: sql<number>`COALESCE(SUM(${blindConferenceGroupScans.unitsRead}), 0)`,
      })
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.productId, label.productId),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        );

      const currentTotal = Number(currentScans?.totalUnitsRead) || 0;
      const newTotal = currentTotal + label.unitsPerBox;
      const isExcess = newTotal > totalExpected && totalExpected > 0;

      // Registrar bipagem
      await db.insert(blindConferenceGroupScans).values({
        groupId: input.groupId,
        tenantId: orderTenantId,
        productId: label.productId,
        labelCode: input.labelCode,
        uniqueCode: label.uniqueCode,
        batch: label.batch || null,
        expiryDate: toDateStr(label.expiryDate) as any,
        unitsPerBox: label.unitsPerBox,
        unitsRead: label.unitsPerBox,
        scannedBy: userId,
        isUndone: false,
      });

      const remainingAfterScan = totalExpected > 0 ? Math.max(0, totalExpected - newTotal) : null;

      return {
        isNewLabel: false,
        isExcess,
        association: {
          labelCode: input.labelCode, // ✅ Código da etiqueta para caixa fracionada
          productId: label.productId,
          productName: product?.description || "",
          productSku: product?.sku || "",
          batch: label.batch,
          expiryDate: label.expiryDate,
          unitsPerBox: label.unitsPerBox,
          currentTotal: newTotal,
          totalExpected,
          remainingQuantity: remainingAfterScan,
        },
        message: isExcess
          ? `⚠️ Quantidade excedente! Total bipado (${newTotal}) supera o esperado (${totalExpected}) para este SKU no agrupamento.`
          : `✅ ${product?.description || "Produto"} | Lote: ${label.batch || "-"} | +${label.unitsPerBox} un. (Total: ${newTotal}/${totalExpected})`,
      };
    }),

  /**
   * 4. Desfazer Última Bipagem (LIFO)
   * Marca a última bipagem como isUndone=true.
   */
  undoLastScan: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group || group.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
      }

      // Buscar última bipagem não desfeita (LIFO)
      const [lastScan] = await db.select()
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        )
        .orderBy(desc(blindConferenceGroupScans.id))
        .limit(1);

      if (!lastScan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Nenhuma bipagem para desfazer." });
      }

      // Marcar como desfeita
      await db.update(blindConferenceGroupScans)
        .set({ isUndone: true })
        .where(eq(blindConferenceGroupScans.id, lastScan.id));

      const [product] = await db.select({ description: products.description, sku: products.sku })
        .from(products)
        .where(eq(products.id, lastScan.productId))
        .limit(1);

      return {
        success: true,
        undoneLabel: lastScan.labelCode,
        productName: product?.description || "",
        unitsRemoved: lastScan.unitsRead,
        message: `Desfeito: ${product?.description || lastScan.labelCode} | -${lastScan.unitsRead} un.`,
      };
    }),

  /**
   * 4b. Corrigir Caixa Fracionada no Grupo
   * Quando o operador bipa uma caixa com unitsPerBox > 1 mas ela está fracionada,
   * corrige o unitsRead do scan mais recente para a quantidade real informada.
   */
  correctFractionalBox: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      labelCode: z.string().min(1),
      fractionalQty: z.number().int().positive(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group || group.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
      }

      // Buscar o scan mais recente desta etiqueta neste grupo (não desfeito)
      const [lastScan] = await db.select()
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.labelCode, input.labelCode),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        )
        .orderBy(desc(blindConferenceGroupScans.id))
        .limit(1);

      if (!lastScan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Bipagem não encontrada para correção." });
      }

      if (input.fractionalQty >= lastScan.unitsPerBox) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Quantidade fracionada (${input.fractionalQty}) deve ser menor que a caixa cheia (${lastScan.unitsPerBox}).`
        });
      }

      // Corrigir unitsRead para a quantidade real
      await db.update(blindConferenceGroupScans)
        .set({ unitsRead: input.fractionalQty })
        .where(eq(blindConferenceGroupScans.id, lastScan.id));

      return {
        success: true,
        labelCode: input.labelCode,
        originalUnits: lastScan.unitsPerBox,
        correctedUnits: input.fractionalQty,
        message: `Caixa fracionada registrada: ${input.fractionalQty} de ${lastScan.unitsPerBox} unidades.`,
      };
    }),

  /**
   * 5. Finalizar Grupo (Distribuição FIFO + Persistência)
   * Distribui as bipagens entre as NFs (FIFO), cria inventory por NF e fecha o grupo.
   */
  finalizeGroup: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;

      return await db.transaction(async (tx) => {
        // 1. Buscar grupo
        const [group] = await tx.select()
          .from(blindConferenceGroups)
          .where(eq(blindConferenceGroups.id, input.groupId))
          .limit(1);

        if (!group || group.status !== "active") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
        }

        const orderTenantId = group.tenantId;

        // 2. Buscar NFs do grupo (ordem FIFO)
        const groupOrders = await tx.select({
          receivingOrderId: blindConferenceGroupOrders.receivingOrderId,
          fifoOrder: blindConferenceGroupOrders.fifoOrder,
        })
          .from(blindConferenceGroupOrders)
          .where(eq(blindConferenceGroupOrders.groupId, input.groupId))
          .orderBy(blindConferenceGroupOrders.fifoOrder);

        const orderIds = groupOrders.map(o => o.receivingOrderId);

        // 3. Buscar todas as bipagens ativas do grupo
        const allScans = await tx.select()
          .from(blindConferenceGroupScans)
          .where(
            and(
              eq(blindConferenceGroupScans.groupId, input.groupId),
              eq(blindConferenceGroupScans.isUndone, false)
            )
          )
          .orderBy(blindConferenceGroupScans.id); // Ordem cronológica

        if (allScans.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Nenhuma etiqueta foi bipada nesta conferência. Bipe ao menos uma etiqueta antes de finalizar."
          });
        }

        // 4. Buscar itens esperados de cada NF (para distribuição FIFO)
        // Estrutura: { receivingOrderId → { "productId|batch" → { itemId, expectedQty, remaining } } }
        const allOrderItems = await tx.select({
          id: receivingOrderItems.id,
          receivingOrderId: receivingOrderItems.receivingOrderId,
          productId: receivingOrderItems.productId,
          batch: receivingOrderItems.batch,
          expiryDate: receivingOrderItems.expiryDate,
          uniqueCode: receivingOrderItems.uniqueCode,
          labelCode: receivingOrderItems.labelCode,
          expectedQuantity: receivingOrderItems.expectedQuantity,
          blockedQuantity: receivingOrderItems.blockedQuantity,
        })
          .from(receivingOrderItems)
          .where(
            and(
              inArray(receivingOrderItems.receivingOrderId, orderIds),
              eq(receivingOrderItems.tenantId, orderTenantId)
            )
          );

        // Mapa FIFO: por NF (fifoOrder) → por "productId|batch" → item com saldo restante
        type FifoItem = {
          id: number;
          receivingOrderId: number;
          productId: number;
          batch: string | null;
          expiryDate: string | null;
          uniqueCode: string | null;
          labelCode: string | null;
          expectedQuantity: number;
          blockedQuantity: number;
          remaining: number; // saldo disponível para receber
        };

        // Agrupar por NF na ordem FIFO
        const fifoQueues = new Map<string, FifoItem[]>(); // key: "productId|batch"
        for (const go of groupOrders) {
          const orderItems = allOrderItems.filter(i => i.receivingOrderId === go.receivingOrderId);
          for (const item of orderItems) {
            const key = `${item.productId}|${item.batch ?? ""}`;
            if (!fifoQueues.has(key)) fifoQueues.set(key, []);
            fifoQueues.get(key)!.push({
              ...item,
              batch: item.batch ?? null,
              expiryDate: item.expiryDate ? String(item.expiryDate) : null,
              uniqueCode: item.uniqueCode ?? null,
              labelCode: item.labelCode ?? null,
              expectedQuantity: Number(item.expectedQuantity) || 0,
              blockedQuantity: Number(item.blockedQuantity) || 0,
              remaining: Number(item.expectedQuantity) || 0,
            });
          }
        }

        // 5. Distribuição FIFO: para cada bipagem, consumir saldo das NFs em ordem
        // Acumular quantidade recebida por item: itemId → totalReceived
        const receivedByItem = new Map<number, number>();

        for (const scan of allScans) {
          const key = `${scan.productId}|${scan.batch ?? ""}`;
          const queue = fifoQueues.get(key) || [];
          let remaining = scan.unitsRead;

          for (const item of queue) {
            if (remaining <= 0) break;
            const canConsume = Math.min(item.remaining, remaining);
            if (canConsume <= 0) continue;
            item.remaining -= canConsume;
            remaining -= canConsume;
            receivedByItem.set(item.id, (receivedByItem.get(item.id) || 0) + canConsume);
          }
          // Se remaining > 0 após consumir todas as NFs: excesso (já alertado no frontend)
          // Distribuir o excesso na última NF que tem este produto
          if (remaining > 0 && queue.length > 0) {
            const lastItem = queue[queue.length - 1];
            receivedByItem.set(lastItem.id, (receivedByItem.get(lastItem.id) || 0) + remaining);
          }
        }

        // 6. Buscar zona REC
        const [zoneREC] = await tx.select()
          .from(warehouseZones)
          .where(eq(warehouseZones.code, "REC"))
          .limit(1);

        if (!zoneREC) throw new Error("Zona de Recebimento ('REC') não configurada");

        const [recLocation] = await tx.select()
          .from(warehouseLocations)
          .where(
            and(
              eq(warehouseLocations.tenantId, orderTenantId),
              eq(warehouseLocations.zoneId, zoneREC.id)
            )
          )
          .limit(1);

        if (!recLocation) throw new Error("Endereço de recebimento não encontrado para este tenant");
        const locationId = recLocation.id;

        // 7. Persistir receivedQuantity em cada receivingOrderItem e criar inventory
        for (const item of allOrderItems) {
          const receivedQty = receivedByItem.get(item.id) || 0;
          const addressedQty = receivedQty; // sem NCG no agrupado (NCG é por NF individual)

          // Atualizar receivingOrderItem
          await tx.update(receivingOrderItems)
            .set({
              receivedQuantity: receivedQty,
              addressedQuantity: addressedQty,
              status: receivedQty > 0 ? "completed" : "pending",
              updatedAt: new Date(),
            })
            .where(eq(receivingOrderItems.id, item.id));

          if (addressedQty <= 0) continue;

          // Criar/atualizar inventory
          const uniqueCode = item.uniqueCode || "";
          const [existingInv] = await tx.select()
            .from(inventory)
            .where(
              and(
                eq(inventory.uniqueCode, uniqueCode),
                eq(inventory.tenantId, orderTenantId),
                eq(inventory.locationZone, "REC")
              )
            )
            .limit(1);

          if (existingInv) {
            await tx.update(inventory)
              .set({ quantity: sql`${inventory.quantity} + ${addressedQty}`, updatedAt: new Date() })
              .where(eq(inventory.id, existingInv.id));
          } else {
            await tx.insert(inventory).values({
              tenantId: orderTenantId,
              productId: item.productId,
              locationId,
              batch: item.batch || "",
              expiryDate: toDateStr(item.expiryDate) as any,
              uniqueCode,
              labelCode: item.labelCode || null,
              serialNumber: null,
              locationZone: "REC",
              quantity: addressedQty,
              reservedQuantity: 0,
              status: "available",
              createdAt: new Date(),
              updatedAt: new Date(),
            }).onDuplicateKeyUpdate({
              set: {
                quantity: sql`${inventory.quantity} + ${addressedQty}`,
                updatedAt: new Date(),
              },
            });
          }

          // Registrar movimento de recebimento
          await tx.insert(inventoryMovements).values({
            tenantId: orderTenantId,
            productId: item.productId,
            batch: item.batch || "",
            expiryDate: toDateStr(item.expiryDate) as any,
            uniqueCode,
            labelCode: item.labelCode || null,
            serialNumber: null,
            fromLocationId: null,
            toLocationId: locationId,
            quantity: addressedQty,
            movementType: "receiving",
            referenceType: "receiving_order",
            referenceId: item.receivingOrderId,
            performedBy: userId,
            notes: `Recebimento agrupado #${input.groupId} (${group.groupNumber})`,
            originalUnit: null,
            originalQty: null,
            conversionFactor: null,
            conversionSource: "none",
            createdAt: new Date(),
          });
        }

        // 8. Atualizar status de cada NF para "completed"
        await tx.update(receivingOrders)
          .set({ status: "completed", receivedDate: new Date(), updatedAt: new Date() })
          .where(inArray(receivingOrders.id, orderIds));

        // 9. Atualizar status do endereço REC
        await tx.update(warehouseLocations)
          .set({ status: "occupied", updatedAt: new Date() })
          .where(eq(warehouseLocations.id, locationId));

        // 10. Fechar grupo
        await tx.update(blindConferenceGroups)
          .set({ status: "completed", finishedAt: new Date(), finishedBy: userId })
          .where(eq(blindConferenceGroups.id, input.groupId));

        return {
          success: true,
          message: `Conferência agrupada finalizada. ${orderIds.length} NFs recebidas com sucesso.`,
          ordersCompleted: orderIds.length,
          itemsProcessed: allOrderItems.length,
        };
      });
    }),

  /**
   * 6. Cancelar Grupo (libera bloqueio das NFs)
   */
  cancelGroup: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group || group.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
      }

      // Buscar NFs do grupo
      const groupOrders = await db.select({ receivingOrderId: blindConferenceGroupOrders.receivingOrderId })
        .from(blindConferenceGroupOrders)
        .where(eq(blindConferenceGroupOrders.groupId, input.groupId));

      const orderIds = groupOrders.map(o => o.receivingOrderId);

      // Liberar NFs (status → scheduled)
      await db.update(receivingOrders)
        .set({ status: "scheduled", updatedAt: new Date() })
        .where(inArray(receivingOrders.id, orderIds));

      // Cancelar grupo
      await db.update(blindConferenceGroups)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(blindConferenceGroups.id, input.groupId));

      return {
        success: true,
        message: `Conferência agrupada cancelada. ${orderIds.length} NFs liberadas.`,
      };
    }),

  /**
   * 7b. Vincular Etiqueta Não Cadastrada ao Grupo
   * Cria a labelAssociation e registra a bipagem em blindConferenceGroupScans.
   * Equivalente ao associateLabel da conferência individual, mas para o contexto agrupado.
   */
  registerNewLabelInGroup: tenantProcedure
    .input(z.object({
      groupId: z.number(),
      labelCode: z.string().min(1),
      productId: z.number(),
      batch: z.string().nullable(),
      expiryDate: z.string().nullable(), // YYYY-MM-DD
      unitsPerBox: z.number().min(1),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;

      // Buscar grupo
      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(eq(blindConferenceGroups.id, input.groupId))
        .limit(1);

      if (!group || group.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo de conferência não está ativo." });
      }

      const orderTenantId = group.tenantId;

      // Verificar se a etiqueta já foi cadastrada (idempotência)
      // ⚠️ IMPORTANTE: labelCode tem constraint UNIQUE global (sem tenant).
      // Buscar por labelCode sem filtro de tenant para detectar duplicatas cross-tenant.
      const [existingLabel] = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      if (existingLabel) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Esta etiqueta já está cadastrada no sistema. Bipe novamente para registrar a bipagem.",
        });
      }

      // Buscar produto
      const [product] = await db.select()
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Produto não encontrado." });
      }

      // Gerar uniqueCode
      const uniqueCode = getUniqueCode(product.sku || String(product.id), input.batch || "");

      // Criar labelAssociation
      await db.insert(labelAssociations).values({
        labelCode: input.labelCode,
        uniqueCode,
        productId: input.productId,
        batch: input.batch || null,
        expiryDate: input.expiryDate as any,
        unitsPerBox: input.unitsPerBox,
        associatedBy: userId,
        associatedAt: new Date(),
        status: "AVAILABLE" as any,
        tenantId: orderTenantId,
      });

      // Atualizar unitsPerBox no produto se não existir
      if (!product.unitsPerBox) {
        await db.update(products)
          .set({ unitsPerBox: input.unitsPerBox })
          .where(eq(products.id, input.productId));
      }

      // Verificar se produto está nas NFs do grupo (para alerta de excesso)
      const groupOrders = await db.select({ receivingOrderId: blindConferenceGroupOrders.receivingOrderId })
        .from(blindConferenceGroupOrders)
        .where(eq(blindConferenceGroupOrders.groupId, input.groupId));

      const orderIds = groupOrders.map(o => o.receivingOrderId);

      const [matchingItems] = await db.select({
        totalExpected: sql<number>`SUM(${receivingOrderItems.expectedQuantity})`,
      })
        .from(receivingOrderItems)
        .where(
          and(
            inArray(receivingOrderItems.receivingOrderId, orderIds),
            eq(receivingOrderItems.productId, input.productId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        );

      const totalExpected = Number(matchingItems?.totalExpected) || 0;

      // Calcular total já bipado para este produto
      const [currentScans] = await db.select({
        totalUnitsRead: sql<number>`COALESCE(SUM(${blindConferenceGroupScans.unitsRead}), 0)`,
      })
        .from(blindConferenceGroupScans)
        .where(
          and(
            eq(blindConferenceGroupScans.groupId, input.groupId),
            eq(blindConferenceGroupScans.productId, input.productId),
            eq(blindConferenceGroupScans.isUndone, false)
          )
        );

      const currentTotal = Number(currentScans?.totalUnitsRead) || 0;
      const newTotal = currentTotal + input.unitsPerBox;
      const isExcess = newTotal > totalExpected && totalExpected > 0;

      // Registrar bipagem no grupo
      await db.insert(blindConferenceGroupScans).values({
        groupId: input.groupId,
        tenantId: orderTenantId,
        productId: input.productId,
        labelCode: input.labelCode,
        uniqueCode,
        batch: input.batch || null,
        expiryDate: input.expiryDate as any,
        unitsPerBox: input.unitsPerBox,
        unitsRead: input.unitsPerBox,
        scannedBy: userId,
        isUndone: false,
      });

      return {
        success: true,
        isExcess,
        association: {
          productId: input.productId,
          productName: product.description || "",
          productSku: product.sku || "",
          batch: input.batch,
          expiryDate: input.expiryDate,
          unitsPerBox: input.unitsPerBox,
          currentTotal: newTotal,
          totalExpected,
        },
        message: isExcess
          ? `⚠️ Quantidade excedente! Total bipado (${newTotal}) supera o esperado (${totalExpected}) para este SKU.`
          : `✅ ${product.description || "Produto"} vinculado | Lote: ${input.batch || "-"} | +${input.unitsPerBox} un. (Total: ${newTotal}/${totalExpected || "?"})`
      };
    }),

  /**
   * 7. Buscar Grupo Ativo do Tenant (para retomada)
   */
  getActiveGroup: tenantProcedure
    .input(z.object({
      tenantId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId } = ctx;

      const [group] = await db.select()
        .from(blindConferenceGroups)
        .where(
          and(
            eq(blindConferenceGroups.tenantId, effectiveTenantId),
            eq(blindConferenceGroups.status, "active")
          )
        )
        .orderBy(desc(blindConferenceGroups.id))
        .limit(1);

      if (!group) return { hasActiveGroup: false, group: null };

      const groupOrders = await db.select({
        receivingOrderId: blindConferenceGroupOrders.receivingOrderId,
        nfeNumber: receivingOrders.nfeNumber,
        orderNumber: receivingOrders.orderNumber,
      })
        .from(blindConferenceGroupOrders)
        .innerJoin(receivingOrders, eq(blindConferenceGroupOrders.receivingOrderId, receivingOrders.id))
        .where(eq(blindConferenceGroupOrders.groupId, group.id))
        .orderBy(blindConferenceGroupOrders.fifoOrder);

      return {
        hasActiveGroup: true,
        group: {
          id: group.id,
          groupNumber: group.groupNumber,
          startedAt: group.startedAt,
          orders: groupOrders,
        },
      };
    }),
});
