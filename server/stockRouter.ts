import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { warehouseLocations, products, inventory, labelAssociations } from "../drizzle/schema";
import { getDb } from "./db";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { tenantProcedure, assertSameTenant } from "./_core/tenantGuard";
import {
  getInventoryPositions,
  getInventorySummary,
  getLocationStock,
  getLowStockProducts,
  getExpiringProducts,
  getLocationsWithStock,
  getDestinationLocations,
  getSuggestedDestination,
  getInventoryPositionsAtDate,
} from "./inventory";
import {
  registerMovement,
  getMovementHistory,
  getLocationProducts,
} from "./movements";
import {
  getOccupancyByZone,
  getOverallOccupancy,
  getOptimizationSuggestions,
} from "./occupancy";

// Enum de status de endereços (inclui 'vacant' para endereços sem saldo)
const LOCATION_STATUS_VALUES = ["vacant", "available", "occupied", "blocked", "counting", "quarantine"] as const;
type LocationStatusValue = typeof LOCATION_STATUS_VALUES[number];

// Schema de validação para filtros de estoque
// Aceita string única OU array — compatível com MultiSelect do frontend
const inventoryFiltersSchema = z.object({
  tenantId: z.number().optional().nullable(),
  productId: z.number().optional(),
  locationId: z.number().optional(),
  zoneId: z.number().optional(),
  batch: z.string().optional(),
  status: z.preprocess(
    // Normaliza: string → array de 1 elemento; array → mantém
    (val) => (val === undefined || val === null ? undefined : Array.isArray(val) ? val : [val]),
    z.array(z.enum(LOCATION_STATUS_VALUES)).optional()
  ),
  minQuantity: z.number().optional(),
  search: z.string().optional(),
  locationCode: z.string().optional(),
});

// Schema de validação para movimentação
const registerMovementSchema = z.object({
  productId: z.number(),
  fromLocationId: z.number(),
  toLocationId: z.number().optional(), // Opcional para descarte
  quantity: z.number().positive(),
  batch: z.string().optional(),
  movementType: z.enum(["transfer", "adjustment", "return", "disposal", "quality"]),
  notes: z.string().optional(),
  tenantId: z.number().optional().nullable(),
  /** Quando true, indica que um admin autenticou a liberação de itens blocked/quarantine */
  adminReleaseAuthorized: z.boolean().optional(),
});

// Schema de validação para histórico de movimentações
const movementHistorySchema = z.object({
  productId: z.number().optional(),
  locationId: z.number().optional(),
  movementType: z.string().optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().optional(),
});

export const stockRouter = router({
  // ============================================================================
  // CONSULTAS DE ESTOQUE
  // ============================================================================

  /**
   * Obtém posições de estoque com filtros avançados
   */
  getPositions: tenantProcedure
    .input(inventoryFiltersSchema)
    .query(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      // Global Admin sem filtro de cliente explícito → sem filtro de tenant (visão global)
      // Global Admin com filtro de cliente → filtra pelo tenant selecionado
      // Não-admin → sempre filtra pelo próprio tenant
      const tenantId = isGlobalAdmin
        ? (input.tenantId !== undefined ? input.tenantId : undefined)
        : effectiveTenantId;
      return await getInventoryPositions({ ...input, tenantId });
    }),

  /**
   * Reconstrói posição de estoque em uma data de referência (snapshot histórico)
   */
  getPositionsAtDate: tenantProcedure
    .input(
      z.object({
        referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado: YYYY-MM-DD"),
        tenantId: z.number().optional().nullable(),
        search: z.string().optional(),
        zoneId: z.number().optional(),
        batch: z.string().optional(),
        locationCode: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin
        ? (input.tenantId !== undefined ? input.tenantId : undefined)
        : effectiveTenantId;
      const { referenceDate, ...filters } = input;
      return await getInventoryPositionsAtDate(referenceDate, { ...filters, tenantId });
    }),

  /**
   * Obtém resumo de estoque (cards de métricas)
   */
  getSummary: tenantProcedure
    .input(inventoryFiltersSchema)
    .query(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin
        ? (input.tenantId !== undefined ? input.tenantId : undefined)
        : effectiveTenantId;
      return await getInventorySummary({ ...input, tenantId });
    }),

  /**
   * Obtém saldo disponível em um endereço
   */
  getLocationStock: tenantProcedure
    .input(
      z.object({
        locationId: z.number(),
        productId: z.number().optional(),
        batch: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return await getLocationStock(
        input.locationId,
        input.productId,
        input.batch
      );
    }),

  /**
   * Obtém produtos com estoque abaixo do mínimo
   */
  getLowStock: tenantProcedure
    .input(z.object({ minQuantity: z.number().optional() }))
    .query(async ({ input }) => {
      return await getLowStockProducts(input.minQuantity);
    }),

  /**
   * Obtém produtos próximos do vencimento
   */
  getExpiring: tenantProcedure
    .input(z.object({ daysThreshold: z.number().optional() }))
    .query(async ({ input }) => {
      return await getExpiringProducts(input.daysThreshold);
    }),

  // ============================================================================
  // MOVIMENTAÇÕES DE ESTOQUE
  // ============================================================================

  /**
   * Registra movimentação de estoque
   */
  registerMovement: tenantProcedure
    .input(registerMovementSchema)
    .mutation(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      // Validar que o tenantId do input pertence ao tenant do usuário
      if (input.tenantId) {
        assertSameTenant(input.tenantId, effectiveTenantId, isGlobalAdmin, "movimentação de estoque");
      }
      // Para Global Admin: se input.tenantId foi fornecido, usar esse valor.
      // Se não foi fornecido, passar null para que a query de inventory
      // não filtre por tenantId (o Global Admin pode mover estoque de qualquer tenant).
      // Para usuários normais: usar effectiveTenantId (nunca null).
      const resolvedTenantId = isGlobalAdmin
        ? (input.tenantId ?? null)
        : effectiveTenantId;
      return await registerMovement({
        ...input,
        tenantId: resolvedTenantId,
        performedBy: ctx.user.id,
      });
    }),

  /**
   * Obtém histórico de movimentações
   */
  getMovements: tenantProcedure
    .input(movementHistorySchema)
    .query(async ({ input }) => {
      return await getMovementHistory(input);
    }),

  /**
   * Obtém produtos disponíveis em um endereço
   */
  getLocationProducts: tenantProcedure
    .input(z.object({ 
      locationId: z.number(),
      tenantId: z.number().optional().nullable(),
    }))
    .query(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? (input.tenantId ?? effectiveTenantId) : effectiveTenantId;
      return await getLocationProducts(input.locationId, tenantId);
    }),

  /**
   * Lista endereços que possuem estoque alocado
   */
  getLocationsWithStock: tenantProcedure
    .input(z.object({ 
      tenantId: z.number().optional().nullable(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? (input?.tenantId ?? effectiveTenantId) : effectiveTenantId;
      return await getLocationsWithStock(tenantId);
    }),

  /**
   * Lista endereços de destino válidos baseado no tipo de movimentação
   */
  getDestinationLocations: tenantProcedure
    .input(z.object({
      movementType: z.enum(["transfer", "adjustment", "return", "disposal", "quality"]),
      productId: z.number().optional(),
      batch: z.string().optional(),
      tenantId: z.number().optional().nullable(),
    }))
    .query(async ({ input }) => {
      return await getDestinationLocations(input);
    }),

  /**
   * Sugere endereço de destino baseado em pré-alocação (zona REC)
   */
  getSuggestedDestination: tenantProcedure
    .input(z.object({
      fromLocationId: z.number(),
      productId: z.number(),
      batch: z.string().nullable(),
      quantity: z.number(),
    }))
    .query(async ({ input }) => {
      return await getSuggestedDestination(input);
    }),

  // ============================================================================
  // DASHBOARD DE OCUPAÇÃO
  // ============================================================================

  /**
   * Obtém ocupação por zona
   */
  getOccupancyByZone: tenantProcedure.query(async () => {
    return await getOccupancyByZone();
  }),

  /**
   * Obtém ocupação geral do armazém
   */
  getOverallOccupancy: tenantProcedure.query(async () => {
    return await getOverallOccupancy();
  }),

  /**
   * Obtém sugestões de otimização
   */
  getOptimizationSuggestions: tenantProcedure.query(async () => {
    return await getOptimizationSuggestions();
  }),

  // ============================================================================
  // EXPORTAÇÃO
  // ============================================================================

  /**
   * Exporta estoque para Excel
   */
  exportToExcel: tenantProcedure
    .input(inventoryFiltersSchema)
    .mutation(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? (input.tenantId ?? effectiveTenantId) : effectiveTenantId;
      input = { ...input, tenantId };
      const ExcelJS = (await import('exceljs')).default;
      const positions = await getInventoryPositions(input);
      
      // Criar workbook e worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Estoque');
      
      // Definir colunas
      worksheet.columns = [
        { header: 'SKU', key: 'sku', width: 15 },
        { header: 'Produto', key: 'product', width: 40 },
        { header: 'Lote', key: 'batch', width: 15 },
        { header: 'Quantidade', key: 'quantity', width: 12 },
        { header: 'Unidade', key: 'unit', width: 10 },
        { header: 'Endereço', key: 'location', width: 15 },
        { header: 'Zona', key: 'zone', width: 10 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Validade', key: 'expiry', width: 12 },
      ];
      
      // Estilizar cabeçalho
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' },
      };
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      
      // Adicionar dados — filtrar linhas sem produto (endereços vazios do LEFT JOIN)
      const positionsWithProduct = positions.filter((pos: any) => pos.productId != null);
      positionsWithProduct.forEach((pos: any) => {
        worksheet.addRow({
          sku: pos.productSku,
          product: pos.productDescription,
          batch: pos.batch || 'N/A',
          quantity: pos.quantity,
          unit: 'UN',
          location: pos.locationCode,
          zone: pos.zoneName || 'N/A',
          status: pos.status === 'available' ? 'Disponível' : 
                  pos.status === 'quarantine' ? 'Quarentena/NCG' :
                  pos.status === 'blocked' ? 'Bloqueado' : 'Expirado',
          expiry: pos.expiryDate ? new Date(pos.expiryDate).toLocaleDateString('pt-BR') : 'N/A',
        });
      });
      
      // Gerar buffer
      const buffer = await workbook.xlsx.writeBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      return {
        success: true,
        filename: `estoque_${new Date().toISOString().split('T')[0]}.xlsx`,
        data: base64,
      };
    }),

  /**
   * Busca endereço por código
   */
  getLocationByCode: tenantProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ input }) => {
      const dbConn = await getDb();
      if (!dbConn) throw new Error("Database connection failed");

      // Sanitizar: remover tabs e espaços que o scanner físico pode inserir
      const sanitizedCode = input.code.trim();

      const location = await dbConn
        .select({
          id: warehouseLocations.id,
          code: warehouseLocations.code,
          tenantId: warehouseLocations.tenantId,
          status: warehouseLocations.status,
        })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.code, sanitizedCode))
        .limit(1);

      if (!location[0]) {
        throw new Error(`Endereço ${sanitizedCode} não encontrado`);
      }

      return location[0];
    }),

  /**
   * Busca produto por código de etiqueta e retorna dados do estoque no endereço de origem
   */
  getProductByCode: tenantProcedure
    .input(z.object({ 
      code: z.string(),
      locationCode: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const dbConn = await getDb();
      if (!dbConn) throw new Error("Database connection failed");

      const { effectiveTenantId, isGlobalAdmin } = ctx;

      // Sanitizar: remover tabs e espaços que o scanner físico pode inserir
      const sanitizedCode = input.code.trim();

      // Primeiro, tentar buscar por código de etiqueta (labelAssociations)
      // Filtrar por tenantId para evitar retornar etiquetas de outros tenants com mesmo código
      const labelAssoc = await dbConn
        .select({
          productId: labelAssociations.productId,
          batch: labelAssociations.batch,
          expiryDate: labelAssociations.expiryDate,
          unitsPerBox: labelAssociations.unitsPerBox,
        })
        .from(labelAssociations)
        // labelAssociations é global: buscar apenas por labelCode, sem filtro de tenant
        .where(eq(labelAssociations.labelCode, sanitizedCode))
        .limit(1);

      let productId: number;
      let labelBatch: string | null = null;
      let labelUnitsPerBox: number | null = null;

      if (labelAssoc[0]) {
        // Etiqueta encontrada - usar productId da associação
        productId = labelAssoc[0].productId;
        labelBatch = labelAssoc[0].batch || null;
        labelUnitsPerBox = labelAssoc[0].unitsPerBox;
      } else {
        // Etiqueta não encontrada — tentar buscar diretamente por SKU (fallback)
        // ✅ FILTRO DE TENANT CRÍTICO: garantir que o produto retornado pertence ao tenant correto
        // Sem esse filtro, SKUs duplicados entre tenants retornam o produto errado,
        // causando "Saldo insuficiente" porque o productId não corresponde ao inventory.
        const productBySku = await dbConn
          .select({ id: products.id })
          .from(products)
          .where(
            eq(products.sku, sanitizedCode)
          )
          .limit(1);

        if (!productBySku[0]) {
          throw new Error(`Etiqueta ou produto ${sanitizedCode} não encontrado`);
        }

        productId = productBySku[0].id;
      }

      // Buscar dados do produto
      const product = await dbConn
        .select({
          id: products.id,
          sku: products.sku,
          description: products.description,
          unitsPerBox: products.unitsPerBox,
        })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);

      if (!product[0]) {
        throw new Error(`Produto não encontrado`);
      }

      // Se locationCode fornecido, buscar dados do estoque nesse endereço
      let stockData = null;
      if (input.locationCode) {
        const location = await dbConn
          .select({ id: warehouseLocations.id })
          .from(warehouseLocations)
          .where(eq(warehouseLocations.code, input.locationCode))
          .limit(1);

        if (location[0]) {
          const stock = await dbConn
            .select({
              batch: inventory.batch,
              quantity: inventory.quantity,
              reservedQuantity: inventory.reservedQuantity,
              expiryDate: inventory.expiryDate,
            })
            .from(inventory)
            .where(
              and(
                eq(inventory.productId, product[0].id),
                eq(inventory.locationId, location[0].id),
                // ✅ CORREÇÃO DE ESCOPO: Filtrar apenas saldo 'available' para não retornar
                // registros quarantine do mesmo endereço (ex: zona REC com saldo NCG)
                eq(inventory.status, 'available')
              )
            )
            .limit(1);

          if (stock[0]) {
            stockData = stock[0];
          }
        }
      }

      // Priorizar unitsPerBox da etiqueta, depois do produto
      const finalUnitsPerBox = labelUnitsPerBox || product[0].unitsPerBox || 1;

      // Priorizar batch da etiqueta, depois do estoque
      const finalBatch = labelBatch || stockData?.batch || null;

      const availableQuantity = stockData 
        ? (stockData.quantity - (stockData.reservedQuantity ?? 0))
        : 0;

      return {
        ...product[0],
        unitsPerBox: finalUnitsPerBox,
        batch: finalBatch,
        availableQuantity,
        expiryDate: stockData?.expiryDate || null,
      };
    }),
});
