/**
 * Router para Módulo de Expedição
 * Gerencia Notas Fiscais, Romaneios e Expedição
 */

import { router, protectedProcedure } from "./_core/trpc.js";
import { tenantProcedure, assertSameTenant } from "./_core/tenantGuard";
import { getDb } from "./db.js";
import { 
  invoices, 
  shipmentManifests, 
  shipmentManifestItems,
  pickingOrders,
  pickingOrderItems,
  pickingWaves,
  products,
  productTenantMappings,
  tenants,
  inventory,
  inventoryMovements,
  invoicePickingOrders,
  warehouseLocations,
  warehouseZones,
  stageCheckItems,
  stageChecks
} from "../drizzle/schema.js";
import { parseNFE } from "./nfeParser.js";
import { TRPCError } from "@trpc/server";
import { getUniqueCode } from "./utils/uniqueCode.js";
import { z } from "zod";
import { eq, and, or, sql, desc, asc, inArray, isNull, isNotNull } from "drizzle-orm";
import { updateLocationStatus } from "./modules/locations";
import { loadConversionContext, resolveUnit, applyConversion } from "./unitConversionRouter.js";

// Unidades de embalagem que podem ser convertidas via unitsPerBox como fallback
const PACKAGE_UNITS = new Set([
  "CX","CXA","CAIXA","BOX",
  "PCT","PACOTE","PCK","PACK",
  "FD","FARDO","BDL","BUNDLE",
  "KIT","BLISTER","BLS",
  "AMPOLA","AMP",
  "FR","FRASCO",
  "TB","TUBO",
  "RL","ROLO",
  "SAC","SACO",
  "ENV","ENVELOPE",
  "BISNAGA","BSG",
  "POTE","PT",
  "LATA","LT",
  "GALAO","GL",
]);

export const shippingRouter = router({
  // ============================================================================
  // PEDIDOS - Fila de Expedição
  // ============================================================================
  
  /**
   * Listar pedidos prontos para expedição (status: staged)
   */
  listOrders: tenantProcedure
    .input(
      z.object({
        status: z.enum(["awaiting_invoice", "invoice_linked", "in_manifest", "shipped"]).optional(),
      }).optional()
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? null : effectiveTenantId;

      const conditions: any[] = [
        // Pedidos prontos para expedição: 'staged' (aguardando NF) ou 'invoiced' (NF vinculada, fora de romanéio)
        inArray(pickingOrders.status, ["staged", "invoiced"]),
      ];

      if (tenantId !== null) {
        conditions.push(eq(pickingOrders.tenantId, tenantId));
      }

      if (input?.status) {
        conditions.push(eq(pickingOrders.shippingStatus, input.status));
      }

      const orders = await db
        .select({
          id: pickingOrders.id,
          orderNumber: pickingOrders.orderNumber,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          customerName: pickingOrders.customerName,
          deliveryAddress: pickingOrders.deliveryAddress,
          shippingStatus: pickingOrders.shippingStatus,
          createdAt: pickingOrders.createdAt,
        })
        .from(pickingOrders)
        .where(and(...conditions))
        .orderBy(desc(pickingOrders.createdAt));

      return orders;
    }),

  // ============================================================================
  // NOTAS FISCAIS
  // ============================================================================

  /**
   * Importar XML de Nota Fiscal
   */
  importInvoice: tenantProcedure
    .input(
      z.object({
        xmlContent: z.string(), // Conteúdo do XML
        invoiceNumber: z.string(),
        series: z.string(),
        invoiceKey: z.string(),
        customerId: z.number(),
        customerName: z.string(),
        volumes: z.number(),
        totalValue: z.string(),
        issueDate: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? input.customerId : effectiveTenantId;

      // Verificar se NF já foi importada
      const existing = await db
        .select()
        .from(invoices)
        .where(eq(invoices.invoiceKey, input.invoiceKey))
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({ 
          code: "BAD_REQUEST", 
          message: "Nota Fiscal já foi importada anteriormente" 
        });
      }

      // Inserir NF
      const [result] = await db.insert(invoices).values({
        tenantId,
        invoiceNumber: input.invoiceNumber,
        series: input.series,
        invoiceKey: input.invoiceKey,
        customerId: input.customerId,
        customerName: input.customerName,
        xmlData: { raw: input.xmlContent }, // Armazenar XML completo
        volumes: input.volumes,
        totalValue: input.totalValue,
        issueDate: new Date(input.issueDate),
        status: "imported",
        importedBy: ctx.user.id,
      });

      return { 
        success: true, 
        invoiceId: Number(result.insertId),
        message: `Nota Fiscal ${input.invoiceNumber} importada com sucesso` 
      };
    }),

  /**
   * Listar Notas Fiscais
   */
  listInvoices: tenantProcedure
    .input(
      z.object({
        status: z.enum(["imported", "linked", "in_manifest", "shipped"]).optional(),
      }).optional()
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? null : effectiveTenantId;

      const conditions: any[] = [];

      if (tenantId !== null) {
        conditions.push(eq(invoices.tenantId, tenantId));
      }

      if (input?.status) {
        conditions.push(eq(invoices.status, input.status));
      }

      const result = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          series: invoices.series,
          invoiceKey: invoices.invoiceKey,
          customerName: invoices.customerName,
          pickingOrderId: invoices.pickingOrderId,
          volumes: invoices.volumes,
          totalValue: invoices.totalValue,
          issueDate: invoices.issueDate,
          status: invoices.status,
          importedAt: invoices.importedAt,
          linkedAt: invoices.linkedAt,
          orderNumber: pickingOrders.customerOrderNumber,
        })
        .from(invoices)
        .leftJoin(pickingOrders, eq(invoices.pickingOrderId, pickingOrders.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(invoices.importedAt));

      return result;
    }),

  /**
   * Vincular NF a Pedido
   */
  linkInvoiceToOrder: tenantProcedure
    .input(
      z.object({
        invoiceNumber: z.string(),
        orderNumber: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar NF pelo número
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.invoiceNumber, input.invoiceNumber))
        .limit(1);

      if (!invoice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `NF ${input.invoiceNumber} não encontrada`,
        });
      }

      // Buscar pedido pelo número do cliente
      const [order] = await db
        .select()
        .from(pickingOrders)
        .where(eq(pickingOrders.customerOrderNumber, input.orderNumber))
        .limit(1);

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Pedido ${input.orderNumber} não encontrado`,
        });
      }

      // Verificar se NF já está vinculada
      if (invoice.pickingOrderId) {
        throw new TRPCError({ 
          code: "BAD_REQUEST", 
          message: "Nota Fiscal já está vinculada a outro pedido" 
        });
      }

      if (order.status !== "staged") {
        throw new TRPCError({ 
          code: "BAD_REQUEST", 
          message: "Pedido deve estar com status 'staged' para receber NF" 
        });
      }

      // Parse XML da NF para validar
      const nfeData = await parseNFE((invoice.xmlData as any).raw);

      // 🔑 Carregar contexto de conversão UOM para o tenant do pedido
      // Permite normalizar unidades da NF (ex: CX) para unidade base (UN) antes de comparar
      const uomCtx = await loadConversionContext(order.tenantId);

      // ============================================================
      // MOTOR DE DE/PARA — Fallback em cascata para cada produto da NF
      // Prioridade: (1) sku direto → (2) internalCode → (3) exceção com lista
      // ============================================================

      // Buscar internalCode/supplierCode de todos os produtos do pedido para o fallback De/Para
      // Usa productTenantMappings para obter os códigos específicos do tenant
      const orderItemsFull = await db
        .select({
          productId: pickingOrderItems.productId,
          sku: products.sku,
          supplierCode: sql<string>`COALESCE(${productTenantMappings.supplierCode}, ${products.supplierCode})`,
          internalCode: sql<string>`COALESCE(${productTenantMappings.internalCode}, ${products.internalCode})`,
          customerCode: products.customerCode,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
          unitsPerBox: products.unitsPerBox,
          batch: pickingOrderItems.batch,
          uniqueCode: (pickingOrderItems as any).uniqueCode,
          description: products.description,
        })
        .from(pickingOrderItems)
        .leftJoin(products, eq(pickingOrderItems.productId, products.id))
        .leftJoin(
          productTenantMappings,
          and(eq(productTenantMappings.productId, pickingOrderItems.productId), eq(productTenantMappings.tenantId, order.tenantId))
        )
        .where(eq(pickingOrderItems.pickingOrderId, order.id));

      // Resolver cada produto da NF para um item do pedido usando fallback em cascata
      type ResolvedItem = {
        nfeCodigo: string;
        orderItem: typeof orderItemsFull[number];
        matchType: "sku" | "internalCode";
      };

      const resolvedItems: ResolvedItem[] = [];
      const unresolved: { nfeCodigo: string; nfeDescricao: string }[] = [];

      for (const nfeProd of nfeData.produtos) {
        // Tentativa 1: Match direto por sku, supplierCode ou customerCode
        let matched = orderItemsFull.find(
          item => item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo
        );
        if (matched) {
          resolvedItems.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "sku" });
          continue;
        }

        // Tentativa 2: Match por internalCode (De/Para aprendido)
        matched = orderItemsFull.find(item => item.internalCode === nfeProd.codigo);
        if (matched) {
          resolvedItems.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "internalCode" });
          continue;
        }

        // Sem match — registrar como não-identificado
        unresolved.push({ nfeCodigo: nfeProd.codigo, nfeDescricao: (nfeProd as any).descricao || nfeProd.codigo });
      }

      // Se houver itens não identificados, retornar erro estruturado para o frontend abrir o modal
      if (unresolved.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: JSON.stringify({
            type: "SKU_MAPPING_REQUIRED",
            orderTenantId: order.tenantId,
            unresolvedItems: unresolved,
            orderItems: orderItemsFull.map(i => ({
              productId: i.productId,
              sku: i.sku || i.internalCode || i.description,
              description: i.description,
              batch: i.batch,
            })),
          }),
        });
      }

      // Substituir orderItems pelo mapeamento resolvido para validação downstream
      // (reescreve nfeProd.codigo para o sku interno antes das validações de lote/qtd)
      const resolvedMap = new Map(resolvedItems.map(r => [r.nfeCodigo, r.orderItem]));

      // Reescrever nfeData.produtos com o sku interno resolvido (para validações abaixo)
      const nfeProdutosResolvidos = nfeData.produtos.map(p => ({
        ...p,
        codigoOriginal: p.codigo,
        codigo: resolvedMap.get(p.codigo)?.sku ?? p.codigo,
      }));

      // Log de audit para matches por internalCode (De/Para automático)
      for (const r of resolvedItems.filter(r => r.matchType === "internalCode")) {
        console.log(`[De/Para] NF código "${r.nfeCodigo}" → SKU interno "${r.orderItem.sku}" (internalCode match) — pedido ${order.customerOrderNumber}`);
      }

      // ============================================================
      // VALIDAÇÃO CONDICIONAL: Com Lote (estrita) vs Sem Lote (FEFO)
      // ============================================================
      // Separar produtos da NF em dois grupos: com rastro/lote e sem
      // Usar nfeProdutosResolvidos (códigos já traduzidos pelo De/Para)
      const nfeProdutosComLote = nfeProdutosResolvidos.filter(p => !!p.lote);
      const nfeProdutosSemLote = nfeProdutosResolvidos.filter(p => !p.lote);

      // --- GRUPO 1: Com Lote — validação estrita (SKU + Lote + Qtd) ---
      for (const nfeProd of nfeProdutosComLote) {
        const nfeUniqueCode = getUniqueCode(nfeProd.codigo, nfeProd.lote);
        const orderItem = orderItemsFull.find(item => {
          if (item.uniqueCode) return item.uniqueCode === nfeUniqueCode;
          const skuMatch = item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo;
          const batchMatch = item.batch === nfeProd.lote;
          return skuMatch && batchMatch;
        });

        if (!orderItem) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Produto ${nfeProd.codigo} (Lote: ${nfeProd.lote}) da NF não encontrado no pedido`,
          });
        }

        // 📦 Normalizar pedido para unidade base
        let expectedQuantity = orderItem.requestedQuantity;
        if (orderItem.requestedUM === 'box' && orderItem.unitsPerBox) {
          expectedQuantity = orderItem.requestedQuantity * orderItem.unitsPerBox;
        }

        // 📦 Normalizar NF para unidade base usando fator de conversão
        let nfeQtdBase = nfeProd.quantidade;
        const nfeUnit = (nfeProd as any).unidade ?? "UN";
        const nfeUnitTrib = (nfeProd as any).unidadeTributavel ?? null;
        const { resolvedCode: nfeUnitResolved } = resolveUnit(nfeUnitTrib, nfeUnit, uomCtx.aliasMap);
        const isNfeBaseUnit = nfeUnitResolved === "UN" || nfeUnitResolved === "UNID" || nfeUnitResolved === "UND";

        if (!isNfeBaseUnit) {
          const convKey = `${orderItem.productId}:${nfeUnitResolved}`;
          const factor = uomCtx.conversionMap.get(convKey);
          const strategy = uomCtx.roundingMap.get(convKey) ?? "round";

          if (factor) {
            nfeQtdBase = applyConversion(nfeProd.quantidade, factor, strategy);
            console.log(`[Shipping UOM] SKU ${nfeProd.codigo} Lote ${nfeProd.lote}: ${nfeProd.quantidade} ${nfeUnitResolved} × ${factor} = ${nfeQtdBase} UN`);
          } else {
            // Fator não cadastrado: retornar código especial para modal no frontend
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: JSON.stringify({
                type: "UOM_CONVERSION_REQUIRED",
                sku: nfeProd.codigo,
                productId: orderItem.productId,
                nfeUnit: nfeUnitResolved,
                nfeQty: nfeProd.quantidade,
                orderQty: expectedQuantity,
                message: `Fator de conversão não cadastrado para ${nfeUnitResolved} no produto ${nfeProd.codigo}. Cadastre o fator antes de vincular a NF.`,
              }),
            });
          }
        }

        if (expectedQuantity !== nfeQtdBase) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Quantidade divergente para SKU ${nfeProd.codigo} Lote ${nfeProd.lote}: Pedido=${expectedQuantity} un, NF=${nfeProd.quantidade} ${nfeUnitResolved} (=${nfeQtdBase} un)`,
          });
        }

        if (orderItem.batch && nfeProd.lote && orderItem.batch !== nfeProd.lote) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Lote divergente para SKU ${nfeProd.codigo}: Pedido=${orderItem.batch}, NF=${nfeProd.lote}`,
          });
        }
      }

      // --- GRUPO 2: Sem Lote — conferência simplificada (SKU + Qtd) com FEFO ---
      // Agrupar por SKU para somar quantidades (NF pode ter várias linhas do mesmo SKU)
      const semLoteAgrupado = new Map<string, { quantidade: number; orderItems: typeof orderItemsFull }>();
      for (const nfeProd of nfeProdutosSemLote) {
        const existing = semLoteAgrupado.get(nfeProd.codigo);
        if (existing) {
          existing.quantidade += nfeProd.quantidade;
        } else {
          // Coletar todos os itens do pedido para este SKU (já resolvido pelo De/Para)
          const skuItems = orderItemsFull.filter(
            item => item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo
          );
          semLoteAgrupado.set(nfeProd.codigo, { quantidade: nfeProd.quantidade, orderItems: skuItems });
        }
      }

      for (const [sku, { quantidade: nfeQtd, orderItems: skuItems }] of Array.from(semLoteAgrupado.entries())) {
        if (skuItems.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `SKU ${sku} da NF (sem lote) não encontrado no pedido`,
          });
        }

        // Somar total esperado do pedido para este SKU (em unidades base)
        const totalEsperado = skuItems.reduce((acc: number, item: typeof orderItemsFull[number]) => {
          const qtdBase = (item.requestedUM === 'box' && item.unitsPerBox)
            ? item.requestedQuantity * item.unitsPerBox
            : item.requestedQuantity;
          return acc + qtdBase;
        }, 0);

        // 📦 Normalizar quantidade da NF para unidade base usando fator de conversão
        // A NF pode estar em CX, FD, etc. — converter para UN antes de comparar
        const nfeProdSample = nfeProdutosSemLote.find(p => p.codigo === sku);
        const nfeUnitRaw = (nfeProdSample as any)?.unidade ?? "UN";
        const nfeUnitTribRaw = (nfeProdSample as any)?.unidadeTributavel ?? null;
        const { resolvedCode: nfeUnitCode } = resolveUnit(nfeUnitTribRaw, nfeUnitRaw, uomCtx.aliasMap);
        const isBaseUnit = nfeUnitCode === "UN" || nfeUnitCode === "UNID" || nfeUnitCode === "UND";

        let nfeQtdNorm = nfeQtd;
        if (!isBaseUnit) {
          const prodId = skuItems[0]?.productId;
          const convKey = prodId ? `${prodId}:${nfeUnitCode}` : null;
          const factor = convKey ? uomCtx.conversionMap.get(convKey) : undefined;
          const strategy = convKey ? (uomCtx.roundingMap.get(convKey) ?? "round") : "round";

          if (factor) {
            nfeQtdNorm = applyConversion(nfeQtd, factor, strategy);
            console.log(`[Shipping UOM] SKU ${sku} (sem lote): ${nfeQtd} ${nfeUnitCode} × ${factor} = ${nfeQtdNorm} UN`);
          } else {
            // Fator não cadastrado: tentar fallback com unitsPerBox do produto quando unidade for CX/CAIXA
            const isCaixaUnit = PACKAGE_UNITS.has(nfeUnitCode);
            const unitsPerBox = skuItems[0]?.unitsPerBox;
            if (isCaixaUnit && unitsPerBox) {
              nfeQtdNorm = nfeQtd * unitsPerBox;
              console.log(`[Shipping UOM] SKU ${sku} (sem lote): ${nfeQtd} CX × ${unitsPerBox} (unitsPerBox) = ${nfeQtdNorm} UN`);
            } else {
              // Fator não cadastrado e sem fallback: retornar código especial para modal no frontend
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: JSON.stringify({
                  type: "UOM_CONVERSION_REQUIRED",
                  sku,
                  productId: skuItems[0]?.productId,
                  nfeUnit: nfeUnitCode,
                  nfeQty: nfeQtd,
                  orderQty: totalEsperado,
                  message: `Fator de conversão não cadastrado para ${nfeUnitCode} no produto ${sku}. Cadastre o fator antes de vincular a NF.`,
                }),
              });
            }
          }
        }

        if (totalEsperado !== nfeQtdNorm) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Quantidade divergente para SKU ${sku} (sem lote): Pedido=${totalEsperado} un, NF=${nfeQtd} ${nfeUnitCode} (=${nfeQtdNorm} un)`,
          });
        }

        // Log de auditoria quando aprovado via conversão
        if (!isBaseUnit) {
          console.log(`[Shipping Audit] SKU ${sku}: vínculo aprovado via conversão UOM — ${nfeQtd} ${nfeUnitCode} = ${nfeQtdNorm} UN (pedido: ${totalEsperado} UN)`);
        }

        // Buscar estoque disponível para este SKU por FEFO (menor validade primeiro)
        // para registrar a baixa com rastreabilidade
        const prodRow = skuItems[0];
        const estoqueFefo = await db
          .select({
            id: inventory.id,
            batch: inventory.batch,
            expiryDate: inventory.expiryDate,
            quantity: inventory.quantity,
          })
          .from(inventory)
          .innerJoin(products, eq(inventory.productId, products.id))
          .leftJoin(
            productTenantMappings,
            and(eq(productTenantMappings.productId, inventory.productId), eq(productTenantMappings.tenantId, order.tenantId))
          )
          .where(
            and(
              or(
                eq(products.sku, sku),
                eq(products.supplierCode, sku),
                sql`COALESCE(${productTenantMappings.supplierCode}, '') = ${sku}`
              ),
              eq(inventory.tenantId, order.tenantId),
              eq(inventory.status, "available"),
              sql`${inventory.quantity} > 0`
            )
          )
          // FEFO: nulos (sem validade) por último, depois menor validade primeiro
          .orderBy(
            sql`CASE WHEN ${inventory.expiryDate} IS NULL THEN 1 ELSE 0 END`,
            asc(inventory.expiryDate)
          );

        // Registrar movimentações FEFO como "Vínculo Simplificado (Sem Lote)"
        let restante = nfeQtd;
        for (const lote of estoqueFefo) {
          if (restante <= 0) break;
          const consumido = Math.min(restante, lote.quantity);
          await db.insert(inventoryMovements).values({
            tenantId: order.tenantId,
            productId: prodRow.productId!,
            batch: lote.batch,
            fromLocationId: undefined,
            toLocationId: undefined,
            quantity: consumido,
            movementType: "picking",
            referenceType: "invoice",
            referenceId: invoice.id,
            performedBy: ctx.user.id,
            notes: `Vínculo Simplificado (Sem Lote) — NF ${invoice.invoiceNumber} / Pedido ${order.customerOrderNumber} / FEFO lote ${lote.batch || 'S/L'} val ${lote.expiryDate || 'S/V'}`,
            conversionSource: "manual",
          });
          restante -= consumido;
        }

        if (restante > 0) {
          console.warn(`[Shipping] Vínculo Simplificado: saldo insuficiente para SKU ${sku} — faltam ${restante} un no estoque`);
        }
      }

      // Validar volumes (comparar com total esperado do pedido)
      // Por enquanto apenas log, pode adicionar validação se necessário
      console.log(`[Shipping] Volumes da NF: ${nfeData.volumes}`);

      // Vincular NF ao pedido
      await db
        .update(invoices)
        .set({
          pickingOrderId: order.id,
          status: "linked",
          linkedAt: new Date(),
        })
        .where(eq(invoices.id, invoice.id));

      // Atualizar status de expedição do pedido
      await db
        .update(pickingOrders)
        .set({
          shippingStatus: "invoice_linked",
        })
        .where(eq(pickingOrders.id, order.id));

      return { 
        success: true, 
        message: "Nota Fiscal vinculada ao pedido com sucesso" 
      };
    }),

  /**
   * Vincular NF a Múltiplos Pedidos (N:N)
   * Valida os itens da NF contra o conjunto consolidado de todos os pedidos vinculados.
   */
  linkInvoiceToOrders: tenantProcedure
    .input(
      z.object({
        invoiceNumber: z.string(),
        orderNumbers: z.array(z.string()).min(1, "Informe ao menos um pedido"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar NF pelo número
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.invoiceNumber, input.invoiceNumber))
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: `NF ${input.invoiceNumber} não encontrada` });
      }

      if (invoice.status !== "imported") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `NF ${input.invoiceNumber} já está vinculada ou em romaneio` });
      }

      // Buscar todos os pedidos pelos números do cliente
      const orders = await db
        .select()
        .from(pickingOrders)
        .where(inArray(pickingOrders.customerOrderNumber, input.orderNumbers));

      const notFound = input.orderNumbers.filter(n => !orders.find(o => o.customerOrderNumber === n));
      if (notFound.length > 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Pedidos não encontrados: ${notFound.join(", ")}` });
      }

      const notStaged = orders.filter(o => o.status !== "staged");
      if (notStaged.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pedidos não estão com status 'staged': ${notStaged.map(o => o.customerOrderNumber).join(", ")}`,
        });
      }

      // Verificar se algum pedido já tem NF vinculada via tabela N:N
      const existingLinks = await db
        .select()
        .from(invoicePickingOrders)
        .where(inArray(invoicePickingOrders.pickingOrderId, orders.map(o => o.id)));
      if (existingLinks.length > 0) {
        const linkedOrderIds = existingLinks.map(l => l.pickingOrderId);
        const linkedOrders = orders.filter(o => linkedOrderIds.includes(o.id));
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pedidos já vinculados a outra NF: ${linkedOrders.map(o => o.customerOrderNumber).join(", ")}`,
        });
      }

      // Usar tenantId do primeiro pedido
      const tenantId = orders[0].tenantId;

      // Carregar contexto de conversão UOM
      const uomCtx = await loadConversionContext(tenantId);

      // Consolidar todos os itens de todos os pedidos (com códigos por tenant via productTenantMappings)
      const allOrderItems = await db
        .select({
          pickingOrderId: pickingOrderItems.pickingOrderId,
          productId: pickingOrderItems.productId,
          sku: products.sku,
          supplierCode: sql<string>`COALESCE(${productTenantMappings.supplierCode}, ${products.supplierCode})`,
          internalCode: sql<string>`COALESCE(${productTenantMappings.internalCode}, ${products.internalCode})`,
          customerCode: products.customerCode,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
          unitsPerBox: products.unitsPerBox,
          batch: pickingOrderItems.batch,
          uniqueCode: (pickingOrderItems as any).uniqueCode,
          description: products.description,
        })
        .from(pickingOrderItems)
        .leftJoin(products, eq(pickingOrderItems.productId, products.id))
        .leftJoin(
          productTenantMappings,
          and(eq(productTenantMappings.productId, pickingOrderItems.productId), eq(productTenantMappings.tenantId, tenantId))
        )
        .where(inArray(pickingOrderItems.pickingOrderId, orders.map(o => o.id)));

      // Parse XML da NF
      const nfeData = await parseNFE((invoice.xmlData as any).raw);

      // Motor De/Para: resolver cada produto da NF para um item dos pedidos
      type ResolvedItem = { nfeCodigo: string; orderItem: typeof allOrderItems[number]; matchType: "sku" | "internalCode" };
      const resolvedItems: ResolvedItem[] = [];
      const unresolved: { nfeCodigo: string; nfeDescricao: string }[] = [];

      for (const nfeProd of nfeData.produtos) {
        let matched = allOrderItems.find(item => item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo);
        if (matched) { resolvedItems.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "sku" }); continue; }
        matched = allOrderItems.find(item => item.internalCode === nfeProd.codigo);
        if (matched) { resolvedItems.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "internalCode" }); continue; }
        unresolved.push({ nfeCodigo: nfeProd.codigo, nfeDescricao: (nfeProd as any).descricao || nfeProd.codigo });
      }

      if (unresolved.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: JSON.stringify({
            type: "SKU_MAPPING_REQUIRED",
            orderTenantId: tenantId,
            unresolvedItems: unresolved,
            orderItems: allOrderItems.map(i => ({ productId: i.productId, sku: i.sku || i.internalCode || i.description, description: i.description, batch: i.batch })),
          }),
        });
      }

      const resolvedMap = new Map(resolvedItems.map(r => [r.nfeCodigo, r.orderItem]));
      const nfeProdutosResolvidos = nfeData.produtos.map(p => ({
        ...p,
        codigoOriginal: p.codigo,
        codigo: resolvedMap.get(p.codigo)?.sku ?? p.codigo,
      }));

      // Validação com lote: agrupar por SKU+Lote e somar quantidades de todos os pedidos
      const nfeProdutosComLote = nfeProdutosResolvidos.filter(p => !!p.lote);
      // Agrupar itens da NF por SKU+Lote (pode haver múltiplas linhas do mesmo SKU+Lote)
      const nfeComLoteAgrupado = new Map<string, { quantidade: number; produto: typeof nfeProdutosResolvidos[number] }>();
      for (const nfeProd of nfeProdutosComLote) {
        const key = `${nfeProd.codigo}|${nfeProd.lote}`;
        const existing = nfeComLoteAgrupado.get(key);
        if (existing) { existing.quantidade += nfeProd.quantidade; }
        else { nfeComLoteAgrupado.set(key, { quantidade: nfeProd.quantidade, produto: nfeProd }); }
      }
      for (const [key, { quantidade: nfeQtd, produto: nfeProd }] of Array.from(nfeComLoteAgrupado.entries())) {
        const nfeUniqueCode = getUniqueCode(nfeProd.codigo, nfeProd.lote);
        // Buscar TODOS os itens dos pedidos com o mesmo SKU+Lote (pode estar distribuído em vários pedidos)
        const matchingItems = allOrderItems.filter(item => {
          if (item.uniqueCode) return item.uniqueCode === nfeUniqueCode;
          return (item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo) && item.batch === nfeProd.lote;
        });
        if (matchingItems.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Produto ${nfeProd.codigo} (Lote: ${nfeProd.lote}) da NF não encontrado nos pedidos vinculados` });
        }
        // Somar quantidades de todos os pedidos para este SKU+Lote
        const totalEsperado = matchingItems.reduce((acc, item) => {
          const qty = (item.requestedUM === 'box' && item.unitsPerBox) ? item.requestedQuantity * item.unitsPerBox : item.requestedQuantity;
          return acc + qty;
        }, 0);
        const nfeUnit = (nfeProd as any).unidade ?? "UN";
        const nfeUnitTrib = (nfeProd as any).unidadeTributavel ?? null;
        const { resolvedCode: nfeUnitResolved } = resolveUnit(nfeUnitTrib, nfeUnit, uomCtx.aliasMap);
        const isNfeBaseUnit = ["UN", "UNID", "UND"].includes(nfeUnitResolved);
        let nfeQtdBase = nfeQtd;
        if (!isNfeBaseUnit) {
          const firstItem = matchingItems[0];
          const convKey = `${firstItem.productId}:${nfeUnitResolved}`;
          const factor = uomCtx.conversionMap.get(convKey);
          const strategy = uomCtx.roundingMap.get(convKey) ?? "round";
          if (factor) { nfeQtdBase = applyConversion(nfeQtd, factor, strategy); }
          else {
            const isCaixaUnit2 = PACKAGE_UNITS.has(nfeUnitResolved);
            if (isCaixaUnit2 && firstItem.unitsPerBox) {
              nfeQtdBase = nfeQtd * firstItem.unitsPerBox;
            } else {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: JSON.stringify({ type: "UOM_CONVERSION_REQUIRED", sku: nfeProd.codigo, productId: firstItem.productId, nfeUnit: nfeUnitResolved, nfeQty: nfeQtd, orderQty: totalEsperado, message: `Fator de conversão não cadastrado para ${nfeUnitResolved} no produto ${nfeProd.codigo}.` }),
              });
            }
          }
        }
        if (totalEsperado !== nfeQtdBase) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Quantidade divergente para SKU ${nfeProd.codigo} Lote ${nfeProd.lote}: Pedidos consolidados=${totalEsperado} un, NF=${nfeQtd} (=${nfeQtdBase} un)` });
        }
      }

      // Validação sem lote (SKU + Qtd consolidada)
      const nfeProdutosSemLote = nfeProdutosResolvidos.filter(p => !p.lote);
      const semLoteAgrupado = new Map<string, { quantidade: number; orderItems: typeof allOrderItems }>();
      for (const nfeProd of nfeProdutosSemLote) {
        const existing = semLoteAgrupado.get(nfeProd.codigo);
        if (existing) { existing.quantidade += nfeProd.quantidade; }
        else {
          const skuItems = allOrderItems.filter(item => item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo || item.customerCode === nfeProd.codigo);
          semLoteAgrupado.set(nfeProd.codigo, { quantidade: nfeProd.quantidade, orderItems: skuItems });
        }
      }
       for (const [sku, { quantidade: nfeQtd, orderItems: skuItems }] of Array.from(semLoteAgrupado.entries())) {
        if (skuItems.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: `SKU ${sku} da NF não encontrado nos pedidos` });
        const totalEsperado = skuItems.reduce((acc, item) => acc + ((item.requestedUM === 'box' && item.unitsPerBox) ? item.requestedQuantity * item.unitsPerBox : item.requestedQuantity), 0);
        // Tentar converter NF qty para UN usando unitsPerBox se unidade for CX
        const nfeProdSample2 = nfeProdutosSemLote.find(p => p.codigo === sku);
        const nfeUnitRaw2 = (nfeProdSample2 as any)?.unidade ?? "UN";
        const nfeUnitTribRaw2 = (nfeProdSample2 as any)?.unidadeTributavel ?? null;
        const { resolvedCode: nfeUnitCode2 } = resolveUnit(nfeUnitTribRaw2, nfeUnitRaw2, uomCtx.aliasMap);
        const isCaixaUnit3 = PACKAGE_UNITS.has(nfeUnitCode2);
        const convKey2 = skuItems[0]?.productId ? `${skuItems[0].productId}:${nfeUnitCode2}` : null;
        const factor2 = convKey2 ? uomCtx.conversionMap.get(convKey2) : undefined;
        let nfeQtdNorm2 = nfeQtd;
        if (factor2) {
          nfeQtdNorm2 = applyConversion(nfeQtd, factor2, uomCtx.roundingMap.get(convKey2!) ?? "round");
        } else if (isCaixaUnit3 && skuItems[0]?.unitsPerBox) {
          nfeQtdNorm2 = nfeQtd * skuItems[0].unitsPerBox;
        }
        if (totalEsperado !== nfeQtdNorm2) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Quantidade divergente para SKU ${sku} (sem lote): Pedido=${totalEsperado} un, NF=${nfeQtd} ${nfeUnitCode2} (=${nfeQtdNorm2} un)` });
        }
      }
      // Tudo validado: registrar vínculos N:N
      for (const order of orders) {
        await db.insert(invoicePickingOrders).values({
          invoiceId: invoice.id,
          pickingOrderId: order.id,
          tenantId,
          linkedBy: ctx.user.id,
        });
      }

      // Manter compatibilidade: se apenas 1 pedido, atualizar pickingOrderId na invoice
      if (orders.length === 1) {
        await db.update(invoices).set({ pickingOrderId: orders[0].id, status: "linked", linkedAt: new Date() }).where(eq(invoices.id, invoice.id));
      } else {
        // Múltiplos pedidos: marcar NF como linked sem pickingOrderId singular
        await db.update(invoices).set({ status: "linked", linkedAt: new Date() }).where(eq(invoices.id, invoice.id));
      }

      // Atualizar shippingStatus de todos os pedidos
      await db
        .update(pickingOrders)
        .set({ shippingStatus: "invoice_linked" })
        .where(inArray(pickingOrders.id, orders.map(o => o.id)));

      // ========================================================================
      // RESERVA DE ESTOQUE NA ZONA EXP ao vincular NF→Pedido(s)
      // ========================================================================
      const allOrderItemsForReserve = await db
        .select({
          productId: pickingOrderItems.productId,
          uniqueCode: (pickingOrderItems as any).uniqueCode,
          batch: pickingOrderItems.batch,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
          unitsPerBox: products.unitsPerBox,
        })
        .from(pickingOrderItems)
        .innerJoin(products, eq(pickingOrderItems.productId, products.id))
        .where(inArray(pickingOrderItems.pickingOrderId, orders.map(o => o.id)));

      for (const item of allOrderItemsForReserve) {
        if (!item.uniqueCode) continue;
        const totalUnits = (item.requestedUM === 'box' && item.unitsPerBox)
          ? item.requestedQuantity * item.unitsPerBox
          : item.requestedQuantity;

        const expStock = await db
          .select({
            inventoryId: inventory.id,
            quantity: inventory.quantity,
            reservedQuantity: inventory.reservedQuantity,
            availableQuantity: sql<number>`${inventory.quantity} - COALESCE(${inventory.reservedQuantity}, 0)`,
          })
          .from(inventory)
          .where(
            and(
              eq(inventory.uniqueCode, item.uniqueCode),
              eq(inventory.locationZone, "EXP"),
              eq(inventory.status, "available"),
              sql`${inventory.quantity} - COALESCE(${inventory.reservedQuantity}, 0) > 0`
            )
          )
          .limit(1);

        if (expStock.length > 0) {
          const stock = expStock[0];
          const quantityToReserve = Math.min(totalUnits, stock.availableQuantity);
          if (quantityToReserve <= 0) continue;
          const newReserved = (stock.reservedQuantity || 0) + quantityToReserve;
          if (newReserved > stock.quantity) {
            console.warn(`[RESERVA-NF] Reserva excederia estoque físico para uniqueCode ${item.uniqueCode}. Pulando.`);
            continue;
          }
          await db
            .update(inventory)
            .set({ reservedQuantity: sql`COALESCE(${inventory.reservedQuantity}, 0) + ${quantityToReserve}` })
            .where(eq(inventory.id, stock.inventoryId));
          console.log(`[RESERVA-NF] Reservado ${quantityToReserve} un do uniqueCode ${item.uniqueCode} no estoque ${stock.inventoryId} ao vincular NF ${invoice.invoiceNumber}`);
        } else {
          console.warn(`[RESERVA-NF] Estoque EXP não encontrado para uniqueCode ${item.uniqueCode} ao vincular NF ${invoice.invoiceNumber}`);
        }
      }

      return {
        success: true,
        message: orders.length === 1
          ? `NF ${invoice.invoiceNumber} vinculada ao pedido ${orders[0].customerOrderNumber}`
          : `NF ${invoice.invoiceNumber} vinculada a ${orders.length} pedidos: ${orders.map(o => o.customerOrderNumber).join(", ")}`,
        linkedOrders: orders.map(o => o.customerOrderNumber),
      };
    }),

  /**
   * Desvincular NF de Pedido
   */
  unlinkInvoice: tenantProcedure
    .input(
      z.object({
        invoiceNumber: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar NF pelo número
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.invoiceNumber, input.invoiceNumber))
        .limit(1);

      if (!invoice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `NF ${input.invoiceNumber} não encontrada`,
        });
      }

      // Buscar pedidos vinculados via tabela N:N
      const linkedRows = await db
        .select({ pickingOrderId: invoicePickingOrders.pickingOrderId })
        .from(invoicePickingOrders)
        .where(eq(invoicePickingOrders.invoiceId, invoice.id));

      // Compatibilidade: incluir pickingOrderId singular se existir e não estiver na lista N:N
      const orderIdsSet = new Set(linkedRows.map(r => r.pickingOrderId));
      if (invoice.pickingOrderId) orderIdsSet.add(invoice.pickingOrderId);
      const orderIds = Array.from(orderIdsSet);

      if (orderIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Nota Fiscal não está vinculada a nenhum pedido",
        });
      }

      // ========================================================================
      // LIBERAR RESERVAS DE ESTOQUE NA ZONA EXP ao desvincular NF
      // ========================================================================
      const itemsToRelease = await db
        .select({
          productId: pickingOrderItems.productId,
          uniqueCode: (pickingOrderItems as any).uniqueCode,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
          unitsPerBox: products.unitsPerBox,
        })
        .from(pickingOrderItems)
        .innerJoin(products, eq(pickingOrderItems.productId, products.id))
        .where(inArray(pickingOrderItems.pickingOrderId, orderIds));

      for (const item of itemsToRelease) {
        if (!item.uniqueCode) continue;
        const totalUnits = (item.requestedUM === 'box' && item.unitsPerBox)
          ? item.requestedQuantity * item.unitsPerBox
          : item.requestedQuantity;

        const expStock = await db
          .select({
            inventoryId: inventory.id,
            reservedQuantity: inventory.reservedQuantity,
          })
          .from(inventory)
          .where(
            and(
              eq(inventory.uniqueCode, item.uniqueCode),
              eq(inventory.locationZone, "EXP"),
              sql`COALESCE(${inventory.reservedQuantity}, 0) > 0`
            )
          )
          .limit(1);

        if (expStock.length > 0) {
          const stock = expStock[0];
          const quantityToRelease = Math.min(totalUnits, stock.reservedQuantity ?? 0);
          if (quantityToRelease <= 0) continue;
          await db
            .update(inventory)
            .set({ reservedQuantity: sql`GREATEST(0, COALESCE(${inventory.reservedQuantity}, 0) - ${quantityToRelease})` })
            .where(eq(inventory.id, stock.inventoryId));
          console.log(`[LIBERAÇÃO-NF] Liberado ${quantityToRelease} un do uniqueCode ${item.uniqueCode} ao desvincular NF ${invoice.invoiceNumber}`);
        }
      }

      // Remover vínculos N:N
      await db
        .delete(invoicePickingOrders)
        .where(eq(invoicePickingOrders.invoiceId, invoice.id));

      // Desvincular NF
      await db
        .update(invoices)
        .set({ pickingOrderId: null, status: "imported", linkedAt: null })
        .where(eq(invoices.id, invoice.id));

      // Reverter status dos pedidos: staged + awaiting_invoice
      if (orderIds.length > 0) {
        await db
          .update(pickingOrders)
          .set({ status: "staged", shippingStatus: null })
          .where(inArray(pickingOrders.id, orderIds));
      }

      return {
        success: true,
        message: `Nota Fiscal desvinculada de ${orderIds.length} pedido(s) com sucesso. Reservas liberadas.`,
      };
    }),

  /**
   * Excluir NF Importada
   */
  deleteInvoice: tenantProcedure
    .input(
      z.object({
        invoiceNumber: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar NF pelo número
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.invoiceNumber, input.invoiceNumber))
        .limit(1);

      if (!invoice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `NF ${input.invoiceNumber} não encontrada`,
        });
      }

      if (invoice.pickingOrderId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Não é possível excluir NF vinculada a um pedido. Desvincule primeiro.",
        });
      }

      if (invoice.status !== "imported") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Não é possível excluir NF com status '${invoice.status}'`,
        });
      }

      // Excluir NF
      await db
        .delete(invoices)
        .where(eq(invoices.id, invoice.id));

      return {
        success: true,
        message: "Nota Fiscal excluída com sucesso",
      };
    }),

  // ============================================================================
  // ROMANEIOS
  // ============================================================================

  /**
   * Criar Romaneio
   */
  createManifest: tenantProcedure
    .input(
      z.object({
        carrierName: z.string(),
        orderIds: z.array(z.number()).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validar pedidos
      const orders = await db
        .select({
          id: pickingOrders.id,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          shippingStatus: pickingOrders.shippingStatus,
          tenantId: pickingOrders.tenantId,
        })
        .from(pickingOrders)
        .where(
          sql`${pickingOrders.id} IN (${sql.join(input.orderIds.map(id => sql`${id}`), sql`, `)})`
        );

      if (orders.length !== input.orderIds.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Alguns pedidos não foram encontrados" });
      }

      // Verificar se todos os pedidos têm NF vinculada via tabela N:N
      const linkedInvoiceRows = await db
        .select({
          pickingOrderId: invoicePickingOrders.pickingOrderId,
          invoiceId: invoicePickingOrders.invoiceId,
        })
        .from(invoicePickingOrders)
        .where(inArray(invoicePickingOrders.pickingOrderId, input.orderIds));

      const linkedOrderIds = new Set(linkedInvoiceRows.map(r => r.pickingOrderId));
      const ordersWithoutInvoice = orders.filter(o => !linkedOrderIds.has(o.id));
      if (ordersWithoutInvoice.length > 0) {
        throw new TRPCError({ 
          code: "BAD_REQUEST", 
          message: `Pedidos sem NF vinculada: ${ordersWithoutInvoice.map(o => o.customerOrderNumber).join(", ")}` 
        });
      }

      // Buscar NFs distintas vinculadas aos pedidos (via N:N)
      const linkedInvoiceIds = Array.from(new Set(linkedInvoiceRows.map(r => r.invoiceId)));
      const invoicesList = await db
        .select()
        .from(invoices)
        .where(inArray(invoices.id, linkedInvoiceIds));

      // Buscar volumes do Stage (totalVolumes registrado ao gerar etiquetas) para cada pedido
      const stageChecksByOrder = input.orderIds.length > 0
        ? await db
            .select({
              pickingOrderId: stageChecks.pickingOrderId,
              totalVolumes: stageChecks.totalVolumes,
            })
            .from(stageChecks)
            .where(
              sql`${stageChecks.pickingOrderId} IN (${sql.join(input.orderIds.map(id => sql`${id}`), sql`, `)}) AND ${stageChecks.status} = 'completed' AND ${stageChecks.totalVolumes} IS NOT NULL`
            )
            .orderBy(desc(stageChecks.completedAt))
        : [];

      // Mapa: pickingOrderId -> totalVolumes do Stage (usar o mais recente)
      const stageVolumesForManifest = new Map<number, number>();
      for (const sc of stageChecksByOrder) {
        if (!stageVolumesForManifest.has(sc.pickingOrderId) && sc.totalVolumes !== null) {
          stageVolumesForManifest.set(sc.pickingOrderId, sc.totalVolumes);
        }
      }

      // totalVolumes: somar volumes do Stage por pedido; fallback para divisão proporcional da NF
      // Contar pedidos por NF para o fallback
      const ordersCountPerInvoice = new Map<number, number>();
      for (const row of linkedInvoiceRows) {
        ordersCountPerInvoice.set(row.invoiceId, (ordersCountPerInvoice.get(row.invoiceId) ?? 0) + 1);
      }
      const totalVolumes = input.orderIds.reduce((sum, orderId) => {
        const stageVols = stageVolumesForManifest.get(orderId);
        if (stageVols !== undefined) return sum + stageVols;
        // Fallback: dividir volumes da NF proporcionalmente
        const link = linkedInvoiceRows.find(r => r.pickingOrderId === orderId);
        if (link) {
          const inv = invoicesList.find(i => i.id === link.invoiceId);
          const shareCount = ordersCountPerInvoice.get(link.invoiceId) ?? 1;
          return sum + Math.round((inv?.volumes ?? 0) / shareCount);
        }
        return sum;
      }, 0);

      // Usar tenantId do primeiro pedido (todos devem ser do mesmo cliente)
      const manifestTenantId = orders[0].tenantId;

      // Gerar número do romaneio
      const manifestNumber = `ROM-${Date.now()}`;

      // Criar romaneio
      const [manifest] = await db.insert(shipmentManifests).values({
        tenantId: manifestTenantId,
        manifestNumber,
        carrierName: input.carrierName,
        totalOrders: input.orderIds.length,
        totalInvoices: invoicesList.length,
        totalVolumes,
        status: "draft",
        createdBy: ctx.user.id,
      });

      const manifestId = Number(manifest.insertId);

      // Adicionar itens ao romaneio (via tabela N:N - um pedido pode ter uma NF)
      for (const orderId of input.orderIds) {
        const link = linkedInvoiceRows.find(r => r.pickingOrderId === orderId);
        if (link) {
          const stageVols = stageVolumesForManifest.get(orderId);
          const inv = invoicesList.find(i => i.id === link.invoiceId);
          const shareCount = ordersCountPerInvoice.get(link.invoiceId) ?? 1;
          const volsForItem = stageVols !== undefined
            ? stageVols
            : Math.round((inv?.volumes ?? 0) / shareCount);
          await db.insert(shipmentManifestItems).values({
            manifestId,
            pickingOrderId: orderId,
            invoiceId: link.invoiceId,
            volumes: volsForItem,
          });
        }
      }

      // Atualizar status dos pedidos e NFs
      await db
        .update(pickingOrders)
        .set({ shippingStatus: "in_manifest" })
        .where(
          sql`${pickingOrders.id} IN (${sql.join(input.orderIds.map(id => sql`${id}`), sql`, `)})`
        );

      await db
        .update(invoices)
        .set({ status: "in_manifest" })
        .where(
          sql`${invoices.pickingOrderId} IN (${sql.join(input.orderIds.map(id => sql`${id}`), sql`, `)})`
        );

      console.log(`[ROMANEIO] Romaneio ${manifestId} criado com ${input.orderIds.length} pedido(s).`);
      
      return { 
        success: true, 
        manifestId,
        manifestNumber,
        message: `Romaneio ${manifestNumber} criado com ${input.orderIds.length} pedido(s).` 
      };
    }),

  /**
   * Listar Romaneios
   */
  listManifests: tenantProcedure
    .input(
      z.object({
        status: z.enum(["draft", "ready", "collected", "shipped"]).optional(),
      }).optional()
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? null : effectiveTenantId;

      const conditions: any[] = [];

      if (tenantId !== null) {
        conditions.push(eq(shipmentManifests.tenantId, tenantId));
      }

      if (input?.status) {
        conditions.push(eq(shipmentManifests.status, input.status));
      }

      const manifests = await db
        .select()
        .from(shipmentManifests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(shipmentManifests.createdAt));

      return manifests;
    }),

  /**
   * Finalizar Expedição (Romaneio)
   */
  finalizeManifest: tenantProcedure
    .input(z.object({ manifestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar romaneio
      const [manifest] = await db
        .select()
        .from(shipmentManifests)
        .where(eq(shipmentManifests.id, input.manifestId))
        .limit(1);

      if (!manifest) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Romaneio não encontrado" });
      }

      // Buscar itens do romaneio
      const items = await db
        .select()
        .from(shipmentManifestItems)
        .where(eq(shipmentManifestItems.manifestId, input.manifestId));

      const orderIds = items.map(item => item.pickingOrderId);

      // Buscar tenant do romaneio para verificar intraHospitalEnabled
      const [manifestTenant] = await db
        .select({ intraHospitalEnabled: tenants.intraHospitalEnabled })
        .from(tenants)
        .where(eq(tenants.id, manifest.tenantId))
        .limit(1);

      const isIntraHospital = manifestTenant?.intraHospitalEnabled ?? false;

      // ===== BAIXA DEFINITIVA DE ESTOQUE NA ZONA EXP =====
      // Ocorre SEMPRE, independente de ser fluxo intra-hospitalar ou padrão
      console.log(`[EXPEDIÇÃO] Iniciando baixa definitiva de estoque para ${orderIds.length} pedido(s)... (intraHospital=${isIntraHospital})`);

      for (const orderId of orderIds) {
        // Buscar pedido
        const [pickingOrder] = await db
          .select()
          .from(pickingOrders)
          .where(eq(pickingOrders.id, orderId))
          .limit(1);

        if (!pickingOrder) continue;

        // Buscar Stage concluído para este pedido
        const [stageCheck] = await db
          .select()
          .from(stageChecks)
          .where(
            and(
              eq(stageChecks.pickingOrderId, orderId),
              eq(stageChecks.status, 'completed')
            )
          )
          .orderBy(desc(stageChecks.completedAt))
          .limit(1);

        if (!stageCheck) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Pedido ${pickingOrder.customerOrderNumber} não possui conferência Stage concluída`,
          });
        }

        // Buscar itens conferidos no Stage
        const checkedItems = await db
          .select()
          .from(stageCheckItems)
          .where(eq(stageCheckItems.stageCheckId, stageCheck.id));

        for (const item of checkedItems) {
          // Buscar TODOS os registros de inventory na zona EXP para este produto/tenant
          // (mesma lógica de busca usada ao reservar — por warehouseZones.code = 'EXP')
          const expInventory = await db
            .select({
              id: inventory.id,
              quantity: inventory.quantity,
              reservedQuantity: inventory.reservedQuantity,
              locationId: inventory.locationId,
              productId: inventory.productId,
              batch: inventory.batch,
            })
            .from(inventory)
            .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
            .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
            .where(
              and(
                eq(inventory.productId, item.productId),
                eq(inventory.tenantId, pickingOrder.tenantId),
                eq(warehouseZones.code, "EXP"),
                sql`${inventory.quantity} > 0`
              )
            );

          let remainingToShip = item.checkedQuantity;

          for (const inv of expInventory) {
            if (remainingToShip <= 0) break;

            const quantityToShip = Math.min(remainingToShip, inv.quantity);
            const newQuantity = inv.quantity - quantityToShip;
            // Zerar reservedQuantity proporcional ao que está sendo baixado
            const newReservedQuantity = Math.max(0, inv.reservedQuantity - quantityToShip);

            if (newQuantity > 0) {
              // Baixa parcial: decrementar quantity e ajustar reservedQuantity
              await db
                .update(inventory)
                .set({
                  quantity: newQuantity,
                  reservedQuantity: newReservedQuantity,
                })
                .where(eq(inventory.id, inv.id));
            } else {
              // Baixa total: remover registro do inventory
              await db
                .delete(inventory)
                .where(eq(inventory.id, inv.id));
              await updateLocationStatus(inv.locationId);
            }

            // Registrar movimentação de saída (rastreabilidade ANVISA)
            await db.insert(inventoryMovements).values({
              productId: inv.productId,
              batch: inv.batch,
              fromLocationId: inv.locationId,
              toLocationId: null,
              quantity: quantityToShip,
              movementType: "picking",
              referenceType: "shipment_manifest",
              referenceId: input.manifestId,
              performedBy: ctx.user.id,
              notes: `Baixa definitiva ao finalizar romaneio ${manifest.manifestNumber} - Pedido ${pickingOrder.customerOrderNumber}`,
              tenantId: pickingOrder.tenantId,
              conversionSource: "manual",
            });

            remainingToShip -= quantityToShip;
            console.log(`[EXPEDIÇÃO] Baixa: produto ${item.productId}, -${quantityToShip} un (inv.id=${inv.id}, saldo restante=${newQuantity})`);
          }

          if (remainingToShip > 0) {
            console.warn(`[EXPEDIÇÃO] AVISO: Estoque insuficiente na zona EXP para produto ${item.productSku}. Faltam ${remainingToShip} un. Prosseguindo...`);
          }
        }
      }
      console.log(`[EXPEDIÇÃO] Baixa definitiva concluída com sucesso!`);
      // ===== FIM DA BAIXA DEFINITIVA =====

      // ===== LIMPEZA: REMOVER POSIÇÕES DE ESTOQUE ZERADAS =====
      // Após a expedição, deletar todos os registros de inventory com quantity=0
      // para evitar posições fantasmas na consulta de estoque.
      // Escopo: apenas os tenantIds dos pedidos expedidos neste romaneio.
      // Coletar tenantIds dos pedidos expedidos (orderIds já foi montado acima)
      const expedidosTenantIds = Array.from(
        new Set(
          (await db
            .select({ tenantId: pickingOrders.tenantId })
            .from(pickingOrders)
            .where(inArray(pickingOrders.id, orderIds))
          ).map(r => r.tenantId).filter((t): t is number => t !== null)
        )
      );
      if (expedidosTenantIds.length > 0) {
        // Coletar locationIds afetados ANTES de deletar
        const affectedLocations = await db
          .select({ locationId: inventory.locationId })
          .from(inventory)
          .where(
            and(
              sql`${inventory.quantity} <= 0`,
              inArray(inventory.tenantId, expedidosTenantIds)
            )
          );
        const affectedLocationIds = Array.from(new Set(affectedLocations.map(r => r.locationId).filter((id): id is number => id !== null && id !== undefined)));

        await db
          .delete(inventory)
          .where(
            and(
              sql`${inventory.quantity} <= 0`,
              inArray(inventory.tenantId, expedidosTenantIds)
            )
          );
        console.log(`[EXPEDIÇÃO] Limpeza: removidas posições de estoque zeradas para tenant(s) ${expedidosTenantIds.join(', ')}`);

        // ✅ Sincronizar status dos endereços afetados
        for (const locId of affectedLocationIds) {
          await updateLocationStatus(locId);
        }
        console.log(`[EXPEDIÇÃO] Status de ${affectedLocationIds.length} endereço(s) sincronizado(s) após expedição.`);
      }
      // ===== FIM DA LIMPEZA =====

      // Atualizar status do romaneio
      // Intra-hospitalar: 'collected' (entrega interna ainda pendente)
      // Padrão: 'shipped' (expedição definitiva)
      const finalManifestStatus = isIntraHospital ? "collected" : "shipped";
      const finalOrderStatus = isIntraHospital ? "collected" : "shipped";
      const finalOrderShippingStatus = isIntraHospital ? "collected" : "shipped";

      await db
        .update(shipmentManifests)
        .set({
          status: finalManifestStatus,
          shippedAt: new Date(),
        })
        .where(eq(shipmentManifests.id, input.manifestId));

      // Atualizar status dos pedidos
      await db
        .update(pickingOrders)
        .set({
          status: finalOrderStatus,
          shippingStatus: finalOrderShippingStatus,
          shippedAt: new Date(),
        })
        .where(
          sql`${pickingOrders.id} IN (${sql.join(orderIds.map(id => sql`${id}`), sql`, `)})`
        );

      // Atualizar status das NFs
      await db
        .update(invoices)
        .set({ status: "shipped" })
        .where(
          sql`${invoices.pickingOrderId} IN (${sql.join(orderIds.map(id => sql`${id}`), sql`, `)})`
        );

      const msg = isIntraHospital
        ? `Romaneio ${manifest.manifestNumber} finalizado. Baixa de estoque realizada. ${orderIds.length} pedido(s) marcados como Coletado para entrega intra-hospitalar.`
        : `Romaneio ${manifest.manifestNumber} expedido com sucesso`;

      return { 
        success: true,
        intraHospital: isIntraHospital,
        message: msg,
      };
    }),

  // Gerar PDF do romaneio
  generateManifestPDF: tenantProcedure
    .input(z.object({ manifestId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar romaneio
      const [manifest] = await db
        .select()
        .from(shipmentManifests)
        .where(eq(shipmentManifests.id, input.manifestId))
        .limit(1);

      if (!manifest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Romaneio não encontrado",
        });
      }

      // Buscar tenant (remetente)
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, manifest.tenantId))
        .limit(1);

      // Buscar itens do romaneio com pedidos e NFs (via tabela N:N invoicePickingOrders)
      const rawItems = await db
        .select({
          orderId: shipmentManifestItems.pickingOrderId,
          orderNumber: pickingOrders.customerOrderNumber,
          invoiceId: shipmentManifestItems.invoiceId,
        })
        .from(shipmentManifestItems)
        .innerJoin(pickingOrders, eq(shipmentManifestItems.pickingOrderId, pickingOrders.id))
        .where(eq(shipmentManifestItems.manifestId, input.manifestId));

      // Buscar dados das NFs distintas
      const invoiceIds = Array.from(new Set(rawItems.map(r => r.invoiceId).filter((id): id is number => id !== null && id !== undefined)));
      const invoiceData = invoiceIds.length > 0
        ? await db.select().from(invoices).where(inArray(invoices.id, invoiceIds))
        : [];
      const invoiceMap = new Map(invoiceData.map(inv => [inv.id, inv]));

      // Buscar volumes do Stage (totalVolumes registrado ao gerar etiquetas) para cada pedido
      const orderIds = rawItems.map(r => r.orderId);
      const stageCheckData = orderIds.length > 0
        ? await db
            .select({
              pickingOrderId: stageChecks.pickingOrderId,
              totalVolumes: stageChecks.totalVolumes,
            })
            .from(stageChecks)
            .where(
              sql`${stageChecks.pickingOrderId} IN (${sql.join(orderIds.map(id => sql`${id}`), sql`, `)}) AND ${stageChecks.status} = 'completed' AND ${stageChecks.totalVolumes} IS NOT NULL`
            )
            .orderBy(desc(stageChecks.completedAt))
        : [];

      // Mapa: pickingOrderId -> totalVolumes do Stage (usar o mais recente)
      const stageVolumesMap = new Map<number, number>();
      for (const sc of stageCheckData) {
        if (!stageVolumesMap.has(sc.pickingOrderId) && sc.totalVolumes !== null) {
          stageVolumesMap.set(sc.pickingOrderId, sc.totalVolumes);
        }
      }

      // Contar quantos pedidos compartilham cada NF para distribuir o PESO proporcionalmente
      const ordersPerInvoice = new Map<number, number>();
      for (const r of rawItems) {
        if (r.invoiceId !== null && r.invoiceId !== undefined) {
          ordersPerInvoice.set(r.invoiceId, (ordersPerInvoice.get(r.invoiceId) ?? 0) + 1);
        }
      }

      const items = rawItems.map(r => {
        const inv = r.invoiceId ? invoiceMap.get(r.invoiceId) : undefined;
        const shareCount = r.invoiceId ? (ordersPerInvoice.get(r.invoiceId) ?? 1) : 1;
        const totalPesoNF = parseFloat(inv?.pesoB ?? "0");
        // Volumes: buscar do Stage; fallback para divisão proporcional da NF
        const stageVolumes = stageVolumesMap.get(r.orderId);
        const volumesPorPedido = stageVolumes !== undefined
          ? stageVolumes
          : Math.round((inv?.volumes ?? 0) / shareCount);
        // Peso: dividir proporcionalmente entre os pedidos da mesma NF
        const pesoPorPedido = totalPesoNF / shareCount;
        return {
          orderId: r.orderId,
          orderNumber: r.orderNumber,
          invoiceId: r.invoiceId,
          invoiceNumber: inv?.invoiceNumber ?? null,
          customerName: inv?.customerName ?? null,
          customerCity: inv?.customerCity ?? null,
          customerState: inv?.customerState ?? null,
          volumes: volumesPorPedido,
          pesoB: pesoPorPedido.toFixed(2),
          totalValue: inv?.totalValue ?? null,
        };
      });

      // Totais reais:
      // - Volumes: somar os volumes do Stage por pedido (ou fallback da NF sem duplicação)
      const totalVolumesReal = items.reduce((sum, item) => sum + item.volumes, 0);
      // - Peso: somar apenas uma vez por NF distinta
      const totalPesoReal = Array.from(invoiceMap.values()).reduce((sum, inv) => sum + parseFloat(inv.pesoB ?? "0"), 0);

      // Retornar dados para geração de PDF
      return {
        manifest: {
          number: manifest.manifestNumber,
          createdAt: manifest.createdAt,
          carrierName: manifest.carrierName,
          totalOrders: manifest.totalOrders,
          totalInvoices: manifest.totalInvoices,
          totalVolumes: totalVolumesReal,
        },
        tenant: {
          name: tenant?.name || "N/A",
          cnpj: tenant?.cnpj || "N/A",
        },
        totalWeight: totalPesoReal,
        items: items.map(item => ({
          orderNumber: item.orderNumber,
          invoiceNumber: item.invoiceNumber || "N/A",
          customerName: item.customerName || "N/A",
          customerCity: item.customerCity || "",
          customerState: item.customerState || "",
          volumes: item.volumes,
          weight: parseFloat(item.pesoB)
        })),
      };
    }),

  /**
   * Excluir múltiplos romaneios
   */
  deleteMany: tenantProcedure
    .input(
      z.object({
        ids: z.array(z.number()).min(1, "Selecione pelo menos um romaneio"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verificar se algum romaneio está finalizado
      const manifests = await db
        .select({ id: shipmentManifests.id, status: shipmentManifests.status })
        .from(shipmentManifests)
        .where(inArray(shipmentManifests.id, input.ids));

      const shippedManifests = manifests.filter(m => m.status === "shipped");
      if (shippedManifests.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Não é possível excluir romaneios já expedidos. ${shippedManifests.length} romaneio(s) já foram expedidos.`,
        });
      }

      // Buscar itens dos romaneios para liberar pedidos
      const manifestItems = await db
        .select({ pickingOrderId: shipmentManifestItems.pickingOrderId })
        .from(shipmentManifestItems)
        .where(inArray(shipmentManifestItems.manifestId, input.ids));

      const orderIds = Array.from(new Set(manifestItems.map(item => item.pickingOrderId)));

      // Excluir itens dos romaneios
      await db
        .delete(shipmentManifestItems)
        .where(inArray(shipmentManifestItems.manifestId, input.ids));

      // Excluir romaneios
      await db
        .delete(shipmentManifests)
        .where(inArray(shipmentManifests.id, input.ids));

      // Atualizar status dos pedidos: staged + shippingStatus='invoice_linked'
      // (NF ainda vinculada, mas fora de romaneio — volta para fila de expedição)
      if (orderIds.length > 0) {
        await db
          .update(pickingOrders)
          .set({ status: "staged", shippingStatus: "invoice_linked" })
          .where(inArray(pickingOrders.id, orderIds));
      }

      // Restaurar status das NFs vinculadas aos pedidos para 'linked'
      if (orderIds.length > 0) {
        await db
          .update(invoices)
          .set({ status: "linked" })
          .where(inArray(invoices.pickingOrderId, orderIds));
      }

      // Reverter ondas (pickingWaves) vinculadas aos pedidos para 'staged'
      if (orderIds.length > 0) {
        const waveLinks = await db
          .select({ waveId: pickingOrders.waveId })
          .from(pickingOrders)
          .where(inArray(pickingOrders.id, orderIds));

        const waveIds = Array.from(new Set(
          waveLinks.map(w => w.waveId).filter((id): id is number => id !== null && id !== undefined)
        ));

        if (waveIds.length > 0) {
          await db
            .update(pickingWaves)
            .set({ status: "staged" })
            .where(inArray(pickingWaves.id, waveIds));
        }
      }

      // NOTA: Reservas de estoque são gerenciadas pelo unlinkInvoice.
      // O cancelamento do romaneio NÃO libera reservas — apenas reverte o status dos pedidos.

      return {
        success: true,
        deletedCount: input.ids.length,
        releasedOrders: orderIds.length,
        message: `${input.ids.length} romaneio(s) cancelado(s). ${orderIds.length} pedido(s) retornados para fila de expedição.`,
      };
    }),

  /**
   * Cancelar expedição de pedido
   * Retorna pedido para status "picked" para nova conferência no Stage
   */
  cancelShipping: tenantProcedure
    .input(
      z.object({
        orderId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Buscar pedido
      const [order] = await db
        .select()
        .from(pickingOrders)
        .where(eq(pickingOrders.id, input.orderId))
        .limit(1);

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pedido não encontrado",
        });
      }

      // Validar tenant
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const tenantId = isGlobalAdmin ? null : effectiveTenantId;
      if (tenantId !== null && order.tenantId !== tenantId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Pedido não pertence ao tenant atual",
        });
      }

      // Validar status (só pode cancelar se estiver em "staged")
      if (order.status !== "staged") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pedido deve estar com status "staged" para ser cancelado. Status atual: ${order.status}`,
        });
      }

      // Verificar se pedido está em romaneio
      const manifestItems = await db
        .select()
        .from(shipmentManifestItems)
        .where(eq(shipmentManifestItems.pickingOrderId, input.orderId))
        .limit(1);

      if (manifestItems.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Pedido está em romaneio. Cancele o romaneio primeiro.",
        });
      }

      // Desvincular NF (se houver)
      const linkedInvoices = await db
        .select()
        .from(invoices)
        .where(eq(invoices.pickingOrderId, input.orderId));

      if (linkedInvoices.length > 0) {
        await db
          .update(invoices)
          .set({
            pickingOrderId: null,
            status: "imported",
            linkedAt: null,
          })
          .where(eq(invoices.pickingOrderId, input.orderId));

        console.log(`[CancelShipping] Desvinculado ${linkedInvoices.length} NF(s) do pedido ${order.orderNumber}`);
      }

      // ========== ESTORNO DE ESTOQUE ==========
      // Buscar movimentações do pedido (EXP → Armazenagem)
      const movements = await db
        .select({
          id: inventoryMovements.id,
          productId: inventoryMovements.productId,
          batch: inventoryMovements.batch,
          fromLocationId: inventoryMovements.fromLocationId,
          toLocationId: inventoryMovements.toLocationId,
          quantity: inventoryMovements.quantity,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.referenceType, "picking_order"),
            eq(inventoryMovements.referenceId, input.orderId),
            eq(inventoryMovements.movementType, "picking")
          )
        );

      console.log(`[CancelShipping] Encontradas ${movements.length} movimentação(ões) para estornar do pedido ${order.orderNumber}`);

      // Reverter cada movimentação: EXP → Endereço de armazenagem
      for (const movement of movements) {
        // Validar IDs de localização
        if (!movement.fromLocationId || !movement.toLocationId) {
          console.warn(`[CancelShipping] Movimentação ${movement.id} sem localizações válidas, pulando...`);
          continue;
        }

        // 1. Subtrair do endereço EXP (destino original)
        const expConditions = [
          eq(inventory.locationId, movement.toLocationId as number),
          eq(inventory.productId, movement.productId),
          eq(inventory.tenantId, order.tenantId),
        ];
        
        if (movement.batch) {
          expConditions.push(eq(inventory.batch, movement.batch));
        } else {
          expConditions.push(isNull(inventory.batch));
        }

        const [expInventory] = await db
          .select()
          .from(inventory)
          .where(and(...expConditions))
          .limit(1);

        if (!expInventory) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Estoque não encontrado no endereço de expedição para produto ${movement.productId}`,
          });
        }

        if (expInventory.quantity < movement.quantity) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Estoque insuficiente no endereço de expedição. Disponível: ${expInventory.quantity}, Necessário: ${movement.quantity}`,
          });
        }

        const newExpQuantity = expInventory.quantity - movement.quantity;
        if (newExpQuantity <= 0) {
          // Remover registro se quantidade zerou (inventory deve conter apenas registros com saldo)
          await db.delete(inventory).where(eq(inventory.id, expInventory.id));
          // ✅ Sincronizar status do endereço após baixa total
          await updateLocationStatus(expInventory.locationId);
        } else {
          await db
            .update(inventory)
            .set({ quantity: newExpQuantity })
            .where(eq(inventory.id, expInventory.id));
        }

        // 2. Devolver para endereço de armazenagem (origem original)
        const storageConditions = [
          eq(inventory.locationId, movement.fromLocationId as number),
          eq(inventory.productId, movement.productId),
          eq(inventory.tenantId, order.tenantId),
        ];
        
        if (movement.batch) {
          storageConditions.push(eq(inventory.batch, movement.batch));
        } else {
          storageConditions.push(isNull(inventory.batch));
        }

        const [storageInventory] = await db
          .select()
          .from(inventory)
          .where(and(...storageConditions))
          .limit(1);

        if (storageInventory) {
          // Adicionar ao estoque existente
          await db
            .update(inventory)
            .set({
              quantity: storageInventory.quantity + movement.quantity,
            })
            .where(eq(inventory.id, storageInventory.id));
        } else {
          // Buscar SKU do produto para gerar uniqueCode
          const product = await db.select({ sku: products.sku })
            .from(products)
            .where(eq(products.id, movement.productId))
            .limit(1);

          // Buscar zona do endereço de armazenagem (origem da movimentação)
          const storageLocation = await db.select({ zoneCode: warehouseZones.code })
            .from(warehouseLocations)
            .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
            .where(eq(warehouseLocations.id, movement.fromLocationId))
            .limit(1);

          const { getUniqueCode } = await import("./utils/uniqueCode");

          // Recriar registro de estoque no endereço de armazenagem
          await db.insert(inventory).values({
            locationId: movement.fromLocationId,
            productId: movement.productId,
            batch: movement.batch || null,
            expiryDate: expInventory.expiryDate || null,
            quantity: movement.quantity,
            tenantId: order.tenantId,
            status: "available",
            uniqueCode: getUniqueCode(product[0]?.sku || "", movement.batch || null), // ✅ Adicionar uniqueCode
            locationZone: storageLocation[0]?.zoneCode || null, // ✅ Adicionar locationZone
          });
        }

        // 3. Recriar reserva
        // Buscar ID do inventário após inserção/atualização
        let inventoryIdForReservation = storageInventory?.id;
        
        if (!inventoryIdForReservation) {
          const newInventoryConditions = [
            eq(inventory.locationId, movement.fromLocationId as number),
            eq(inventory.productId, movement.productId),
            eq(inventory.tenantId, order.tenantId),
          ];
          
          if (movement.batch) {
            newInventoryConditions.push(eq(inventory.batch, movement.batch));
          } else {
            newInventoryConditions.push(isNull(inventory.batch));
          }

          const [newInventory] = await db
            .select({ id: inventory.id })
            .from(inventory)
            .where(and(...newInventoryConditions))
            .limit(1);
          
          inventoryIdForReservation = newInventory?.id;
        }
        
        if (!inventoryIdForReservation) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Não foi possível encontrar inventário para recriar reserva do produto ${movement.productId}`,
          });
        }
        
        // NOTA: pickingAllocations serão recriadas automaticamente ao gerar nova onda

        // 4. Registrar movimentação reversa no histórico
        await db.insert(inventoryMovements).values({
          productId: movement.productId,
          batch: movement.batch,
          fromLocationId: movement.toLocationId, // EXP
          toLocationId: movement.fromLocationId, // Armazenagem
          quantity: movement.quantity,
          movementType: "adjustment",
          referenceType: "picking_order",
          referenceId: input.orderId,
          performedBy: ctx.user.id,
          notes: `Estorno automático - Expedição cancelada do pedido ${order.customerOrderNumber || order.orderNumber}`,
          tenantId: order.tenantId,
          conversionSource: "manual", // ANVISA: estorno de expedição cancelada
        });
      }

      console.log(`[CancelShipping] Estorno de estoque concluído: ${movements.length} movimentação(ões) revertidas`);

      // Cancelar conferência de stage
      const stageCheckList = await db
        .select()
        .from(stageChecks)
        .where(
          and(
            eq(stageChecks.pickingOrderId, input.orderId),
            eq(stageChecks.status, "completed")
          )
        );

      if (stageCheckList.length > 0) {
        // Marcar conferência como divergente (não há status "cancelled" no schema)
        await db
          .update(stageChecks)
          .set({ 
            status: "divergent",
            notes: sql`CONCAT(COALESCE(${stageChecks.notes}, ''), '\n[CANCELADO] Expedição cancelada. Pedido retornado para nova conferência.')`
          })
          .where(
            and(
              eq(stageChecks.pickingOrderId, input.orderId),
              eq(stageChecks.status, "completed")
            )
          );

        console.log(`[CancelShipping] Marcado ${stageCheckList.length} conferência(s) de stage como divergente do pedido ${order.orderNumber}`);
      }

      // Alterar status do pedido para "picked"
      await db
        .update(pickingOrders)
        .set({
          status: "picked",
          shippingStatus: null,
        })
        .where(eq(pickingOrders.id, input.orderId));

      return {
        success: true,
        message: `Pedido ${order.customerOrderNumber || order.orderNumber} retornado para nova conferência no Stage`,
      };
    }),

  // ============================================================================
  // MOTOR DE DE/PARA — Procedures de Vínculo Manual de SKU
  // ============================================================================

  /**
   * Retorna os itens do pedido para preencher o Select do Modal de Vínculo Manual.
   * Usado pelo frontend quando a linkInvoiceToOrder retorna SKU_MAPPING_REQUIRED.
   */
  getOrderItemsForMapping: tenantProcedure
    .input(z.object({ orderNumber: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [order] = await db
        .select({ id: pickingOrders.id, tenantId: pickingOrders.tenantId })
        .from(pickingOrders)
        .where(eq(pickingOrders.customerOrderNumber, input.orderNumber))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: `Pedido ${input.orderNumber} não encontrado` });

      assertSameTenant(ctx.effectiveTenantId, order.tenantId, ctx.isGlobalAdmin);

      const items = await db
        .select({
          productId: pickingOrderItems.productId,
          sku: products.sku,
          internalCode: sql<string>`COALESCE(${productTenantMappings.internalCode}, ${products.internalCode})`,
          description: products.description,
          batch: pickingOrderItems.batch,
          requestedQuantity: pickingOrderItems.requestedQuantity,
          requestedUM: pickingOrderItems.requestedUM,
        })
        .from(pickingOrderItems)
        .leftJoin(products, eq(pickingOrderItems.productId, products.id))
        .leftJoin(
          productTenantMappings,
          and(eq(productTenantMappings.productId, pickingOrderItems.productId), eq(productTenantMappings.tenantId, order.tenantId))
        )
        .where(eq(pickingOrderItems.pickingOrderId, order.id));

      return items;
    }),

  /**
   * Persiste o vínculo manual De/Para: salva internalCode no produto e registra audit log.
   * Após confirmar, o frontend deve chamar linkInvoiceToOrder novamente — o match será automático.
   */
  confirmSkuMapping: tenantProcedure
    .input(
      z.object({
        mappings: z.array(
          z.object({
            productId: z.number(),       // ID do produto no pedido
            nfeCodigo: z.string(),       // Código que veio na NF (vira internalCode)
          })
        ),
        orderNumber: z.string(),         // Para audit log
        invoiceNumber: z.string(),       // Para audit log
        orderTenantId: z.number().optional(), // tenantId do pedido (pode diferir do usuário logado)
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const results: { productId: number; sku: string; internalCode: string }[] = [];
      // Usar o tenantId do pedido quando fornecido (evita mismatch entre tenant do usuário e tenant do cliente)
      const mappingTenantId = input.orderTenantId ?? ctx.effectiveTenantId;

      for (const mapping of input.mappings) {
        // Buscar produto e validar
        const [product] = await db
          .select({ id: products.id, sku: products.sku })
          .from(products)
          .where(eq(products.id, mapping.productId))
          .limit(1);

        if (!product) throw new TRPCError({ code: "NOT_FOUND", message: `Produto ID ${mapping.productId} não encontrado` });

        // Verificar conflito: outro produto já usa este internalCode neste tenant (no productTenantMappings)
        const [conflict] = await db
          .select({ id: productTenantMappings.productId, sku: products.sku })
          .from(productTenantMappings)
          .innerJoin(products, eq(products.id, productTenantMappings.productId))
          .where(
            and(
              eq(productTenantMappings.tenantId, mappingTenantId),
              eq(productTenantMappings.internalCode, mapping.nfeCodigo),
              sql`${productTenantMappings.productId} != ${mapping.productId}`
            )
          )
          .limit(1);

        if (conflict) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Código interno "${mapping.nfeCodigo}" já está vinculado ao SKU "${conflict.sku}" neste cliente. Remova o vínculo existente antes de reatribuir.`,
          });
        }

        // Persistir internalCode no productTenantMappings (por tenant do pedido)
        await db.insert(productTenantMappings).values({
          productId: mapping.productId,
          tenantId: mappingTenantId,
          internalCode: mapping.nfeCodigo,
          customerCode: mapping.nfeCodigo,
        }).onDuplicateKeyUpdate({ set: { internalCode: mapping.nfeCodigo, customerCode: mapping.nfeCodigo } });
        // Regra: customerCode = internalCode — atualizar também na tabela products
        await db.update(products).set({ internalCode: mapping.nfeCodigo, customerCode: mapping.nfeCodigo } as any).where(eq(products.id, mapping.productId));

        // Audit log via inventoryMovements.notes (registro leve, sem movimentação de estoque)
        await db.insert(inventoryMovements).values({
          tenantId: mappingTenantId,
          productId: mapping.productId,
          batch: null,
          quantity: 0,
          movementType: "adjustment",
          referenceType: "invoice",
          referenceId: 0,
          performedBy: ctx.user.id,
          notes: `[De/Para] SKU "${product.sku}" vinculado ao código interno "${mapping.nfeCodigo}" pelo usuário ${ctx.user.name || ctx.user.id} — NF ${input.invoiceNumber} / Pedido ${input.orderNumber}`,
          conversionSource: "manual",
        });

        results.push({ productId: mapping.productId, sku: product.sku ?? "", internalCode: mapping.nfeCodigo });

        console.log(`[De/Para] Vínculo persistido: SKU "${product.sku}" → internalCode "${mapping.nfeCodigo}" (tenant ${mappingTenantId}, user ${ctx.user.id})`);
      }

      return {
        success: true,
        message: `${results.length} vínculo(s) De/Para salvo(s) com sucesso. Tente vincular a NF novamente.`,
        mappings: results,
      };
    }),
});
