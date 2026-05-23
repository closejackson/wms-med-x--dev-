/**
 * collectorPickingRouter.ts
 * Endpoints exclusivos do /collector/picking — fluxo guiado por endereço com
 * validação de lote pré-alocado e suporte a pausa/retomada.
 *
 * NÃO altera lógica de movimentação de estoque (responsabilidade de outro módulo).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { protectedProcedure, router } from "./_core/trpc";
import { tenantProcedure, assertSameTenant } from "./_core/tenantGuard";
import { getDb } from "./db";
import { getUniqueCode } from "./utils/uniqueCode";
import { toMySQLDate } from "../shared/utils";
import {
  pickingOrders,
  pickingAllocations,
  pickingProgress,
  pickingWaves,
  warehouseLocations,
  products,
  tenants,
  labelAssociations,
  inventory,
  pickingOrderItems,
  pickingWaveItems,
} from "../drizzle/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retorna o progresso salvo ou cria um novo registro zerado */
async function ensureProgress(
  db: Awaited<ReturnType<typeof getDb>>,
  pickingOrderId: number
) {
  if (!db) throw new Error("DB unavailable");

  const [existing] = await db
    .select()
    .from(pickingProgress)
    .where(eq(pickingProgress.pickingOrderId, pickingOrderId))
    .limit(1);

  if (existing) return existing;

  await db.insert(pickingProgress).values({
    pickingOrderId,
    currentSequence: 1,
    currentLocationId: null,
    scannedItems: [],
  });

  const [created] = await db
    .select()
    .from(pickingProgress)
    .where(eq(pickingProgress.pickingOrderId, pickingOrderId))
    .limit(1);

  return created;
}

/** Busca todas as alocações de um pedido agrupadas por endereço, em ordem de sequence */
async function buildRoute(
  db: Awaited<ReturnType<typeof getDb>>,
  pickingOrderId: number
) {
  if (!db) throw new Error("DB unavailable");

  const allocs = await db
    .select({
      id: pickingAllocations.id,
      pickingOrderId: pickingAllocations.pickingOrderId, // ✅ Adicionar pickingOrderId
      locationId: pickingAllocations.locationId,
      locationCode: pickingAllocations.locationCode,
      productId: pickingAllocations.productId,
      productSku: pickingAllocations.productSku,
      batch: pickingAllocations.batch,
      expiryDate: pickingAllocations.expiryDate,
      uniqueCode: (pickingAllocations as any).uniqueCode, // ✅ Incluir uniqueCode
      quantity: pickingAllocations.quantity,
      pickedQuantity: pickingAllocations.pickedQuantity,
      isFractional: pickingAllocations.isFractional,
      sequence: pickingAllocations.sequence,
      status: pickingAllocations.status,
    })
    .from(pickingAllocations)
    .where(eq(pickingAllocations.pickingOrderId, pickingOrderId))
    .orderBy(asc(pickingAllocations.sequence));

  // Coletar IDs únicos de produtos para enriquecer com nome
  const productIds = Array.from(new Set(allocs.map((a) => a.productId)));

  // Build map — CORREÇÃO BUG N+1: era 1 query por produto, agora é 1 query total
  const productMap: Record<number, string> = {};
  if (productIds.length > 0) {
    const prodRows = await db
      .select({ id: products.id, description: products.description })
      .from(products)
      .where(sql`${products.id} IN (${sql.join(productIds.map(id => sql`${id}`), sql`, `)})`);
    for (const p of prodRows) {
      productMap[p.id] = p.description ?? p.id.toString();
    }
  }

  // Agrupar por locationCode mantendo a menor sequence do grupo
  const grouped: Record<
    string,
    {
      locationId: number;
      locationCode: string;
      sequence: number;
      hasFractional: boolean;
      allDone: boolean;
      items: Array<{
        allocationId: number;
        pickingOrderId: number; // ✅ Adicionar pickingOrderId
        productId: number;
        productSku: string;
        productName: string;
        batch: string | null;
        expiryDate: string | null;
        quantity: number;
        pickedQuantity: number;
        isFractional: boolean;
        status: string;
      }>;
    }
  > = {};

  for (const a of allocs) {
    if (!grouped[a.locationCode]) {
      grouped[a.locationCode] = {
        locationId: a.locationId,
        locationCode: a.locationCode,
        sequence: a.sequence,
        hasFractional: false,
        allDone: true,
        items: [],
      };
    }
    const g = grouped[a.locationCode];
    if (a.sequence < g.sequence) g.sequence = a.sequence;
    if (a.isFractional) g.hasFractional = true;
    if (a.status !== "picked") g.allDone = false;

    g.items.push({
      allocationId: a.id,
      pickingOrderId: a.pickingOrderId, // ✅ Adicionar pickingOrderId
      productId: a.productId,
      productSku: a.productSku,
      productName: productMap[a.productId] ?? a.productSku,
      batch: a.batch ?? null,
      expiryDate: a.expiryDate ? String(a.expiryDate) : null,
      quantity: a.quantity,
      pickedQuantity: a.pickedQuantity,
      isFractional: a.isFractional,
      status: a.status,
    });
  }

  const route = Object.values(grouped).sort((a, b) => a.sequence - b.sequence);
  return route;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const collectorPickingRouter = router({
  /**
   * Listar pedidos disponíveis para picking no coletor
   * Retorna pedidos com status "pending" ou "paused" do tenant do operador
   */
  listOrders: tenantProcedure
    .input(
      z.object({
        tenantId: z.number().optional(), // Admin pode filtrar por tenant
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      const { effectiveTenantId, isGlobalAdmin } = ctx;

      const statusFilter = sql`${pickingWaves.status} IN ('pending', 'picking')`;

      const rows = await db
        .select({
          id: pickingWaves.id,
          waveNumber: pickingWaves.waveNumber,
          status: pickingWaves.status,
          totalOrders: pickingWaves.totalOrders,
          totalItems: pickingWaves.totalItems,
          tenantId: pickingWaves.tenantId,
          createdAt: pickingWaves.createdAt,
        })
        .from(pickingWaves)
        .where(
          isGlobalAdmin
            ? statusFilter
            : and(eq(pickingWaves.tenantId, effectiveTenantId), statusFilter)
        )
        .orderBy(asc(pickingWaves.createdAt));

      return rows;
    }),

  /**
   * Iniciar (ou retomar) picking de um pedido
   * - Se não existirem alocações, gera-as agora (chama generatePickingAllocations)
   * - Retorna a rota completa + progresso salvo
   */
  startOrResume: tenantProcedure
    .input(z.object({ waveId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // Validar onda
      const [wave] = await db
        .select()
        .from(pickingWaves)
        .where(eq(pickingWaves.id, input.waveId))
        .limit(1);

      if (!wave) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Onda não encontrada",
        });
      }

      if (!['pending', 'in_progress', 'picking'].includes(wave.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Onda não pode ser iniciada (status: ${wave.status})`,
        });
      }

      // Buscar pedidos da onda
      const waveOrders = await db
        .select()
        .from(pickingOrders)
        .where(eq(pickingOrders.waveId, input.waveId));

      if (waveOrders.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Nenhum pedido encontrado na onda",
        });
      }

      // Validar isolamento de tenant (assertSameTenant lança FORBIDDEN se cross-tenant)
      const firstOrder = waveOrders[0];
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      assertSameTenant(firstOrder.tenantId, effectiveTenantId, isGlobalAdmin, "onda de picking");

      // Validar que todos os produtos da onda têm unitsPerBox cadastrado
      const waveOrderIds = waveOrders.map((o) => o.id);
      const waveOrderItems = await db
        .select({
          productId: pickingOrderItems.productId,
          productSku: products.sku,
          productDescription: products.description,
          unitsPerBox: products.unitsPerBox,
        })
        .from(pickingOrderItems)
        .leftJoin(products, eq(pickingOrderItems.productId, products.id))
        .where(inArray(pickingOrderItems.pickingOrderId, waveOrderIds));

      const productsWithoutUPB = waveOrderItems.filter(
        (item) => !item.unitsPerBox || item.unitsPerBox <= 0
      );

      if (productsWithoutUPB.length > 0) {
        const uniqueProds = Array.from(
          new Map(productsWithoutUPB.map((p) => [p.productId, p])).values()
        );
        const productList = uniqueProds
          .map((p) => `${p.productSku ?? `ID:${p.productId}`} — ${p.productDescription ?? "Produto sem descrição"}`)
          .join("; ");
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Não é possível iniciar o picking: os seguintes produtos não possuem "Unidades por Caixa" cadastrado: ${productList}. Acesse o cadastro de produtos e preencha este campo antes de continuar.`,
        });
      }

      // Gerar alocações para todos os pedidos da onda (se necessário)
      const { generatePickingAllocations } = await import(
        "./pickingAllocation"
      );
      
      for (const order of waveOrders) {
        const existingAllocs = await db
          .select({ id: pickingAllocations.id })
          .from(pickingAllocations)
          .where(eq(pickingAllocations.pickingOrderId, order.id))
          .limit(1);

        if (existingAllocs.length === 0) {
          const result = await generatePickingAllocations({
            pickingOrderId: order.id,
            tenantId: order.tenantId,
          });

          if (!result.success) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: result.message ?? `Falha ao gerar alocações para pedido ${order.orderNumber}`,
            });
          }
        }
      }

      // Atualizar status da onda para picking
      if (wave.status === "pending") {
        await db
          .update(pickingWaves)
          .set({ status: "picking" })
          .where(eq(pickingWaves.id, input.waveId));
      }

      // Atualizar status dos pedidos para in_progress
      await db
        .update(pickingOrders)
        .set({ status: "in_progress" })
        .where(eq(pickingOrders.waveId, input.waveId));

      // Construir rota consolidada usando buildRoute para cada pedido
      // e depois mesclar por endereço
      const allRoutes: any[] = [];
      for (const order of waveOrders) {
        const orderRoute = await buildRoute(db, order.id);
        allRoutes.push(...orderRoute);
      }

      // Mesclar rotas por locationCode e consolidar itens duplicados por [SKU + Lote + Endereço]
      // Cenário: onda com múltiplos pedidos com o mesmo SKU+Lote no mesmo endereço
      const routeMap = new Map<string, any>();
      for (const loc of allRoutes) {
        if (!routeMap.has(loc.locationCode)) {
          routeMap.set(loc.locationCode, {
            locationId: loc.locationId,
            locationCode: loc.locationCode,
            sequence: loc.sequence,
            hasFractional: loc.hasFractional,
            allDone: loc.allDone,
            items: [],
          });
        }
        const merged = routeMap.get(loc.locationCode)!;
        if (loc.hasFractional) merged.hasFractional = true;
        if (!loc.allDone) merged.allDone = false;
        if (loc.sequence < merged.sequence) merged.sequence = loc.sequence;

        // Consolidar itens por [productId + batch]: somar quantidades em vez de duplicar linhas
        for (const item of loc.items) {
          const consolidationKey = `${item.productId}:${item.batch ?? ''}:${item.status}`;
          const existing = merged.items.find(
            (i: any) => `${i.productId}:${i.batch ?? ''}:${i.status}` === consolidationKey
          );
          if (existing && item.status !== 'picked' && item.status !== 'short_picked') {
            // Mesmo SKU+Lote pendente no mesmo endereço: somar quantidades
            existing.quantity += item.quantity;
            existing.pickedQuantity += item.pickedQuantity;
            // Manter o allocationId do primeiro item (será usado para registrar a bipagem)
          } else {
            merged.items.push({ ...item });
          }
        }
      }

      const route = Array.from(routeMap.values()).sort((a, b) => a.sequence - b.sequence);

      return {
        wave: {
          id: wave.id,
          waveNumber: wave.waveNumber,
          status: "picking",
        },
        route,
        progress: {
          currentSequence: 0,
          scannedItems: [],
        },
        isResume: false,
      };
    }),

  /**
   * Confirmar leitura de endereço
   * Verifica se o endereço bipado corresponde ao endereço esperado na rota
   */
  confirmLocation: tenantProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        expectedLocationCode: z.string(),
        scannedLocationCode: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const normalized = input.scannedLocationCode.trim().toUpperCase();
      const expected = input.expectedLocationCode.trim().toUpperCase();

      if (normalized !== expected) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Endereço incorreto. Esperado: ${expected} — Lido: ${normalized}`,
        });
      }

      return { ok: true, locationCode: expected };
    }),

  /**
   * Bipar produto em um endereço
   * Valida produto + lote contra a alocação pré-definida.
   * Retorna informações sobre fracionamento quando aplicável.
   *
   * O código bipado pode ser:
   *   - labelCode de uma labelAssociation (contém batch embutido)
   *   - SKU simples
   */
  scanProduct: protectedProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        allocationId: z.number(), // ID da alocação específica do item
        scannedCode: z.string(), // Código bipado pelo operador
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // Buscar tenantId do PEDIDO (não do usuário logado)
      // Isso garante que labelAssociations criadas on-the-fly tenham o tenant correto
      // mesmo quando o operador é um admin global (tenantId=null ou tenantId=1)
      const [orderForTenant] = await db
        .select({ tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.pickingOrderId))
        .limit(1);
      const tenantId = orderForTenant?.tenantId ?? ctx.user?.tenantId;
      if (!tenantId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Tenant ID not found in session or order",
        });
      }

      // Buscar alocação
      console.log(`[scanProduct] Buscando alocação: allocationId=${input.allocationId}, pickingOrderId=${input.pickingOrderId}`);
      
      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, input.allocationId))
        .limit(1);

      console.log(`[scanProduct] Alocação encontrada:`, alloc ? `id=${alloc.id}, pickingOrderId=${alloc.pickingOrderId}, productSku=${alloc.productSku}, batch=${alloc.batch}, uniqueCode=${alloc.uniqueCode}` : 'null');

      if (!alloc || alloc.pickingOrderId !== input.pickingOrderId) {
        console.error(`[scanProduct] ERRO: Alocação não encontrada ou pickingOrderId não corresponde. alloc=${!!alloc}, pickingOrderId match=${alloc?.pickingOrderId === input.pickingOrderId}`);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Alocação não encontrada",
        });
      }

      if (alloc.status === "picked") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Item já foi separado completamente",
        });
      }

      // Buscar associação de etiqueta para extrair lote do código bipado
      const { labelAssociations } = await import("../drizzle/schema");
      const [labelAssoc] = await db
        .select({
          productId: labelAssociations.productId,
          batch: labelAssociations.batch,
          labelCode: labelAssociations.labelCode,
        })
        .from(labelAssociations)
        .where(
          and(
            eq(labelAssociations.labelCode, input.scannedCode),
            eq(labelAssociations.productId, alloc.productId),
            alloc.batch ? eq(labelAssociations.batch, alloc.batch) : sql`1=1`
          )
        )
        .limit(1);

      // Determinar productId e batch do código lido
      let scannedProductId: number | null = null;
      let scannedBatch: string | null = null;

      if (labelAssoc) {
        scannedProductId = labelAssoc.productId;
        scannedBatch = labelAssoc.batch ?? null;
      } else {
        // Tentar por SKU direto
        const [prod] = await db
          .select({ id: products.id, sku: products.sku })
          .from(products)
          .where(eq(products.sku, input.scannedCode))
          .limit(1);

        if (prod) {
          scannedProductId = prod.id;
          // Sem lote no código — se alocação exige lote, vai falhar na validação
          scannedBatch = null;
        }
      }

      // Se o código não é reconhecido em labelAssociations nem como SKU direto,
      // rejeitar — não aceitar etiquetas desconhecidas como válidas.
      if (scannedProductId === null) {
        const [expectedProd] = await db
          .select({ sku: products.sku, description: products.description })
          .from(products)
          .where(eq(products.id, alloc.productId))
          .limit(1);

        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Etiqueta não reconhecida. Esperado produto: ${expectedProd?.sku ?? alloc.productSku} — Código lido: ${input.scannedCode}`,
        });
      }

      // Validar produto
      if (scannedProductId !== alloc.productId) {
        const [expectedProd] = await db
          .select({ sku: products.sku, description: products.description })
          .from(products)
          .where(eq(products.id, alloc.productId))
          .limit(1);

        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Produto incorreto. Esperado: ${expectedProd?.sku ?? alloc.productSku} — Lido: ${input.scannedCode}`,
        });
      }

      // Validar lote — se a alocação definiu um lote, o lote bipado deve corresponder
      if (alloc.batch !== null && alloc.batch !== undefined) {
        if (scannedBatch === null) {
          // CORREÇÃO: Vincular etiqueta automaticamente ao item-lote
          const { labelAssociations, inventory } = await import("../drizzle/schema");
          
          // Buscar inventário para obter tenantId e expiryDate
          const [inv] = await db
            .select({
              tenantId: inventory.tenantId,
              expiryDate: inventory.expiryDate,
            })
            .from(inventory)
            .where(
              and(
                eq(inventory.productId, alloc.productId),
                eq(inventory.locationId, alloc.locationId),
                alloc.batch ? eq(inventory.batch, alloc.batch) : sql`1=1`
              )
            )
            .limit(1);

          if (!inv) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Estoque não encontrado para vincular etiqueta.`,
            });
          }

          // Criar nova labelAssociation (apenas se ainda não existir)
          // ⚠️ labelCode tem constraint UNIQUE global — verificar sem filtro de tenant
          const [existingLabelForPicking] = await db
            .select({ id: labelAssociations.id })
            .from(labelAssociations)
            .where(eq(labelAssociations.labelCode, input.scannedCode))
            .limit(1);

          if (!existingLabelForPicking) {
            // unitsPerBox = 0 indica "fator pendente" — será solicitado ao operador na próxima etapa
            await db.insert(labelAssociations).values({
              labelCode: input.scannedCode,
              productId: alloc.productId,
              batch: alloc.batch ?? null,
              expiryDate: toMySQLDate(inv.expiryDate ? new Date(String(inv.expiryDate)) : null) as any,
              unitsPerBox: 0, // 0 = fator pendente, será definido pelo operador via modal UOM
              associatedBy: 0, // Sistema (userId 0)
              tenantId: tenantId,
              uniqueCode: getUniqueCode(alloc.productSku || "", alloc.batch || ""),
              associatedAt: new Date(),
              status: 'AVAILABLE' as any,
            });
          }

          // Atualizar scannedBatch para continuar fluxo
          scannedBatch = alloc.batch;
        } else if (scannedBatch !== alloc.batch) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Lote incorreto. Esperado: ${alloc.batch} — Lido: ${scannedBatch}`,
          });
        }
      }

      // Buscar produto para descrição e unitsPerBox (fallback)
      const [product] = await db
        .select({ unitsPerBox: products.unitsPerBox, sku: products.sku, description: products.description })
        .from(products)
        .where(eq(products.id, alloc.productId))
        .limit(1);

      // 🔑 PRIORIDADE UOM: 1º labelAssociations.unitsPerBox (etiqueta bipada)
      //                   2º products.unitsPerBox (cadastro do produto)
      //                   3º Solicitar ao operador (requiresUomInput)
      const { labelAssociations: labelAssocSchema } = await import("../drizzle/schema");
      const [labelAssocForUom] = await db
        .select({ unitsPerBox: labelAssocSchema.unitsPerBox })
        .from(labelAssocSchema)
        .where(
          and(
            eq(labelAssocSchema.labelCode, input.scannedCode),
            eq(labelAssocSchema.productId, alloc.productId)
          )
        )
        .limit(1);

      // Determinar fator de conversão: etiqueta > produto > solicitar
      const labelUom = labelAssocForUom?.unitsPerBox ?? 0;
      const productUom = product?.unitsPerBox ?? 0;
      const resolvedUom = labelUom > 0 ? labelUom : productUom;

      // ⚠️ BLOQUEIO UOM: Se nenhum fator encontrado, solicitar ao operador
      if (resolvedUom <= 0) {
        return {
          ok: true,
          requiresUomInput: true,
          allocationId: alloc.id,
          productId: alloc.productId,
          productSku: product?.sku ?? alloc.productSku,
          productName: product?.description ?? alloc.productSku,
          scannedCode: input.scannedCode,
          batch: alloc.batch ?? null,
          message: `Unidade de medida não identificada para "${input.scannedCode}". Informe a quantidade de unidades contidas nesta embalagem.`,
        };
      }

      const unitsPerBox = resolvedUom;
      const uomSource = labelUom > 0 ? "label" : "product"; // Para log/debug
      const remaining = alloc.quantity - alloc.pickedQuantity;

      // Verificar se é fracionado
      if (alloc.isFractional && remaining < unitsPerBox) {
        // Retornar flag para o frontend solicitar entrada manual da quantidade
        return {
          ok: true,
          requiresManualQuantity: true,
          maxQuantity: remaining,
          unitsPerBox,
          message: `Item fracionado. Informe a quantidade exata a separar (máx: ${remaining}).`,
        };
      }

      // Item inteiro — verificar se quantidade excede saldo
      // Em vez de bloquear, solicitar confirmação de caixa fracionada
      if (unitsPerBox > remaining) {
        return {
          ok: true,
          requiresFractionConfirm: true,
          allocationId: alloc.id,
          productId: alloc.productId,
          productSku: product?.sku ?? alloc.productSku,
          productName: product?.description ?? alloc.productSku,
          scannedCode: input.scannedCode,
          batch: alloc.batch ?? null,
          unitsPerBox,
          maxQuantity: remaining,
          message: `Esta embalagem contém ${unitsPerBox} un, mas o saldo restante é ${remaining} un. Trata-se de uma caixa fracionada?`,
        };
      }

      // 🔄 INCREMENTO ATÔMICO: Usar SQL para evitar race conditions
      const quantityToAdd = Math.min(unitsPerBox, remaining);
      
      // Atualizar com incremento atômico SQL
      await db
        .update(pickingAllocations)
        .set({ 
          pickedQuantity: sql`${pickingAllocations.pickedQuantity} + ${quantityToAdd}`,
          status: sql`CASE WHEN ${pickingAllocations.pickedQuantity} + ${quantityToAdd} >= ${pickingAllocations.quantity} THEN 'picked' ELSE 'in_progress' END`
        })
        .where(eq(pickingAllocations.id, alloc.id));
      
      // Buscar estado atualizado após incremento
      const [updatedAlloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, alloc.id))
        .limit(1);
      
      const newPickedQuantity = updatedAlloc.pickedQuantity;
      const newStatus = updatedAlloc.status;

      // ✅ SINCRONIZAÇÃO CRUZADA: Incremento atômico em pickingWaveItems e pickingOrderItems
      {
        const { pickingOrderItems, pickingWaveItems } = await import("../drizzle/schema");
        
        // 🔄 Atualizar pickingWaveItems com incremento atômico
        if (alloc.waveId) {
          await db
            .update(pickingWaveItems)
            .set({
              pickedQuantity: sql`${pickingWaveItems.pickedQuantity} + ${quantityToAdd}`,
              status: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} + ${quantityToAdd} >= ${pickingWaveItems.totalQuantity} THEN 'picked' ELSE 'picking' END`,
              pickedAt: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} + ${quantityToAdd} >= ${pickingWaveItems.totalQuantity} THEN NOW() ELSE ${pickingWaveItems.pickedAt} END`,
            })
            .where(
              and(
                eq(pickingWaveItems.waveId, alloc.waveId),
                eq(pickingWaveItems.productId, alloc.productId),
                alloc.batch ? eq(pickingWaveItems.batch, alloc.batch) : sql`1=1`
              )
            );
        }
        
        // 🔄 Atualizar pickingOrderItems com incremento atômico
        // Priorizar filtro por inventoryId (quando disponível na alocação) para evitar
        // atualizar múltiplos itens com mesmo SKU+lote de endereços diferentes
        const allocInventoryId = (alloc as any).inventoryId;
        const orderItemFilter = allocInventoryId
          ? and(
              eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
              eq(pickingOrderItems.inventoryId, allocInventoryId)
            )
          : and(
              eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
              (alloc as any).uniqueCode ? eq((pickingOrderItems as any).uniqueCode, (alloc as any).uniqueCode) : 
                and(
                  eq(pickingOrderItems.productId, alloc.productId),
                  alloc.batch ? eq(pickingOrderItems.batch, alloc.batch) : sql`1=1`
                )
            );
        await db
          .update(pickingOrderItems)
          .set({
            pickedQuantity: sql`${pickingOrderItems.pickedQuantity} + ${quantityToAdd}`,
            status: sql`CASE WHEN ${pickingOrderItems.pickedQuantity} + ${quantityToAdd} >= ${pickingOrderItems.requestedQuantity} THEN 'picked' ELSE 'picking' END`,
          })
          .where(orderItemFilter);
      }

      return {
        ok: true,
        requiresManualQuantity: false,
        quantityAdded: quantityToAdd,
        pickedQuantity: newPickedQuantity,
        totalQuantity: alloc.quantity,
        remainingQuantity: alloc.quantity - newPickedQuantity,
        allocationCompleted: newStatus === "picked",
        // 📦 UOM: informações de conversão para feedback visual no coletor
        conversionFactor: unitsPerBox,
        uomSource, // "label" | "product"
        message: `+${quantityToAdd} un registrado (1 emb × ${unitsPerBox} un). Total: ${newPickedQuantity}/${alloc.quantity}.`,
      };
    }),

  /**
   * Registrar quantidade manual (item fracionado)
   * Chamado quando scanProduct retornou requiresManualQuantity = true
   */
  recordFractionalQuantity: protectedProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        allocationId: z.number(),
        quantity: z.number().positive(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, input.allocationId))
        .limit(1);

      if (!alloc || alloc.pickingOrderId !== input.pickingOrderId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Alocação não encontrada",
        });
      }

      const remaining = alloc.quantity - alloc.pickedQuantity;

      // BUG DETECTADO: Não havia validação de quantidade > saldo disponível.
      if (input.quantity > remaining) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Quantidade informada (${input.quantity}) excede o saldo restante (${remaining}).`,
        });
      }

      // 🔄 INCREMENTO ATÔMICO: Usar SQL para evitar race conditions
      await db
        .update(pickingAllocations)
        .set({ 
          pickedQuantity: sql`${pickingAllocations.pickedQuantity} + ${input.quantity}`,
          status: sql`CASE WHEN ${pickingAllocations.pickedQuantity} + ${input.quantity} >= ${pickingAllocations.quantity} THEN 'picked' ELSE 'in_progress' END`
        })
        .where(eq(pickingAllocations.id, alloc.id));
      
      // Buscar estado atualizado após incremento
      const [updatedAlloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, alloc.id))
        .limit(1);
      
      const newPickedQuantity = updatedAlloc.pickedQuantity;
      const newStatus = updatedAlloc.status;

      // ✅ SINCRONIZAÇÃO CRUZADA: Incremento atômico em pickingWaveItems e pickingOrderItems
      {
        const { pickingOrderItems, pickingWaveItems } = await import("../drizzle/schema");
        
        // 🔄 Atualizar pickingWaveItems com incremento atômico
        if (alloc.waveId) {
          await db
            .update(pickingWaveItems)
            .set({
              pickedQuantity: sql`${pickingWaveItems.pickedQuantity} + ${input.quantity}`,
              status: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} + ${input.quantity} >= ${pickingWaveItems.totalQuantity} THEN 'picked' ELSE 'picking' END`,
              pickedAt: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} + ${input.quantity} >= ${pickingWaveItems.totalQuantity} THEN NOW() ELSE ${pickingWaveItems.pickedAt} END`,
            })
            .where(
              and(
                eq(pickingWaveItems.waveId, alloc.waveId),
                eq(pickingWaveItems.productId, alloc.productId),
                alloc.batch ? eq(pickingWaveItems.batch, alloc.batch) : sql`1=1`
              )
            );
        }
        
        // 🔄 Atualizar pickingOrderItems com incremento atômico
        // Filtrar por inventoryId quando disponível para evitar atualizar múltiplos itens
        const allocInventoryIdManual = (alloc as any).inventoryId;
        const orderItemFilterManual = allocInventoryIdManual
          ? and(
              eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
              eq(pickingOrderItems.inventoryId, allocInventoryIdManual)
            )
          : and(
              eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
              (alloc as any).uniqueCode ? eq((pickingOrderItems as any).uniqueCode, (alloc as any).uniqueCode) : 
                and(
                  eq(pickingOrderItems.productId, alloc.productId),
                  alloc.batch ? eq(pickingOrderItems.batch, alloc.batch) : sql`1=1`
                )
            );
        await db
          .update(pickingOrderItems)
          .set({
            pickedQuantity: sql`${pickingOrderItems.pickedQuantity} + ${input.quantity}`,
            status: sql`CASE WHEN ${pickingOrderItems.pickedQuantity} + ${input.quantity} >= ${pickingOrderItems.requestedQuantity} THEN 'picked' ELSE 'picking' END`,
          })
          .where(orderItemFilterManual);
      }

      return {
        ok: true,
        quantityAdded: input.quantity,
        pickedQuantity: newPickedQuantity,
        totalQuantity: alloc.quantity,
        remainingQuantity: alloc.quantity - newPickedQuantity,
        allocationCompleted: newStatus === "picked",
      };
    }),

  /**
   * Reportar problema em um endereço (inacessível / etiqueta danificada)
   * Registra ocorrência e marca alocação como short_picked com 0 unidades
   * para que o gerente possa tomar decisão no painel web.
   */
  reportLocationProblem: protectedProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        locationCode: z.string(),
        reason: z.enum(["inaccessible", "damaged_label"]),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // ✅ CORREÇÃO: pickingOrderId é o waveId — buscar todos os pedidos da onda
      const waveOrdersForReport = await db
        .select({ id: pickingOrders.id })
        .from(pickingOrders)
        .where(eq(pickingOrders.waveId, input.pickingOrderId));

      const reportOrderIds = waveOrdersForReport.length > 0
        ? waveOrdersForReport.map(o => o.id)
        : [input.pickingOrderId];

      // Marcar todas as alocações desse endereço como short_picked
      const allocs = await db
        .select({ id: pickingAllocations.id })
        .from(pickingAllocations)
        .where(
          and(
            inArray(pickingAllocations.pickingOrderId, reportOrderIds),
            eq(pickingAllocations.locationCode, input.locationCode)
          )
        );

      for (const a of allocs) {
        await db
          .update(pickingAllocations)
          .set({ status: "short_picked" })
          .where(eq(pickingAllocations.id, a.id));
      }

      // Registrar nota no pedido
      // (em produção: inserir em tabela de ocorrências e notificar gerente via webhook)
      console.warn(
        `[PICKING] Problema reportado no endereço ${input.locationCode} ` +
          `(pedido ${input.pickingOrderId}) por operador ${ctx.user.id}: ${input.reason}. ${input.notes ?? ""}`
      );

      return {
        ok: true,
        message: `Ocorrência registrada. O gerente será notificado.`,
        affectedAllocations: allocs.length,
      };
    }),

  /**
   * Reportar falta ou avaria em um produto
   * Sistema tenta encontrar endereço alternativo com mesmo lote e regra do tenant.
   * Se não encontrar, registra short-picked.
   */
  reportProductProblem: protectedProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        allocationId: z.number(),
        reason: z.enum([
          "not_found",
          "damaged",
          "insufficient_quantity",
        ]),
        availableQuantity: z.number().min(0).optional(), // Para "insufficient_quantity"
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, input.allocationId))
        .limit(1);

      if (!alloc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Alocação não encontrada",
        });
      }

      // ✅ CORREÇÃO: pickingOrderId pode ser waveId — resolver o pickingOrderId real da alocação
      // A alocação já foi buscada acima e tem alloc.pickingOrderId (ID real do pedido)
      const realPickingOrderId = alloc.pickingOrderId;

      // Buscar pedido para tenant usando o pickingOrderId real da alocação
      const [order] = await db
        .select({ tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, realPickingOrderId))
        .limit(1);

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pedido não encontrado",
        });
      }

      const pickedSoFar =
        input.reason === "insufficient_quantity" && input.availableQuantity !== undefined
          ? input.availableQuantity
          : 0;

      // Registrar quanto foi separado (parcial) antes de marcar short_picked
      await db
        .update(pickingAllocations)
        .set({
          pickedQuantity: pickedSoFar,
          status: "short_picked",
        })
        .where(eq(pickingAllocations.id, alloc.id));

      // Tentar encontrar endereço alternativo com mesmo produto e lote compatível
      const { inventory, warehouseLocations: wl } = await import(
        "../drizzle/schema"
      );
      const { gt } = await import("drizzle-orm");

      const remainingNeeded = alloc.quantity - pickedSoFar;

      const altInventory = await db
        .select({
          locationId: inventory.locationId,
          locationCode: wl.code,
          batch: inventory.batch,
          labelCode: inventory.labelCode,
          uniqueCode: inventory.uniqueCode,
          quantity: inventory.quantity,
          reservedQuantity: inventory.reservedQuantity,
        })
        .from(inventory)
        .leftJoin(wl, eq(inventory.locationId, wl.id))
        .where(
          and(
            eq(inventory.productId, alloc.productId),
            eq(inventory.tenantId, order.tenantId),
            eq(inventory.status, "available"),
            gt(inventory.quantity, 0),
            // Mesmo lote se foi pré-alocado com lote específico
            alloc.batch ? eq(inventory.batch, alloc.batch) : undefined,
            // Excluir o mesmo endereço com problema (CORREÇÃO BUG: era eq → deve ser ne)
            alloc.locationCode ? sql`${wl.code} != ${alloc.locationCode}` : undefined
          )
        )
        .limit(5);

      // Filtrar endereços com saldo disponível suficiente
      const alternatives = altInventory.filter(
        (inv) =>
          inv.quantity - (inv.reservedQuantity ?? 0) >= remainingNeeded &&
          inv.locationCode !== alloc.locationCode
      );

      if (alternatives.length > 0) {
        const alt = alternatives[0];

        // Criar nova alocação alternativa
        const maxSeq = await db
          .select({ seq: pickingAllocations.sequence })
          .from(pickingAllocations)
          .where(eq(pickingAllocations.pickingOrderId, realPickingOrderId))
          .orderBy(pickingAllocations.sequence);

        const nextSeq = maxSeq.length > 0 ? maxSeq[maxSeq.length - 1].seq + 1 : 1;

        await db.insert(pickingAllocations).values({
          pickingOrderId: realPickingOrderId,
          productId: alloc.productId,
          productSku: alloc.productSku,
          locationId: alt.locationId!,
          locationCode: alt.locationCode!,
          batch: alt.batch ?? null,
          expiryDate: alloc.expiryDate ?? null,
          uniqueCode: alt.uniqueCode,
          labelCode: alt.labelCode,
          quantity: remainingNeeded,
          isFractional: remainingNeeded < (alloc.quantity > 0 ? alloc.quantity : 1),
          sequence: nextSeq,
          status: "pending",
          pickedQuantity: 0,
        });

        console.info(
          `[PICKING] Endereço alternativo ${alt.locationCode} adicionado à rota ` +
            `(pedido ${input.pickingOrderId}, produto ${alloc.productSku})`
        );

        return {
          ok: true,
          alternativeFound: true,
          alternativeLocation: alt.locationCode,
          message: `Endereço alternativo encontrado: ${alt.locationCode}. Adicionado à rota.`,
        };
      }

      // Sem alternativa — registrar divergência
      console.warn(
        `[PICKING] Short-picked sem alternativa: pedido ${input.pickingOrderId}, ` +
          `produto ${alloc.productSku}, lote ${alloc.batch ?? "N/A"}. ` +
          `Motivo: ${input.reason}. Operador: ${ctx.user.id}`
      );

      return {
        ok: true,
        alternativeFound: false,
        message: `Sem estoque alternativo disponível. Item registrado como short-picked. Gerente será notificado.`,
      };
    }),

  /**
   * Salvar progresso (pausar picking)
   */
  pause: tenantProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        currentSequence: z.number(),
        currentLocationId: z.number().nullable(),
        scannedItems: z.array(z.any()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // ✅ CORREÇÃO: pickingOrderId é o waveId — buscar todos os pedidos da onda
      const waveOrders = await db
        .select({ id: pickingOrders.id })
        .from(pickingOrders)
        .where(eq(pickingOrders.waveId, input.pickingOrderId));

      const orderIds = waveOrders.length > 0
        ? waveOrders.map(o => o.id)
        : [input.pickingOrderId];

      // Salvar progresso no primeiro pedido da onda (progress é por pedido)
      if (orderIds.length > 0) {
        await db
          .update(pickingProgress)
          .set({
            currentSequence: input.currentSequence,
            currentLocationId: input.currentLocationId ?? null,
            scannedItems: input.scannedItems,
            pausedAt: new Date(),
            pausedBy: ctx.user.id,
          })
          .where(inArray(pickingProgress.pickingOrderId, orderIds));
      }

      // Manter status in_progress em todos os pedidos da onda
      await db
        .update(pickingOrders)
        .set({ status: "in_progress" })
        .where(inArray(pickingOrders.id, orderIds));

      return { ok: true, message: "Progresso salvo. Pode retomar a qualquer momento." };
    }),

  /**
   * Concluir picking de uma onda (todos os pedidos)
   * ✅ CORREÇÃO: pickingOrderId é na verdade o waveId (selectedOrderId no frontend)
   * Opera em todos os pedidos da onda
   * Se houver alocações short_picked → status = "divergent"
   * Se tudo completo → status = "picked"
   */
  complete: protectedProcedure
    .input(z.object({ pickingOrderId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // ✅ CORREÇÃO: pickingOrderId é o waveId — buscar todos os pedidos da onda
      const waveOrders = await db
        .select({ id: pickingOrders.id })
        .from(pickingOrders)
        .where(eq(pickingOrders.waveId, input.pickingOrderId));

      // Fallback: se não encontrar pedidos pela onda, tentar como pickingOrderId direto
      const orderIds = waveOrders.length > 0
        ? waveOrders.map(o => o.id)
        : [input.pickingOrderId];

      // Buscar todas as alocações de todos os pedidos da onda
      const allocs = await db
        .select({ status: pickingAllocations.status })
        .from(pickingAllocations)
        .where(inArray(pickingAllocations.pickingOrderId, orderIds));

      if (allocs.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Nenhuma alocação encontrada para esta onda",
        });
      }

      const pending = allocs.filter(
        (a) => a.status === "pending" || a.status === "in_progress"
      );

      if (pending.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Ainda há ${pending.length} item(ns) não finalizados.`,
        });
      }

      const hasShortPicked = allocs.some((a) => a.status === "short_picked");
      const newStatus = hasShortPicked ? "divergent" : "picked";

      // CORREÇÃO: Copiar lote e validade das alocações para pickingOrderItems
      // para que a validação de lote funcione no /collector/stage
      const allocsWithBatch = await db
        .select({
          pickingOrderId: pickingAllocations.pickingOrderId,
          productId: pickingAllocations.productId,
          batch: pickingAllocations.batch,
          expiryDate: pickingAllocations.expiryDate,
          uniqueCode: (pickingAllocations as any).uniqueCode,
        })
        .from(pickingAllocations)
        .where(inArray(pickingAllocations.pickingOrderId, orderIds));

      // Atualizar pickingOrderItems com lote e validade das alocações
      const { pickingOrderItems } = await import("../drizzle/schema");
      for (const alloc of allocsWithBatch) {
        if (alloc.batch) {
          await db
            .update(pickingOrderItems)
            .set({
              batch: alloc.batch,
              expiryDate: alloc.expiryDate,
            })
            .where(
              and(
                eq(pickingOrderItems.pickingOrderId, alloc.pickingOrderId),
                (alloc as any).uniqueCode ? eq((pickingOrderItems as any).uniqueCode, (alloc as any).uniqueCode) :
                  and(
                    eq(pickingOrderItems.productId, alloc.productId),
                    eq(pickingOrderItems.batch, alloc.batch)
                  )
              )
            );
        }
      }

      // Atualizar status de todos os pedidos da onda
      for (const orderId of orderIds) {
        // Verificar se este pedido específico tem divergências
        const orderAllocs = await db
          .select({ status: pickingAllocations.status })
          .from(pickingAllocations)
          .where(eq(pickingAllocations.pickingOrderId, orderId));
        const orderHasShortPicked = orderAllocs.some(a => a.status === "short_picked");
        const orderStatus = orderHasShortPicked ? "divergent" : "picked";

        await db
          .update(pickingOrders)
          .set({
            status: orderStatus,
            pickedBy: ctx.user.id,
            pickedAt: new Date(),
          })
          .where(eq(pickingOrders.id, orderId));
      }

      // Atualizar status da onda
      await db
        .update(pickingWaves)
        .set({
          status: "picked",
          pickedBy: ctx.user.id,
          pickedAt: new Date(),
        })
        .where(eq(pickingWaves.id, input.pickingOrderId));

      if (hasShortPicked) {
        console.warn(
          `[PICKING] Onda ${input.pickingOrderId} finalizada com divergências (short-picked). ` +
            `Operador: ${ctx.user.id}`
        );
      }

      return {
        ok: true,
        status: newStatus,
        hasDivergences: hasShortPicked,
        message: hasShortPicked
          ? "Separação concluída com divergências. Gerente foi notificado."
          : "Separação concluída com sucesso!",
      };
    }),

  /**
   * Desfazer última bipagem de produto no picking (LIFO)
   * Decrementa pickedQuantity na alocação e nas tabelas sincronizadas
   */
  undoLastScan: tenantProcedure
    .input(z.object({
      allocationId: z.number(),
      pickingOrderId: z.number(),
      quantityToUndo: z.number().min(1).default(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(and(
          eq(pickingAllocations.id, input.allocationId),
          eq(pickingAllocations.pickingOrderId, input.pickingOrderId)
        ))
        .limit(1);

      if (!alloc) throw new TRPCError({ code: "NOT_FOUND", message: "Alocação não encontrada" });
      if (alloc.pickedQuantity <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Nenhuma bipagem para desfazer nesta alocação" });

      const qty = Math.min(input.quantityToUndo, alloc.pickedQuantity);

      // Reverter alocação
      await db.update(pickingAllocations)
        .set({
          pickedQuantity: sql`${pickingAllocations.pickedQuantity} - ${qty}`,
          status: sql`CASE WHEN ${pickingAllocations.pickedQuantity} - ${qty} <= 0 THEN 'pending' ELSE 'in_progress' END`,
        })
        .where(eq(pickingAllocations.id, alloc.id));

      // Reverter pickingWaveItems e pickingOrderItems
      const { pickingOrderItems, pickingWaveItems } = await import("../drizzle/schema");

      if (alloc.waveId) {
        await db.update(pickingWaveItems)
          .set({
            pickedQuantity: sql`GREATEST(0, ${pickingWaveItems.pickedQuantity} - ${qty})`,
            status: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} - ${qty} <= 0 THEN 'picking' ELSE ${pickingWaveItems.status} END`,
          })
          .where(and(
            eq(pickingWaveItems.waveId, alloc.waveId),
            eq(pickingWaveItems.productId, alloc.productId),
            alloc.batch ? eq(pickingWaveItems.batch, alloc.batch) : sql`1=1`
          ));
      }

      await db.update(pickingOrderItems)
        .set({
          pickedQuantity: sql`GREATEST(0, ${pickingOrderItems.pickedQuantity} - ${qty})`,
          status: sql`CASE WHEN ${pickingOrderItems.pickedQuantity} - ${qty} <= 0 THEN 'pending' ELSE 'picking' END`,
        })
        .where(and(
          eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
          eq(pickingOrderItems.productId, alloc.productId),
          alloc.batch ? eq(pickingOrderItems.batch, alloc.batch) : sql`1=1`
        ));

      return { ok: true, quantityReverted: qty, message: `Última bipagem desfeita (${qty} un.)` };
    }),

  /**
   * Buscar rota atualizada de uma onda (para sincronização durante o fluxo)
   * Aceita waveId e retorna rota consolidada de todos os pedidos da onda
   * (equivalente ao startOrResume, mas sem mudar status)
   */
  getRoute: protectedProcedure
    .input(z.object({ pickingOrderId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable",
        });

      // ✅ CORREÇÃO: pickingOrderId aqui é na verdade o waveId (selectedOrderId no frontend)
      // Buscar todos os pedidos da onda e consolidar a rota
      const waveOrders = await db
        .select({ id: pickingOrders.id })
        .from(pickingOrders)
        .where(eq(pickingOrders.waveId, input.pickingOrderId));

      if (waveOrders.length === 0) {
        // Fallback: tentar como pickingOrderId direto (compatibilidade)
        return buildRoute(db, input.pickingOrderId);
      }

      // Consolidar rotas de todos os pedidos da onda
      const allRoutes: any[] = [];
      for (const order of waveOrders) {
        const orderRoute = await buildRoute(db, order.id);
        allRoutes.push(...orderRoute);
      }

      // Mesclar por locationCode + consolidar itens duplicados por [SKU + Lote + Endereço]
      const routeMap = new Map<string, any>();
      for (const loc of allRoutes) {
        if (!routeMap.has(loc.locationCode)) {
          routeMap.set(loc.locationCode, {
            locationId: loc.locationId,
            locationCode: loc.locationCode,
            sequence: loc.sequence,
            hasFractional: loc.hasFractional,
            allDone: loc.allDone,
            items: [],
          });
        }
        const merged = routeMap.get(loc.locationCode)!;
        if (loc.hasFractional) merged.hasFractional = true;
        if (!loc.allDone) merged.allDone = false;
        if (loc.sequence < merged.sequence) merged.sequence = loc.sequence;

        // Consolidar itens por [productId + batch]: somar quantidades em vez de duplicar linhas
        for (const item of loc.items) {
          const consolidationKey = `${item.productId}:${item.batch ?? ''}:${item.status}`;
          const existing = merged.items.find(
            (i: any) => `${i.productId}:${i.batch ?? ''}:${i.status}` === consolidationKey
          );
          if (existing && item.status !== 'picked' && item.status !== 'short_picked') {
            existing.quantity += item.quantity;
            existing.pickedQuantity += item.pickedQuantity;
          } else {
            merged.items.push({ ...item });
          }
        }
      }

      return Array.from(routeMap.values()).sort((a, b) => a.sequence - b.sequence);
    }),

  /**
   * Confirma o fator UOM informado pelo operador para uma etiqueta desconhecida.
   * Salva em products.unitsPerBox e processa a bipagem com o fator correto.
   */
  confirmUomFactor: protectedProcedure
    .input(
      z.object({
        allocationId: z.number(),
        pickingOrderId: z.number(),
        scannedCode: z.string(),
        unitsPerBox: z.number().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Buscar alocação
      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, input.allocationId))
        .limit(1);

      if (!alloc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Alocação não encontrada" });
      }

      // 1. Atualizar products.unitsPerBox com o fator informado
      await db
        .update(products)
        .set({ unitsPerBox: input.unitsPerBox })
        .where(eq(products.id, alloc.productId));

      // 2. Atualizar labelAssociations com o fator (se a etiqueta já foi criada)
      const { labelAssociations } = await import("../drizzle/schema");
      await db
        .update(labelAssociations)
        .set({ unitsPerBox: input.unitsPerBox })
        .where(
          and(
            eq(labelAssociations.labelCode, input.scannedCode),
            eq(labelAssociations.productId, alloc.productId)
          )
        );

      // 3. Registrar na unitPendingQueue para rastreabilidade
      // Buscar tenantId do PEDIDO (não do usuário logado) para garantir segregação de tenants
      const { pickingOrders: pickingOrdersTable } = await import("../drizzle/schema");
      const [orderForTenant] = await db
        .select({ tenantId: pickingOrdersTable.tenantId })
        .from(pickingOrdersTable)
        .where(eq(pickingOrdersTable.id, input.pickingOrderId))
        .limit(1);
      const orderTenantId = orderForTenant?.tenantId ?? ctx.user?.tenantId ?? 0;

      // A tabela unitPendingQueue usa campos: tenantId, productCode, productDescription, xmlUnit, reason, status, resolvedBy, resolvedAt
      try {
        const { unitPendingQueue } = await import("../drizzle/schema");
        await db.insert(unitPendingQueue).values({
          tenantId: orderTenantId,
          productCode: alloc.productSku,
          productDescription: `UOM confirmado via coletor: ${input.unitsPerBox} un/emb`,
          xmlUnit: `${input.unitsPerBox}`,
          reason: "no_conversion",
          status: "resolved",
          resolvedBy: ctx.user?.id ?? 0,
          resolvedAt: new Date(),
        });
      } catch {
        // Ignorar erro de unitPendingQueue — não bloquear o fluxo
      }

      // 4. Processar a bipagem com o fator correto
      const remaining = alloc.quantity - alloc.pickedQuantity;
      const quantityToAdd = Math.min(input.unitsPerBox, remaining);

      await db
        .update(pickingAllocations)
        .set({
          pickedQuantity: sql`${pickingAllocations.pickedQuantity} + ${quantityToAdd}`,
          status: sql`CASE WHEN ${pickingAllocations.pickedQuantity} + ${quantityToAdd} >= ${pickingAllocations.quantity} THEN 'picked' ELSE 'in_progress' END`,
        })
        .where(eq(pickingAllocations.id, alloc.id));

      // Sincronizar pickingWaveItems
      if (alloc.waveId) {
        const { pickingWaveItems } = await import("../drizzle/schema");
        await db
          .update(pickingWaveItems)
          .set({
            pickedQuantity: sql`${pickingWaveItems.pickedQuantity} + ${quantityToAdd}`,
            status: sql`CASE WHEN ${pickingWaveItems.pickedQuantity} + ${quantityToAdd} >= ${pickingWaveItems.totalQuantity} THEN 'picked' ELSE 'picking' END`,
          })
          .where(
            and(
              eq(pickingWaveItems.waveId, alloc.waveId),
              eq(pickingWaveItems.productId, alloc.productId),
              alloc.batch ? eq(pickingWaveItems.batch, alloc.batch) : sql`1=1`
            )
          );
      }

      // Sincronizar pickingOrderItems
      // Filtrar por inventoryId quando disponível para evitar atualizar múltiplos itens
      const { pickingOrderItems } = await import("../drizzle/schema");
      const allocInventoryIdFrac = (alloc as any).inventoryId;
      const orderItemFilterFrac = allocInventoryIdFrac
        ? and(
            eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
            eq(pickingOrderItems.inventoryId, allocInventoryIdFrac)
          )
        : and(
            eq(pickingOrderItems.pickingOrderId, input.pickingOrderId),
            eq(pickingOrderItems.productId, alloc.productId),
            alloc.batch ? eq(pickingOrderItems.batch, alloc.batch) : sql`1=1`
          );
      await db
        .update(pickingOrderItems)
        .set({
          pickedQuantity: sql`${pickingOrderItems.pickedQuantity} + ${quantityToAdd}`,
          status: sql`CASE WHEN ${pickingOrderItems.pickedQuantity} + ${quantityToAdd} >= ${pickingOrderItems.requestedQuantity} THEN 'picked' ELSE 'picking' END`,
        })
        .where(orderItemFilterFrac);

      const [updatedAlloc] = await db
        .select()
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, alloc.id))
        .limit(1);

      return {
        ok: true,
        quantityAdded: quantityToAdd,
        allocationCompleted: updatedAlloc?.status === "picked",
        newPickedQuantity: updatedAlloc?.pickedQuantity ?? quantityToAdd,
        unitsPerBoxSaved: input.unitsPerBox,
      };
    }),

  /**
   * Associar etiqueta durante o picking.
   * Chamado quando o operador bipa uma etiqueta nova (não cadastrada) durante a separação.
   * Cria registro em labelAssociations, atualiza inventory, pickingAllocations e pickingWaveItems.
   */
  associateLabelPicking: protectedProcedure
    .input(
      z.object({
        pickingOrderId: z.number(),
        allocationId: z.number(),
        labelCode: z.string().min(1),
        productId: z.number(),
        batch: z.string().nullable(),
        expiryDate: z.string().nullable(),
        unitsPerBox: z.number().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // 1. Buscar alocação e validar
      const [alloc] = await db
        .select()
        .from(pickingAllocations)
        .where(
          and(
            eq(pickingAllocations.id, input.allocationId),
            eq(pickingAllocations.pickingOrderId, input.pickingOrderId)
          )
        )
        .limit(1);

      if (!alloc)
        throw new TRPCError({ code: "NOT_FOUND", message: "Alocação não encontrada" });

      // 2. Obter tenantId do PEDIDO (não do usuário logado)
      const [order] = await db
        .select({ tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.pickingOrderId))
        .limit(1);

      const orderTenantId = order?.tenantId;
      if (!orderTenantId)
        throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado" });

      // 3. Validar produto — deve corresponder ao produto da alocação
      if (input.productId !== alloc.productId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Produto selecionado não corresponde ao item da separação",
        });

      // 4. Verificar duplicidade de labelCode (constraint UNIQUE global)
      const [existingLabel] = await db
        .select({ id: labelAssociations.id })
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      if (existingLabel)
        throw new TRPCError({
          code: "CONFLICT",
          message: `Etiqueta "${input.labelCode}" já está cadastrada no sistema`,
        });

      // 5. Buscar produto para uniqueCode
      const [prod] = await db
        .select({ sku: products.sku, unitsPerBox: products.unitsPerBox })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);

      if (!prod)
        throw new TRPCError({ code: "NOT_FOUND", message: "Produto não encontrado" });

      const uniqueCode = getUniqueCode(prod.sku ?? alloc.productSku, input.batch);
      const userId = ctx.user.id;

      // 6. Executar em transação
      await db.transaction(async (tx) => {
        // 6.1 Criar labelAssociation
        await tx.insert(labelAssociations).values({
          labelCode: input.labelCode,
          uniqueCode,
          productId: input.productId,
          batch: input.batch,
          expiryDate: input.expiryDate as any,
          unitsPerBox: input.unitsPerBox,
          associatedBy: userId,
          associatedAt: new Date(),
          status: "AVAILABLE" as any,
          tenantId: orderTenantId,
        });

        // 6.2 Atualizar inventory: vincular labelCode ao registro de estoque da alocação
        if (alloc.locationId) {
          await tx
            .update(inventory)
            .set({ labelCode: input.labelCode })
            .where(
              and(
                eq(inventory.productId, input.productId),
                eq(inventory.locationId, alloc.locationId),
                input.batch ? eq(inventory.batch, input.batch) : sql`1=1`,
                eq(inventory.tenantId, orderTenantId)
              )
            );
        }

        // 6.3 Vincular labelCode na pickingAllocation
        await tx
          .update(pickingAllocations)
          .set({ labelCode: input.labelCode })
          .where(eq(pickingAllocations.id, alloc.id));

        // 6.4 Vincular labelCode em pickingWaveItems
        if (alloc.waveId) {
          await tx
            .update(pickingWaveItems)
            .set({ labelCode: input.labelCode })
            .where(
              and(
                eq(pickingWaveItems.waveId, alloc.waveId),
                eq(pickingWaveItems.productId, input.productId),
                input.batch ? eq(pickingWaveItems.batch, input.batch) : sql`1=1`
              )
            );
        }

        // 6.5 Atualizar unitsPerBox no produto se não existir
        if (!prod.unitsPerBox) {
          await tx
            .update(products)
            .set({ unitsPerBox: input.unitsPerBox })
            .where(eq(products.id, input.productId));
        }
      });

      console.info(
        `[PICKING] Etiqueta associada: ${input.labelCode} → produto ${alloc.productSku} ` +
          `lote ${input.batch ?? "S/L"} | pedido ${input.pickingOrderId} | operador ${userId}`
      );

      return {
        ok: true,
        labelCode: input.labelCode,
        uniqueCode,
        unitsPerBox: input.unitsPerBox,
        message: `Etiqueta "${input.labelCode}" associada ao produto ${alloc.productSku}`,
      };
    }),

  /**
   * Verificar se uma etiqueta existe no sistema (para decidir se abre modal de associação)
   */
  checkLabel: protectedProcedure
    .input(z.object({ labelCode: z.string(), allocationId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [alloc] = await db
        .select({ productId: pickingAllocations.productId, batch: pickingAllocations.batch })
        .from(pickingAllocations)
        .where(eq(pickingAllocations.id, input.allocationId))
        .limit(1);

      if (!alloc) return { exists: false, matchesAllocation: false };

      const [label] = await db
        .select({
          id: labelAssociations.id,
          productId: labelAssociations.productId,
          batch: labelAssociations.batch,
          expiryDate: labelAssociations.expiryDate,
          unitsPerBox: labelAssociations.unitsPerBox,
        })
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      if (!label) return { exists: false, matchesAllocation: false };

      const matchesAllocation =
        label.productId === alloc.productId &&
        (!alloc.batch || label.batch === alloc.batch);

      return {
        exists: true,
        matchesAllocation,
        productId: label.productId,
        batch: label.batch,
        expiryDate: label.expiryDate,
        unitsPerBox: label.unitsPerBox,
      };
    }),
});
