/**
 * Router de Manutenção e Jobs Automáticos
 *
 * Endpoints para executar tarefas de manutenção do sistema,
 * como sincronização de reservas, limpeza de dados órfãos, etc.
 */

import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { syncInventoryReservations } from "./syncReservations";
import { getDb } from "./db";
import {
  receivingOrders,
  receivingOrderItems,
  productConversions,
  unitPendingQueue,
  products,
} from "../drizzle/schema";
import { eq, and, inArray, ne } from "drizzle-orm";
import { applyConversion } from "./unitConversionRouter";

/**
 * Tabelas disponíveis para limpeza pelo Admin Global (tenantId === 1).
 * Cada entrada define o nome da tabela SQL e uma descrição legível.
 * ATENÇÃO: truncate é irreversível. Tabelas de configuração (users, products,
 * locations, tenants) são intencionalmente excluídas desta lista.
 */
export const CLEANABLE_TABLES = [
  { key: "inventory",              label: "Estoque (inventory)",                    sql: "inventory" },
  { key: "inventoryMovements",     label: "Movimentações de Estoque",               sql: "inventoryMovements" },
  { key: "labelAssociations",      label: "Associações de Etiqueta",                sql: "labelAssociations" },
  { key: "labelReadings",          label: "Leituras de Etiqueta",                   sql: "labelReadings" },
  { key: "blindConferenceSessions",label: "Sessões de Conferência Cega",            sql: "blindConferenceSessions" },
  { key: "blindConferenceItems",   label: "Itens de Conferência Cega",              sql: "blindConferenceItems" },
  { key: "blindConferenceAdjustments", label: "Ajustes de Conferência Cega",       sql: "blindConferenceAdjustments" },
  { key: "receivingOrders",        label: "Ordens de Recebimento",                  sql: "receivingOrders" },
  { key: "receivingOrderItems",    label: "Itens de Ordens de Recebimento",         sql: "receivingOrderItems" },
  { key: "receivingConferences",   label: "Conferências de Recebimento",            sql: "receivingConferences" },
  { key: "receivingDivergences",   label: "Divergências de Recebimento",            sql: "receivingDivergences" },
  { key: "receivingPreallocations",label: "Pré-Alocações de Recebimento",           sql: "receivingPreallocations" },
  { key: "nonConformities",        label: "Não-Conformidades (NCG)",                sql: "nonConformities" },
  { key: "divergenceApprovals",    label: "Aprovações de Divergência",              sql: "divergenceApprovals" },
  { key: "pickingOrders",          label: "Pedidos de Separação",                   sql: "pickingOrders" },
  { key: "pickingOrderItems",      label: "Itens de Pedidos de Separação",          sql: "pickingOrderItems" },
  { key: "pickingWaves",           label: "Ondas de Separação",                     sql: "pickingWaves" },
  { key: "pickingWaveItems",       label: "Itens de Ondas de Separação",            sql: "pickingWaveItems" },
  { key: "pickingAllocations",     label: "Alocações de Picking",                   sql: "pickingAllocations" },
  { key: "pickingAuditLogs",       label: "Logs de Auditoria de Picking",           sql: "pickingAuditLogs" },
  { key: "pickingProgress",        label: "Progresso de Picking",                   sql: "pickingProgress" },
  { key: "stageChecks",            label: "Conferências de Expedição (Stage)",      sql: "stageChecks" },
  { key: "stageCheckItems",        label: "Itens de Conferência de Expedição",      sql: "stageCheckItems" },
  { key: "shipments",              label: "Expedições (Shipments)",                 sql: "shipments" },
  { key: "shipmentManifests",      label: "Romaneios",                              sql: "shipmentManifests" },
  { key: "shipmentManifestItems",  label: "Itens de Romaneio",                      sql: "shipmentManifestItems" },
  { key: "invoices",               label: "Notas Fiscais (Invoices)",               sql: "invoices" },
  { key: "pickingInvoiceItems",    label: "Itens de NF de Picking",                 sql: "pickingInvoiceItems" },
  { key: "receivingInvoiceItems",  label: "Itens de NF de Recebimento",             sql: "receivingInvoiceItems" },
  { key: "auditLogs",              label: "Logs de Auditoria Geral",                sql: "auditLogs" },
  { key: "reportLogs",             label: "Logs de Relatórios",                     sql: "reportLogs" },
  { key: "labelPrintHistory",      label: "Histórico de Impressão de Etiquetas",   sql: "labelPrintHistory" },
  { key: "productLabels",          label: "Etiquetas de Produto",                   sql: "productLabels" },
  { key: "productLocationMapping", label: "Mapeamento Produto-Endereço",            sql: "productLocationMapping" },
  { key: "inventoryCounts",        label: "Contagens de Inventário",                sql: "inventoryCounts" },
  { key: "inventoryCountItems",    label: "Itens de Contagem de Inventário",        sql: "inventoryCountItems" },
  { key: "recalls",                label: "Recalls",                                sql: "recalls" },
  { key: "returns",                label: "Devoluções",                             sql: "returns" },
  { key: "clientPortalSessions",   label: "Sessões do Portal do Cliente",           sql: "clientPortalSessions" },
] as const;

export type CleanableTableKey = typeof CLEANABLE_TABLES[number]["key"];

export const maintenanceRouter = router({
  /**
   * Sincronizar reservas de estoque
   *
   * Recalcula reservedQuantity em todos os registros de estoque
   * baseado apenas em pedidos ativos. Corrige reservas órfãs.
   */
  syncReservations: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Apenas administradores podem executar sincronização de reservas");
      }
      console.log(`[maintenanceRouter] Sincronização de reservas iniciada por ${ctx.user.name} (${ctx.user.id})`);
      const result = await syncInventoryReservations();
      console.log(`[maintenanceRouter] Sincronização concluída: ${result.correctionsApplied} correções aplicadas`);
      return {
        success: true,
        message: `Sincronização concluída. ${result.correctionsApplied} correção(ões) aplicada(s) em ${result.totalProcessed} registro(s).`,
        totalProcessed: result.totalProcessed,
        correctionsApplied: result.correctionsApplied,
        corrections: result.corrections,
      };
    }),

  /**
   * Obter estatísticas de reservas
   *
   * Retorna informações sobre reservas de estoque para monitoramento
   */
  getReservationStats: protectedProcedure
    .query(async () => {
      const { getDb } = await import("./db");
      const { inventory, pickingOrders } = await import("../drizzle/schema");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [stats] = await db
        .select({
          totalInventoryRecords: sql<number>`COUNT(*)`,
          recordsWithReservation: sql<number>`SUM(CASE WHEN ${inventory.reservedQuantity} > 0 THEN 1 ELSE 0 END)`,
          totalReservedUnits: sql<number>`SUM(${inventory.reservedQuantity})`,
        })
        .from(inventory);

      const [orderStats] = await db
        .select({
          activePendingOrders: sql<number>`COUNT(DISTINCT CASE WHEN ${pickingOrders.status} = 'pending' THEN ${pickingOrders.id} END)`,
          activeInProgressOrders: sql<number>`COUNT(DISTINCT CASE WHEN ${pickingOrders.status} = 'in_progress' THEN ${pickingOrders.id} END)`,
          activeSeparatedOrders: sql<number>`COUNT(DISTINCT CASE WHEN ${pickingOrders.status} = 'separated' THEN ${pickingOrders.id} END)`,
          activeInWaveOrders: sql<number>`COUNT(DISTINCT CASE WHEN ${pickingOrders.status} = 'in_wave' THEN ${pickingOrders.id} END)`,
        })
        .from(pickingOrders)
        .where(sql`${pickingOrders.status} IN ('pending', 'in_progress', 'separated', 'in_wave')`);

      return {
        inventory: {
          totalRecords: stats.totalInventoryRecords,
          recordsWithReservation: stats.recordsWithReservation,
          totalReservedUnits: stats.totalReservedUnits,
        },
        orders: {
          pending: orderStats.activePendingOrders,
          inProgress: orderStats.activeInProgressOrders,
          separated: orderStats.activeSeparatedOrders,
          inWave: orderStats.activeInWaveOrders,
          total:
            orderStats.activePendingOrders +
            orderStats.activeInProgressOrders +
            orderStats.activeSeparatedOrders +
            orderStats.activeInWaveOrders,
        },
      };
    }),

  /**
   * Listar tabelas disponíveis para limpeza
   */
  listCleanableTables: protectedProcedure
    .query(({ ctx }) => {
      if (ctx.user.role !== "admin" || ctx.user.tenantId !== 1) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas o Admin Global (tenantId: 1) pode acessar esta função" });
      }
      return CLEANABLE_TABLES.map(t => ({ key: t.key, label: t.label }));
    }),

  /**
   * Truncar tabelas selecionadas
   *
   * Acesso restrito: role === 'admin' E tenantId === 1 (Global Admin Med@x).
   * As tabelas são truncadas em ordem segura (filhos antes de pais) para
   * evitar violações de FK. A operação é registrada no console para auditoria.
   *
   * dryRun = true  → apenas conta os registros, sem deletar
   * dryRun = false → executa o DELETE em cada tabela selecionada
   */
  truncateTables: protectedProcedure
    .input(
      z.object({
        tables: z.array(z.string()).min(1, "Selecione ao menos uma tabela"),
        dryRun: z.boolean().default(true),
        confirmPhrase: z.string().optional(), // deve ser "CONFIRMAR LIMPEZA" para dryRun=false
      })
    )
    .mutation(async ({ ctx, input }) => {
      // ── Verificação de acesso ──────────────────────────────────────────────
      if (ctx.user.role !== "admin" || ctx.user.tenantId !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Apenas o Admin Global (tenantId: 1) pode executar limpeza de tabelas",
        });
      }

      if (!input.dryRun && input.confirmPhrase !== "CONFIRMAR LIMPEZA") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Frase de confirmação incorreta. Digite exatamente: CONFIRMAR LIMPEZA",
        });
      }

      // ── Validar que todas as tabelas solicitadas estão na whitelist ────────
      const allowedKeys = new Set(CLEANABLE_TABLES.map(t => t.key));
      const invalidTables = input.tables.filter(t => !allowedKeys.has(t as CleanableTableKey));
      if (invalidTables.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Tabelas não permitidas: ${invalidTables.join(", ")}`,
        });
      }

      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // ── Ordenar tabelas para respeitar dependências FK (filhos primeiro) ───
      // A ordem na CLEANABLE_TABLES já está estruturada de forma segura;
      // mantemos a ordem de input mas priorizamos as tabelas filhas.
      const FK_ORDER: CleanableTableKey[] = [
        "clientPortalSessions", "reportLogs", "auditLogs",
        "pickingAuditLogs", "pickingProgress", "pickingAllocations",
        "pickingWaveItems", "pickingWaves", "stageCheckItems", "stageChecks",
        "shipmentManifestItems", "shipmentManifests", "shipments",
        "pickingInvoiceItems", "receivingInvoiceItems", "invoices",
        "pickingOrderItems", "pickingOrders",
        "blindConferenceAdjustments", "blindConferenceItems", "blindConferenceSessions",
        "divergenceApprovals", "nonConformities",
        "receivingDivergences", "receivingConferences", "receivingPreallocations",
        "receivingOrderItems", "receivingOrders",
        "labelReadings", "labelAssociations", "labelPrintHistory", "productLabels",
        "inventoryCountItems", "inventoryCounts",
        "inventoryMovements", "inventory",
        "productLocationMapping", "returns", "recalls",
      ];

      const orderedTables = [
        ...FK_ORDER.filter(k => input.tables.includes(k)),
        ...input.tables.filter(k => !FK_ORDER.includes(k as CleanableTableKey)),
      ];

      // ── Contar registros (dry-run ou pré-confirmação) ──────────────────────
      const counts: Record<string, number> = {};
      for (const key of orderedTables) {
        const tableInfo = CLEANABLE_TABLES.find(t => t.key === key)!;
        const [row] = await db.execute(sql.raw(`SELECT COUNT(*) as cnt FROM \`${tableInfo.sql}\``)) as unknown as [{ cnt: number }[]];
        counts[key] = Number(row[0]?.cnt ?? 0);
      }

      if (input.dryRun) {
        return {
          dryRun: true,
          tables: orderedTables.map(key => ({
            key,
            label: CLEANABLE_TABLES.find(t => t.key === key)!.label,
            recordCount: counts[key],
          })),
          totalRecords: Object.values(counts).reduce((a, b) => a + b, 0),
          deletedTotal: 0,
        };
      }

      // ── Executar limpeza ───────────────────────────────────────────────────
      const results: Array<{ key: string; label: string; deleted: number }> = [];
      let deletedTotal = 0;

      // Desabilitar FK checks temporariamente para truncate seguro
      await db.execute(sql.raw("SET FOREIGN_KEY_CHECKS = 0"));
      try {
        for (const key of orderedTables) {
          const tableInfo = CLEANABLE_TABLES.find(t => t.key === key)!;
          await db.execute(sql.raw(`DELETE FROM \`${tableInfo.sql}\``));
          const deleted = counts[key];
          results.push({ key, label: tableInfo.label, deleted });
          deletedTotal += deleted;
          console.log(
            `[maintenanceRouter] TRUNCATE ${tableInfo.sql}: ${deleted} registros removidos por ${ctx.user.name} (id=${ctx.user.id}, tenantId=${ctx.user.tenantId})`
          );
        }
      } finally {
        await db.execute(sql.raw("SET FOREIGN_KEY_CHECKS = 1"));
      }

      return {
        dryRun: false,
        tables: results,
        totalRecords: Object.values(counts).reduce((a, b) => a + b, 0),
        deletedTotal,
      };
    }),

  /**
   * Resumo do status dos endereços vs. inventory real
   *
   * Retorna quantos endereços estão com status 'occupied' mas sem inventory
   * com quantity > 0 (inconsistência), e quantos seriam corrigidos para 'available'.
   * Acesso restrito: role === 'admin'.
   */
  getLocationStatusSummary: protectedProcedure
    .input(
      z.object({
        tenantId: z.number().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas administradores podem acessar este relatório" });
      }

      const { getDb } = await import("./db");
      const { warehouseLocations, inventory } = await import("../drizzle/schema");
      const { sql, eq, and, gt, inArray } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const isGlobalAdmin = ctx.user.role === "admin";
      const effectiveTenantId = input.tenantId ?? (isGlobalAdmin ? null : ctx.user.tenantId);
      const tenantFilter = effectiveTenantId ? eq(warehouseLocations.tenantId, effectiveTenantId) : sql`1=1`;

      // Todos os endereços com status 'occupied'
      const occupiedLocations = await db
        .select({ id: warehouseLocations.id, code: warehouseLocations.code, tenantId: warehouseLocations.tenantId })
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.status, "occupied"), tenantFilter));

      if (occupiedLocations.length === 0) {
        return {
          totalOccupied: 0,
          inconsistentCount: 0,
          consistentCount: 0,
          inconsistentLocations: [],
        };
      }

      // Endereços que têm inventory com quantity > 0
      const occupiedIds = occupiedLocations.map(l => l.id);
      const locationsWithStock = await db
        .select({ locationId: inventory.locationId })
        .from(inventory)
        .where(and(inArray(inventory.locationId, occupiedIds), gt(inventory.quantity, 0)))
        .groupBy(inventory.locationId);

      const idsWithStock = new Set(locationsWithStock.map(r => r.locationId));

      // Inconsistentes: marcados como 'occupied' mas sem inventory real
      const inconsistent = occupiedLocations.filter(l => !idsWithStock.has(l.id));

      return {
        totalOccupied: occupiedLocations.length,
        inconsistentCount: inconsistent.length,
        consistentCount: occupiedLocations.length - inconsistent.length,
        inconsistentLocations: inconsistent.map(l => ({ id: l.id, code: l.code, tenantId: l.tenantId })),
      };
    }),

  /**
   * Sincronizar status dos endereços com o inventory real
   *
   * Atualiza warehouseLocations.status para 'available' em todos os endereços
   * que estão marcados como 'occupied' mas não possuem nenhum registro de
   * inventory com quantity > 0.
   *
   * dryRun = true  → apenas relatório, sem alterar
   * dryRun = false → executa a atualização
   *
   * Acesso restrito: role === 'admin'.
   */
  syncLocationStatus: protectedProcedure
    .input(
      z.object({
        dryRun: z.boolean().default(true),
        tenantId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Apenas administradores podem executar sincronização de status" });
      }

      const { getDb } = await import("./db");
      const { warehouseLocations, inventory } = await import("../drizzle/schema");
      const { sql, eq, and, gt, inArray } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const isGlobalAdmin = ctx.user.role === "admin";
      const effectiveTenantId = input.tenantId ?? (isGlobalAdmin ? null : ctx.user.tenantId);
      const tenantFilter = effectiveTenantId ? eq(warehouseLocations.tenantId, effectiveTenantId) : sql`1=1`;

      // Todos os endereços com status 'occupied'
      const occupiedLocations = await db
        .select({ id: warehouseLocations.id, code: warehouseLocations.code, tenantId: warehouseLocations.tenantId })
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.status, "occupied"), tenantFilter));

      if (occupiedLocations.length === 0) {
        return {
          dryRun: input.dryRun,
          totalOccupied: 0,
          updatedCount: 0,
          updatedLocations: [],
          message: "Nenhum endereço com status 'occupied' encontrado. Nada a sincronizar.",
        };
      }

      // Endereços que têm inventory com quantity > 0
      const occupiedIds = occupiedLocations.map(l => l.id);
      const locationsWithStock = await db
        .select({ locationId: inventory.locationId })
        .from(inventory)
        .where(and(inArray(inventory.locationId, occupiedIds), gt(inventory.quantity, 0)))
        .groupBy(inventory.locationId);

      const idsWithStock = new Set(locationsWithStock.map(r => r.locationId));

      // Inconsistentes: marcados como 'occupied' mas sem inventory real
      const toUpdate = occupiedLocations.filter(l => !idsWithStock.has(l.id));

      if (toUpdate.length === 0) {
        return {
          dryRun: input.dryRun,
          totalOccupied: occupiedLocations.length,
          updatedCount: 0,
          updatedLocations: [],
          message: "Todos os endereços 'occupied' possuem estoque real. Nenhuma correção necessária.",
        };
      }

      if (!input.dryRun) {
        const idsToUpdate = toUpdate.map(l => l.id);
        await db
          .update(warehouseLocations)
          .set({ status: "available" })
          .where(inArray(warehouseLocations.id, idsToUpdate));

        console.log(
          `[maintenanceRouter] syncLocationStatus: ${toUpdate.length} endereço(s) corrigidos para 'available' por ${ctx.user.name} (id=${ctx.user.id}, tenantId=${ctx.user.tenantId ?? 'global'})`
        );
      }

      return {
        dryRun: input.dryRun,
        totalOccupied: occupiedLocations.length,
        updatedCount: toUpdate.length,
        updatedLocations: toUpdate.map(l => ({ id: l.id, code: l.code, tenantId: l.tenantId })),
        message: input.dryRun
          ? `Prévia: ${toUpdate.length} endereço(s) seriam corrigidos para 'available'.`
          : `${toUpdate.length} endereço(s) corrigidos para 'available' com sucesso.`,
      };
    }),

  /**
   * Limpeza de registros órfãos de inventário
   *
   * Critérios de órfão:
   * 1. Zona NCG sem nonConformity correspondente (labelCode sem registro em nonConformities)
   * 2. Zona REC com quantity = 0 (resquício de tentativa falha de finish)
   * 3. locationId inexistente (endereço foi deletado)
   * 4. productId inexistente (produto foi deletado)
   *
   * dryRun = true  → apenas relatório, sem deletar
   * dryRun = false → executa a limpeza
   */
  cleanupOrphanInventory: protectedProcedure
    .input(
      z.object({
        dryRun: z.boolean().default(true),
        tenantId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("Apenas administradores podem executar limpeza de inventário");
      }

      const { getDb } = await import("./db");
      const { inventory, nonConformities, warehouseLocations, products } = await import("../drizzle/schema");
      const { sql, and, eq, notInArray, inArray } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      type OrphanRecord = {
        id: number;
        reason: string;
        labelCode: string | null;
        uniqueCode: string | null;
        locationZone: string | null;
        tenantId: number | null;
        quantity: number;
        createdAt: Date;
      };

      const orphans: OrphanRecord[] = [];
      const tenantFilter = input.tenantId ? eq(inventory.tenantId, input.tenantId) : sql`1=1`;

      // ── Critério 1: NCG sem nonConformity correspondente ──────────────────
      const ncgItems = await db
        .select({
          id: inventory.id,
          labelCode: inventory.labelCode,
          uniqueCode: inventory.uniqueCode,
          locationZone: inventory.locationZone,
          tenantId: inventory.tenantId,
          quantity: inventory.quantity,
          createdAt: inventory.createdAt,
        })
        .from(inventory)
        .where(and(eq(inventory.locationZone, "NCG"), tenantFilter));

      for (const item of ncgItems) {
        if (!item.labelCode) {
          orphans.push({ ...item, reason: "NCG sem labelCode (registro incompleto de tentativa falha)" });
          continue;
        }
        // Normalizar: remover sufixo -NCG para buscar o labelCode original
        const originalLabelCode = item.labelCode.replace(/-NCG$/, "");
        const ncgRecord = await db
          .select({ id: nonConformities.id })
          .from(nonConformities)
          .where(eq(nonConformities.labelCode, originalLabelCode))
          .limit(1);
        if (ncgRecord.length === 0) {
          orphans.push({
            ...item,
            reason: "NCG sem nonConformity correspondente (tentativa falha de finish)",
          });
        }
      }

      // ── Critério 2: quantity = 0 em qualquer zona ─────────────────────────
      // Inventory deve conter APENAS registros com saldo positivo.
      // Registros com quantity=0 são resíduos de operações que não executaram o DELETE.
      const zeroQtyItems = await db
        .select({
          id: inventory.id,
          labelCode: inventory.labelCode,
          uniqueCode: inventory.uniqueCode,
          locationZone: inventory.locationZone,
          tenantId: inventory.tenantId,
          quantity: inventory.quantity,
          createdAt: inventory.createdAt,
        })
        .from(inventory)
        .where(and(eq(inventory.quantity, 0), tenantFilter));

      for (const item of zeroQtyItems) {
        orphans.push({ ...item, reason: `quantity = 0 na zona ${item.locationZone ?? 'desconhecida'} (resíduo de operação sem DELETE)` });
      }

      // ── Critério 3: locationId inexistente ────────────────────────────────
      const allLocationIds = (
        await db.select({ id: warehouseLocations.id }).from(warehouseLocations)
      ).map((l) => l.id);

      if (allLocationIds.length > 0) {
        const invalidLocationItems = await db
          .select({
            id: inventory.id,
            labelCode: inventory.labelCode,
            uniqueCode: inventory.uniqueCode,
            locationZone: inventory.locationZone,
            tenantId: inventory.tenantId,
            quantity: inventory.quantity,
            createdAt: inventory.createdAt,
          })
          .from(inventory)
          .where(and(notInArray(inventory.locationId, allLocationIds), tenantFilter));

        for (const item of invalidLocationItems) {
          orphans.push({ ...item, reason: "locationId inexistente (endereço foi deletado)" });
        }
      }

      // ── Critério 4: productId inexistente ─────────────────────────────────
      const allProductIds = (
        await db.select({ id: products.id }).from(products)
      ).map((p) => p.id);

      if (allProductIds.length > 0) {
        const invalidProductItems = await db
          .select({
            id: inventory.id,
            labelCode: inventory.labelCode,
            uniqueCode: inventory.uniqueCode,
            locationZone: inventory.locationZone,
            tenantId: inventory.tenantId,
            quantity: inventory.quantity,
            createdAt: inventory.createdAt,
          })
          .from(inventory)
          .where(and(notInArray(inventory.productId, allProductIds), tenantFilter));

        for (const item of invalidProductItems) {
          orphans.push({ ...item, reason: "productId inexistente (produto foi deletado)" });
        }
      }

      // Deduplicar por id
      const uniqueOrphans = Array.from(new Map(orphans.map((o) => [o.id, o])).values());

      let deletedCount = 0;
      if (!input.dryRun && uniqueOrphans.length > 0) {
        const idsToDelete = uniqueOrphans.map((o) => o.id);
        await db.delete(inventory).where(inArray(inventory.id, idsToDelete));
        deletedCount = idsToDelete.length;
        console.log(
          `[maintenanceRouter] Limpeza de órfãos: ${deletedCount} registros removidos por ${ctx.user.name} (${ctx.user.id})`
        );
      }

      return {
        dryRun: input.dryRun,
        orphansFound: uniqueOrphans.length,
        deletedCount,
        orphans: uniqueOrphans.map((o) => ({
          id: o.id,
          reason: o.reason,
          labelCode: o.labelCode,
          uniqueCode: o.uniqueCode,
          locationZone: o.locationZone,
          tenantId: o.tenantId,
          quantity: o.quantity,
          createdAt: o.createdAt,
        })),
      };
    }),

  // ---------------------------------------------------------------------------
  // RECALCULAR expectedQuantity DE ITENS IMPORTADOS SEM FATOR DE CONVERSÃO
  // ---------------------------------------------------------------------------
  /**
   * Corrige itens de ordens de recebimento cujo expectedQuantity foi gravado
   * em unidades XML (ex: 1 CX) em vez de unidades base (ex: 6 UN), porque o
   * fator de conversão não estava cadastrado no momento da importação da NF-e.
   *
   * Critério de seleção: itens de ORs que já passaram por pending_unit_setup
   * (ou estão em in_progress/active) e cujo expectedQuantity parece não convertido
   * (heurística: existe fator de conversão para o produto E expectedQty < fator).
   *
   * dryRun=true: apenas lista os itens que seriam corrigidos (sem alterar o banco).
   */
  recalcExpectedQuantity: protectedProcedure
    .input(z.object({
      tenantId: z.number().optional(), // Filtrar por tenant (Global Admin pode omitir para todos)
      receivingOrderId: z.number().optional(), // Filtrar por OR específica
      dryRun: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const userTenantId = (ctx.user as any).tenantId as number;
      const isGlobalAdmin = userTenantId === 1;

      // Apenas Global Admin pode recalcular para todos os tenants
      const effectiveTenantId = input.tenantId ?? (isGlobalAdmin ? null : userTenantId);

      // 1. Buscar itens de ORs com status in_progress ou active (já desbloqueadas)
      //    que tenham receivedQuantity = 0 (ainda não conferidos)
      const orderConditions: ReturnType<typeof eq>[] = [];
      if (effectiveTenantId !== null) {
        orderConditions.push(eq(receivingOrders.tenantId, effectiveTenantId));
      }
      if (input.receivingOrderId) {
        orderConditions.push(eq(receivingOrders.id, input.receivingOrderId));
      }

      const orders = await db
        .select({ id: receivingOrders.id, tenantId: receivingOrders.tenantId, orderNumber: receivingOrders.orderNumber })
        .from(receivingOrders)
        .where(
          orderConditions.length === 0
            ? undefined
            : orderConditions.length === 1
              ? orderConditions[0]
              : and(...orderConditions)
        );

      if (orders.length === 0) return { dryRun: input.dryRun, corrections: [], totalFixed: 0 };

      const orderIds = orders.map((o) => o.id);
      const orderTenantMap = new Map(orders.map((o) => [o.id, o.tenantId]));
      const orderNumberMap = new Map(orders.map((o) => [o.id, o.orderNumber]));

      // 2. Buscar todos os itens dessas ORs com receivedQuantity = 0
      const items = await db
        .select({
          id: receivingOrderItems.id,
          receivingOrderId: receivingOrderItems.receivingOrderId,
          productId: receivingOrderItems.productId,
          expectedQuantity: receivingOrderItems.expectedQuantity,
          receivedQuantity: receivingOrderItems.receivedQuantity,
          tenantId: receivingOrderItems.tenantId,
        })
        .from(receivingOrderItems)
        .where(
          and(
            inArray(receivingOrderItems.receivingOrderId, orderIds),
            eq(receivingOrderItems.receivedQuantity, 0)
          )
        );

      if (items.length === 0) return { dryRun: input.dryRun, corrections: [], totalFixed: 0 };

      // 3. Para cada item, verificar se existe fator de conversão e se o expectedQty parece não convertido
      const corrections: Array<{
        itemId: number;
        receivingOrderId: number;
        orderNumber: string;
        productId: number;
        tenantId: number;
        currentExpected: number;
        recalculated: number;
        factor: number;
        unitCode: string;
      }> = [];

      for (const item of items) {
        const tenantId = orderTenantMap.get(item.receivingOrderId) ?? item.tenantId;

        // Buscar fatores de conversão para este produto neste tenant
        const convs = await db
          .select({
            unitCode: productConversions.unitCode,
            factorToBase: productConversions.factorToBase,
            roundingStrategy: productConversions.roundingStrategy,
          })
          .from(productConversions)
          .where(
            and(
              eq(productConversions.tenantId, tenantId),
              eq(productConversions.productId, item.productId)
            )
          );

        for (const conv of convs) {
          const factor = parseFloat(String(conv.factorToBase));
          if (factor <= 1) continue; // Fator 1 não muda nada

          const currentExpected = item.expectedQuantity || 0;
          if (currentExpected === 0) continue;

          // Heurística: se expectedQty é menor que o fator, provavelmente está em unidades XML
          // Ex: expectedQty=1, factor=6 → provavelmente 1 CX que deveria ser 6 UN
          if (currentExpected < factor) {
            const recalculated = applyConversion(currentExpected, factor, conv.roundingStrategy);
            if (recalculated !== currentExpected) {
              corrections.push({
                itemId: item.id,
                receivingOrderId: item.receivingOrderId,
                orderNumber: orderNumberMap.get(item.receivingOrderId) ?? "",
                productId: item.productId,
                tenantId,
                currentExpected,
                recalculated,
                factor,
                unitCode: conv.unitCode,
              });
              break; // Usar apenas o primeiro fator que se aplica
            }
          }
        }
      }

      let totalFixed = 0;
      if (!input.dryRun && corrections.length > 0) {
        for (const c of corrections) {
          await db
            .update(receivingOrderItems)
            .set({ expectedQuantity: c.recalculated, updatedAt: new Date() })
            .where(eq(receivingOrderItems.id, c.itemId));
          totalFixed++;
          console.log(
            `[maintenance] recalcExpectedQuantity: item #${c.itemId} OR ${c.orderNumber}: ${c.currentExpected} ${c.unitCode} → ${c.recalculated} UN (fator=${c.factor})`
          );
        }
      }

      return {
        dryRun: input.dryRun,
        corrections,
        totalFixed: input.dryRun ? 0 : totalFixed,
      };
    }),
});
