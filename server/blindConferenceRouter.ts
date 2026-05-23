import { protectedProcedure, router } from "./_core/trpc";
import { tenantProcedure, assertSameTenant } from "./_core/tenantGuard";
import { getDb } from "./db";
import { 
  blindConferenceSessions, 
  blindConferenceItems,
  labelAssociations, 
  labelReadings, 
  blindConferenceAdjustments,
  receivingOrders,
  receivingOrderItems,
  products,
  inventory,
  inventoryMovements,
  warehouseLocations,
  warehouseZones,
  nonConformities,
  systemUsers,
  auditLogs,
  productConversions,
} from "../drizzle/schema";
import crypto from "crypto";
import { eq, and, or, desc, sql, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getUniqueCode } from "./utils/uniqueCode";

/** Extrai a parte YYYY-MM-DD de um Date ou string, ignorando timezone.
 * Usa a representação UTC do Date para evitar que o offset local mude o dia.
 * Retorna null se o valor for nulo/undefined.
 */
function toDateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") {
    // Rejeitar strings que não parecem datas válidas (ex: lotes como "22D10LB112")
    const trimmed = d.trim();
    if (!trimmed) return null;
    // Aceitar apenas formatos: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, YYYY-MM-DD HH:MM:SS
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
    const datePart = trimmed.split("T")[0].split(" ")[0];
    // Validar que é uma data real
    const parsed = new Date(datePart + "T00:00:00Z");
    if (isNaN(parsed.getTime())) return null;
    return datePart;
  }
  // É um objeto Date — usar UTC para evitar que offset local mude o dia
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Helper: Busca o tenantId real da ordem de recebimento vinculada à sessão de conferência.
 * Usar este valor em todos os filtros de blindConferenceItems e labelAssociations,
 * pois os dados são gravados com o tenantId da ORDEM, não do usuário logado.
 */
async function getOrderTenantId(db: Awaited<ReturnType<typeof getDb>>, conferenceId: number): Promise<number> {
  if (!db) throw new Error("Database not available");
  const [session] = await db.select({ receivingOrderId: blindConferenceSessions.receivingOrderId })
    .from(blindConferenceSessions)
    .where(eq(blindConferenceSessions.id, conferenceId))
    .limit(1);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Sessão de conferência não encontrada" });
  const [order] = await db.select({ tenantId: receivingOrders.tenantId })
    .from(receivingOrders)
    .where(eq(receivingOrders.id, session.receivingOrderId))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Ordem de recebimento não encontrada" });
  return order.tenantId;
}

export const blindConferenceRouter = router({
  /**
   * 1. Iniciar Sessão de Conferência Cega
   */
  start: tenantProcedure
    .input(z.object({
      receivingOrderId: z.number(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;
      console.log("[start] Tenant Ativo:", effectiveTenantId, "| isGlobalAdmin:", isGlobalAdmin);

      // Verificar se ordem existe
      const order = await db.select().from(receivingOrders).where(eq(receivingOrders.id, input.receivingOrderId)).limit(1);
      if (order.length === 0) {
        throw new Error("Ordem de recebimento não encontrada");
      }

      // ✅ USAR tenantId DA ORDEM, NÃO DO USUÁRIO
      const orderTenantId = order[0].tenantId;

      // Verificar se já existe sessão ativa para esta ordem
      const existingSession = await db.select()
        .from(blindConferenceSessions)
        .where(
          and(
            eq(blindConferenceSessions.receivingOrderId, input.receivingOrderId),
            eq(blindConferenceSessions.status, "active")
          )
        )
        .limit(1);

      if (existingSession.length > 0) {
        return {
          success: true,
          sessionId: existingSession[0].id,
          message: "Sessão já existe e foi retomada"
        };
      }

      // Criar nova sessão
      await db.insert(blindConferenceSessions).values({
        tenantId: orderTenantId,
        receivingOrderId: input.receivingOrderId,
        startedBy: userId,
        status: "active",
      });

      // Buscar sessão criada
      const newSession = await db.select()
        .from(blindConferenceSessions)
        .where(
          and(
            eq(blindConferenceSessions.receivingOrderId, input.receivingOrderId),
            eq(blindConferenceSessions.status, "active")
          )
        )
        .orderBy(desc(blindConferenceSessions.id))
        .limit(1);

      return {
        success: true,
        sessionId: newSession[0].id,
        message: "Sessão iniciada com sucesso"
      };
    }),

  /**
   * 2. Ler Etiqueta (REFATORADO)
   * Regra: 1 etiqueta = 1 produto + 1 lote específico (ou sem lote)
   * Busca etiqueta global e registra progresso em blindConferenceItems
   */
  readLabel: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      labelCode: z.string(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;

      // 🔑 0. BUSCAR SESSÃO DE CONFERÊNCIA PRIMEIRO (ESCOPO RAIZ)
      // ✅ Busca apenas por ID: a sessão é criada com orderTenantId (não effectiveTenantId)
      const conferenceSession = await db.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);
      
      if (conferenceSession.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sessão de conferência não encontrada"
        });
      }
      
      const conference = conferenceSession[0];
      console.log("[readLabel] Conference encontrada:", conference.id, "| receivingOrderId:", conference.receivingOrderId);

      // ✅ BUSCAR receivingOrder PARA OBTER tenantId CORRETO
      const receivingOrder = await db.select()
        .from(receivingOrders)
        .where(eq(receivingOrders.id, conference.receivingOrderId))
        .limit(1);
      
      if (receivingOrder.length === 0) {
        throw new Error("Ordem de recebimento não encontrada");
      }
      
      const orderTenantId = receivingOrder[0].tenantId;
      console.log("[readLabel] Usando tenantId da ordem:", orderTenantId);

      // 1. BUSCA GLOBAL DA ETIQUETA (Identidade Permanente)
      // labelAssociations é cadastro global: buscar apenas por labelCode, sem filtro de tenant
      const label = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      // Se etiqueta não existe no sistema
      if (label.length === 0) {
        return {
          isNewLabel: true,
          association: null
        };
      }

      const labelData = label[0];

      // 2. DETERMINAR productId CORRETO PARA blindConferenceItems
      // A labelAssociation pode ter productId de outro tenant (produto duplicado por tenant).
      // Precisamos usar o productId do receivingOrderItem do tenant da ordem para que
      // prepareFinish/finish consigam casar as leituras corretamente.
      let effectiveProductId = labelData.productId;
      {
        // Buscar o produto pelo SKU dentro do tenant da ordem
        const labelSku = await db.select({ sku: products.sku })
          .from(products)
          .where(eq(products.id, labelData.productId))
          .limit(1);
        // Produtos agora são globais — effectiveProductId = labelData.productId (sem ajuste de tenant)
        if (labelSku[0]) {
          effectiveProductId = labelData.productId;
        }
      }

      // 2. UPSERT ATÔMICO NA TABELA DE ITENS DA CONFERÊNCIA
      await db.insert(blindConferenceItems)
        .values({
          conferenceId: input.conferenceId,
          productId: effectiveProductId,
          batch: labelData.batch || "",
          expiryDate: toDateStr(labelData.expiryDate) as any, // ✅ toDateStr converte string vazia para null
          tenantId: orderTenantId, // ✅ USA tenantId DA ORDEM
          packagesRead: 1,
          unitsRead: labelData.unitsPerBox, // Primeira leitura: 1 caixa * unitsPerBox
          expectedQuantity: 0,
        })
        .onDuplicateKeyUpdate({
          set: {
            packagesRead: sql`${blindConferenceItems.packagesRead} + 1`,
            unitsRead: sql`${blindConferenceItems.unitsRead} + ${labelData.unitsPerBox}`, // Incrementa unidades
            updatedAt: new Date(),
          },
        });

      // 3. REGISTRAR LEITURA NO HISTÓRICO (labelReadings)
      const sessionIdStr = `R${input.conferenceId}`;
      await db.insert(labelReadings).values({
        sessionId: sessionIdStr,
        associationId: labelData.id,
        labelCode: input.labelCode,
        readBy: userId,
        unitsAdded: labelData.unitsPerBox,
      });

      // 3.5. SINCRONIZAR COM receivingOrderItems (Atualização Automática)
       // Busca produto para gerar uniqueCode
      const productForSync = await db.select({ sku: products.sku })
        .from(products)
        .where(eq(products.id, labelData.productId))
        .limit(1);
      if (productForSync[0]) {
        const labelBatch = labelData.batch || null;
        const uniqueCode = getUniqueCode(productForSync[0].sku, labelBatch);
        // 🛡️ BUSCAR ITEM PRIMEIRO: casamento exato por uniqueCode (SKU+Lote da etiqueta)
        let existingOrderItem = await db.select()
          .from(receivingOrderItems)
          .where(
            and(
              eq(receivingOrderItems.receivingOrderId, conference.receivingOrderId),
              eq(receivingOrderItems.uniqueCode, uniqueCode),
              eq(receivingOrderItems.tenantId, orderTenantId)
            )
          )
          .limit(1);
        // FALLBACK: Se não encontrou por uniqueCode exato, buscar por productId com lote nulo
        // (cenário: NF-e não informou lote, mas a etiqueta tem lote real)
        if ((!existingOrderItem || existingOrderItem.length === 0) && labelBatch) {
          const fallbackItems = await db.select()
            .from(receivingOrderItems)
            .where(
              and(
                eq(receivingOrderItems.receivingOrderId, conference.receivingOrderId),
                eq(receivingOrderItems.productId, effectiveProductId), // usa productId do tenant da ordem
                eq(receivingOrderItems.tenantId, orderTenantId)
              )
            );
          // Pegar o item sem lote (batch null ou vazio) como candidato
          const candidate = fallbackItems.find(i => !i.batch || i.batch.trim() === '');
          if (candidate) {
            // NÃO alterar batch/uniqueCode do item — a NF-e não informou lote,
            // então o item permanece sem lote no banco. O lote fica apenas na labelAssociation
            // e no blindConferenceItems. O prepareFinish consolida por productId.
            existingOrderItem = [candidate]; // usar o item sem lote como referência para receivedQuantity
            console.log(`[readLabel] Fallback sem lote: usando item ${candidate.id} (batch=null) para produto ${labelData.productId}, lote real='${labelBatch}'`);
          }
        }
        
        if (existingOrderItem && existingOrderItem.length > 0) {
          const orderItem = existingOrderItem[0];
          const newQuantity = (orderItem.receivedQuantity || 0) + labelData.unitsPerBox;
          
          // 🛡️ PROTEÇÃO ENTERPRISE: Verificar over-receiving
          if (newQuantity > orderItem.expectedQuantity) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Over-receiving detectado! Esperado: ${orderItem.expectedQuantity}, Tentando receber: ${newQuantity}`,
            });
          }
          
          // ✅ UPDATE por ID (chave primária) - SEMPRE funciona
          await db.update(receivingOrderItems)
            .set({
              labelCode: input.labelCode,
              receivedQuantity: newQuantity,
              status: 'receiving',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(receivingOrderItems.id, orderItem.id),
                eq(receivingOrderItems.tenantId, orderTenantId)
              )
            );
        }
      }
      // 4. BUSCAR PROGRESSO ATUAL DO ITEM NA CONFERÊNCIA
      const conferenceItem = await db.select()
        .from(blindConferenceItems)
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, labelData.productId),
            eq(blindConferenceItems.batch, labelData.batch || "")
          )
        )
        .limit(1);

      const currentPackagesRead = conferenceItem[0]?.packagesRead || 1;

      // 5. BUSCAR DADOS DO PRODUTO
      const product = await db.select().from(products).where(eq(products.id, labelData.productId)).limit(1);

      // 5.5. ✅ BUSCAR LINHA DA ORDEM (receivingOrderItem) PARA remainingQuantity
      // Primeiro tenta por uniqueCode exato (SKU+Lote), depois fallback por productId sem lote
      const productForOrderItem = await db.select({ sku: products.sku })
        .from(products)
        .where(eq(products.id, effectiveProductId))
        .limit(1);
      
      const uniqueCodeForOrderItem = getUniqueCode(productForOrderItem[0]?.sku || "", labelData.batch || "");
      
      let orderItem = await db.select()
        .from(receivingOrderItems)
        .where(
          and(
            eq(receivingOrderItems.receivingOrderId, conference.receivingOrderId),
            eq(receivingOrderItems.uniqueCode, uniqueCodeForOrderItem),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        )
        .limit(1);
      
      // Fallback: buscar por productId sem lote (NF-e sem lote)
      if (orderItem.length === 0 && labelData.batch) {
        const fallbackForRemaining = await db.select()
          .from(receivingOrderItems)
          .where(
            and(
              eq(receivingOrderItems.receivingOrderId, conference.receivingOrderId),
              eq(receivingOrderItems.productId, effectiveProductId),
              eq(receivingOrderItems.tenantId, orderTenantId)
            )
          );
        const candidateForRemaining = fallbackForRemaining.find(i => !i.batch || i.batch.trim() === '');
        if (candidateForRemaining) {
          orderItem = [candidateForRemaining];
        }
      }
      
      console.log("✅ [readLabel] receivingOrderItem encontrado:", orderItem[0]?.id || "NÃO ENCONTRADO");
      console.log("[readLabel] DEBUG remainingQty:", {
        uniqueCodeForOrderItem,
        expectedQty: orderItem[0]?.expectedQuantity,
        receivedQty: orderItem[0]?.receivedQuantity,
        unitsPerBox: labelData.unitsPerBox,
        remainingQty: orderItem[0] ? Math.max(0, (orderItem[0].expectedQuantity || 0) - (orderItem[0].receivedQuantity || 0)) : null,
      });

      // 6. RETORNO PARA O FRONTEND
      // remainingQuantity = quanto falta para completar a NF-e DEPOIS desta bipagem
      // Usa receivedQuantity do orderItem (já atualizado com esta bipagem) como fonte de verdade
      const expectedQtyReadLabel = orderItem[0]?.expectedQuantity || 0;
      const receivedQtyAfterScan = orderItem[0]?.receivedQuantity || 0; // já inclui esta bipagem
      const remainingQtyReadLabel = expectedQtyReadLabel > 0
        ? Math.max(0, expectedQtyReadLabel - receivedQtyAfterScan)
        : null;

      return {
        isNewLabel: false,
        association: {
          id: labelData.id,
          labelCode: labelData.labelCode, // ✅ Código da etiqueta para caixa fracionada
          receivingOrderItemId: orderItem[0]?.id || null, // ✅ ID da linha da ordem
          productId: labelData.productId,
          productName: product[0]?.description || "",
          productSku: product[0]?.sku || "",
          batch: labelData.batch,
          expiryDate: labelData.expiryDate,
          unitsPerBox: labelData.unitsPerBox,
          packagesRead: currentPackagesRead,
          totalUnits: currentPackagesRead * labelData.unitsPerBox,
          remainingQuantity: remainingQtyReadLabel,
        }
      };
    }),

  /**
   * 3. Associar Etiqueta a Produto (REFATORADO)
   */
  associateLabel: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      labelCode: z.string(),
      receivingOrderItemId: z.number(), // ✅ ID da linha da ordem (chave primária)
      productId: z.number(),
      batch: z.string().nullable(),
      expiryDate: z.string().nullable(),
      unitsPerBox: z.number(),
      totalUnitsReceived: z.number().optional(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;

      // 🔑 0. BUSCAR SESSÃO DE CONFERÊNCIA PRIMEIRO (ESCOPO RAIZ)
      // ✅ Busca apenas por ID: a sessão é criada com orderTenantId (não effectiveTenantId)
      const conferenceSession = await db.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);
      
      if (conferenceSession.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sessão de conferência não encontrada"
        });
      }
      
      const conference = conferenceSession[0];
      console.log("[associateLabel] Conference encontrada:", conference.id, "| receivingOrderId:", conference.receivingOrderId);

      // ✅ BUSCAR receivingOrder PARA OBTER tenantId CORRETO
      const receivingOrder = await db.select()
        .from(receivingOrders)
        .where(eq(receivingOrders.id, conference.receivingOrderId))
        .limit(1);
      
      if (receivingOrder.length === 0) {
        throw new Error("Ordem de recebimento não encontrada");
      }
      
      const orderTenantId = receivingOrder[0].tenantId;
      console.log("[associateLabel] Usando tenantId da ordem:", orderTenantId);

      // ✅ Validar data de validade antes de qualquer operação no banco
      // ✅ VALIDAÇÃO: produto com lote DEVE ter data de validade
      if (input.batch && input.batch.trim() !== '' && (!input.expiryDate || input.expiryDate.trim() === '')) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Produto com lote "${input.batch}" requer data de validade. Informe a data de validade antes de continuar.`,
        });
      }

      if (input.expiryDate) {
        const trimmed = input.expiryDate.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
          const datePart = trimmed.split("T")[0].split(" ")[0];
          const [yyyy, mm, dd] = datePart.split("-").map(Number);
          const parsed = new Date(Date.UTC(yyyy, mm - 1, dd));
          const isInvalid =
            isNaN(parsed.getTime()) ||
            parsed.getUTCFullYear() !== yyyy ||
            parsed.getUTCMonth() + 1 !== mm ||
            parsed.getUTCDate() !== dd;
          if (isInvalid) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Data de validade inválida: "${input.expiryDate}". Verifique se o dia existe no mês informado (ex: 29/02 só existe em anos bissextos).`,
            });
          }
        }
      }

      // Buscar produto para gerar uniqueCode
      const product = await db.select().from(products).where(eq(products.id, input.productId)).limit(1);
      if (product.length === 0) {
        throw new Error("Produto não encontrado");
      }

      const productSku = product[0].sku;
      console.log("[associateLabel] DEBUG:", { productSku, batch: input.batch, batchType: typeof input.batch });
      const uniqueCode = getUniqueCode(productSku, input.batch);
      console.log("[associateLabel] uniqueCode gerado:", uniqueCode);

      const actualUnitsReceived = input.totalUnitsReceived || input.unitsPerBox; // ✅ Fallback para unitsPerBox

      // 1. CRIAR ETIQUETA PERMANENTE NO ESTOQUE GLOBAL
      console.log("🔍 [associateLabel] Buscando etiqueta existente:", input.labelCode, "| orderTenantId:", orderTenantId);
      
      // ⚠️ IMPORTANTE: labelCode tem constraint UNIQUE global (sem tenant).
      // Buscar por labelCode sem filtro de tenant para detectar duplicatas cross-tenant.
      let existingLabel;
      try {
        existingLabel = await db.select()
          .from(labelAssociations)
          .where(eq(labelAssociations.labelCode, input.labelCode))
          .limit(1);
        
        console.log("✅ [associateLabel] Query executada com sucesso. Resultados:", existingLabel.length);
      } catch (error: any) {
        console.error("❌ [associateLabel] ERRO na query de existingLabel:");
        console.error("Mensagem:", error.message);
        console.error("Stack:", error.stack);
        throw new Error(`Erro ao buscar etiqueta existente: ${error.message}`);
      }

      // labelAssociations é cadastro global de etiquetas (sem relação com tenant).
      // Se a etiqueta já existe: registrar o bip normalmente sem tentar inserir novamente.
      // Se não existe: criar o registro global.
      const labelAlreadyExists = existingLabel.length > 0;

      if (!labelAlreadyExists) {
        await db.insert(labelAssociations).values({
          labelCode: input.labelCode,
          uniqueCode: uniqueCode,
          productId: input.productId,
          batch: input.batch,
          expiryDate: toDateStr(input.expiryDate) as any,
          unitsPerBox: input.unitsPerBox,
          associatedBy: userId,
          associatedAt: new Date(),
          status: 'AVAILABLE' as any,
          tenantId: orderTenantId,
        });
        console.log("[associateLabel] Nova etiqueta criada:", input.labelCode);
      } else {
        console.log("[associateLabel] Etiqueta já existe — registrando bip sem re-inserir:", input.labelCode);
      }

      // 2. REGISTRAR PRIMEIRO BIP NA CONFERÊNCIA
      await db.insert(blindConferenceItems)
        .values({
          conferenceId: input.conferenceId,
          productId: input.productId,
          batch: input.batch || "",
          expiryDate: toDateStr(input.expiryDate) as any,
          tenantId: orderTenantId, // ✅ USA tenantId DA ORDEM
          packagesRead: 1,
          unitsRead: actualUnitsReceived, // Primeira leitura: actualUnitsReceived (pode ser fracionado)
          expectedQuantity: 0,
        })
        .onDuplicateKeyUpdate({
          set: {
            packagesRead: sql`${blindConferenceItems.packagesRead} + 1`,
            unitsRead: sql`${blindConferenceItems.unitsRead} + ${actualUnitsReceived}`, // Incrementa unidades
            updatedAt: new Date(),
          },
        });

      // 3. REGISTRAR LEITURA NO HISTÓRICO
      const sessionIdStr = `R${input.conferenceId}`;
      const newLabel = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      await db.insert(labelReadings).values({
        sessionId: sessionIdStr,
        associationId: newLabel[0].id,
        labelCode: input.labelCode,
        readBy: userId,
        unitsAdded: actualUnitsReceived,
      });

      // 4. ATUALIZAR unitsPerBox NO PRODUTO SE NÃO EXISTIR
      if (!product[0].unitsPerBox) {
        await db.update(products)
          .set({ unitsPerBox: input.unitsPerBox })
          .where(eq(products.id, input.productId));
      }

      // 4.5. SINCRONIZAR COM receivingOrderItems (Atualização Automática)
      // ✅ SOLUÇÃO DEFINITIVA: UPDATE direto por ID (chave primária)
      const existingItem = await db.select()
        .from(receivingOrderItems)
        .where(
          // ✅ Busca por ID (chave primária) + orderTenantId (tenant da ordem, não do usuário)
          and(
            eq(receivingOrderItems.id, input.receivingOrderItemId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        )
        .limit(1);
      
      // 🛡️ VALIDAÇÃO DEFENSIVA 1: Item existe?
      if (!existingItem || existingItem.length === 0) {
        console.error("[associateLabel] ERRO: Item não encontrado com ID:", input.receivingOrderItemId);
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Item da ordem não encontrado (ID: ${input.receivingOrderItemId}). Verifique se a NF-e foi importada corretamente.`
        });
      }
      
      // ✅ Extrair para variável segura (evitar acessar [0] múltiplas vezes)
      const item = existingItem[0];
      
      // 🛡️ VALIDAÇÃO DEFENSIVA 2: Item pertence à sessão correta?
      if (item.receivingOrderId !== conference.receivingOrderId) {
        console.error("[associateLabel] ERRO: Item não pertence a esta ordem:", { 
          itemOrderId: item.receivingOrderId, 
          sessionOrderId: conference.receivingOrderId,
          labelCode: input.labelCode,
          userId: userId,
          conferenceId: input.conferenceId
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Item não pertence a esta ordem de recebimento. Possível corrupção de dados."
        });
      }
      
      // ✅ FONTE DE VERDADE: blindConferenceItems.unitsRead APÓS o insert/upsert acima
      // O upsert já incrementou unitsRead com actualUnitsReceived.
      // Portanto, alreadyConferred = unitsRead ATUAL (inclui esta etiqueta).
      // newTotalUnits = alreadyConferred (já inclui a etiqueta recém-inserida).
      const existingConferenceItem = await db.select({
        unitsRead: blindConferenceItems.unitsRead,
      })
        .from(blindConferenceItems)
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, input.productId)
          )
        )
        .limit(1);

      // unitsRead já inclui a etiqueta recém-inserida (upsert acima)
      const totalConferredAfterInsert = existingConferenceItem.length > 0 ? (existingConferenceItem[0].unitsRead || 0) : actualUnitsReceived;
      // Quantidade já conferida ANTES desta etiqueta = total - esta etiqueta
      const alreadyConferred = totalConferredAfterInsert - actualUnitsReceived;
      let expectedQty = item.expectedQuantity || 0;

      // 🛡️ FALLBACK DE SEGURANÇA: Se expectedQty < actualUnitsReceived e há fator de conversão,
      // o item provavelmente foi importado sem conversão aplicada. Auto-corrigir antes de validar.
      if (expectedQty > 0 && expectedQty < actualUnitsReceived) {
        const convRows = await db
          .select({ factorToBase: productConversions.factorToBase, roundingStrategy: productConversions.roundingStrategy })
          .from(productConversions)
          .where(and(
            eq(productConversions.tenantId, orderTenantId),
            eq(productConversions.productId, input.productId)
          ))
          .limit(1);
        if (convRows.length > 0) {
          const factor = parseFloat(String(convRows[0].factorToBase));
          if (factor > 1) {
            const corrected = Math.round(expectedQty * factor);
            if (corrected >= actualUnitsReceived) {
              // Corrigir no banco para evitar repetição do problema
              await db.update(receivingOrderItems)
                .set({ expectedQuantity: corrected, updatedAt: new Date() })
                .where(eq(receivingOrderItems.id, item.id));
              expectedQty = corrected;
              console.log(`[associateLabel] Auto-corrigido expectedQty: item #${item.id} ${item.expectedQuantity} → ${corrected} (fator=${factor})`);
            }
          }
        }
      }

      // Unidade de exibição para mensagem de erro
      const unitsLabel = input.unitsPerBox > 1
        ? `${Math.round(actualUnitsReceived / input.unitsPerBox)} CX (${actualUnitsReceived} un)`
        : `${actualUnitsReceived} un`;

      // 🛡️ PROTEÇÃO: Verificar over-receiving apenas se expectedQuantity > 0
      // Usa totalConferredAfterInsert (já inclui esta etiqueta) vs expectedQty
      if (expectedQty > 0 && totalConferredAfterInsert > expectedQty) {
        // ⚠️ ROLLBACK: Desfazer o upsert de blindConferenceItems para não deixar estado inconsistente
        // Decrementar packagesRead e unitsRead de volta
        await db.update(blindConferenceItems)
          .set({
            packagesRead: sql`GREATEST(${blindConferenceItems.packagesRead} - 1, 0)`,
            unitsRead: sql`GREATEST(${blindConferenceItems.unitsRead} - ${actualUnitsReceived}, 0)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(blindConferenceItems.conferenceId, input.conferenceId),
              eq(blindConferenceItems.productId, input.productId)
            )
          );
        // Remover labelAssociation apenas se foi criada agora (não existia antes)
        if (!labelAlreadyExists) {
          await db.delete(labelAssociations)
            .where(eq(labelAssociations.labelCode, input.labelCode));
        }

        console.error("[associateLabel] ERRO: Over-receiving detectado", {
          itemId: item.id,
          expectedQuantity: expectedQty,
          alreadyConferred,
          actualUnitsReceived,
          totalConferredAfterInsert,
          labelCode: input.labelCode,
          userId: userId
        });
        
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Over-receiving detectado! Esperado: ${expectedQty} un, Já conferido: ${alreadyConferred} un, Tentando adicionar: ${unitsLabel}.`,
        });
      }

      const currentQuantity = item.receivedQuantity || 0;
      const newQuantity = currentQuantity + actualUnitsReceived;
      
      console.log("[associateLabel] Atualizando item:", { 
        id: item.id, // ✅ ID correto da busca (não do input)
        currentQuantity, 
        actualUnitsReceived, 
        newQuantity 
      });
      
      // ✅ UPDATE por ID correto da busca (NÃO confiar no input.receivingOrderItemId)
      // ✅ CORREÇÃO: propagar batch, expiryDate e uniqueCode da etiqueta para receivingOrderItems
      // Prioridade: lote informado pelo operador (input.batch) > lote existente no item (item.batch)
      // input.batch tem prioridade ABSOLUTA — permite atribuir lote a produto sem lote na NF-e
      const finalBatch = (input.batch && input.batch.trim() !== '') ? input.batch.trim() : (item.batch && item.batch.trim() !== '' ? item.batch.trim() : null);
      const finalUniqueCode = getUniqueCode(productSku, finalBatch);
      await db.update(receivingOrderItems)
        .set({
          labelCode: input.labelCode,
          batch: finalBatch,
          uniqueCode: finalUniqueCode,
          expiryDate: toDateStr(input.expiryDate || (item.expiryDate ? String(item.expiryDate) : null)) as any,
          receivedQuantity: newQuantity,
          status: 'receiving',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(receivingOrderItems.id, item.id), // ✅ ID correto da busca (variável segura)
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        );
      
      console.log("[associateLabel] UPDATE concluído com sucesso! Nova quantidade:", newQuantity);

      return {
        success: true,
        message: "Etiqueta associada com sucesso",
        association: {
          id: newLabel[0].id,
          productId: input.productId,
          productName: product[0].description,
          productSku: product[0].sku,
          batch: input.batch,
          expiryDate: input.expiryDate,
          unitsPerBox: input.unitsPerBox,
          packagesRead: 1,
          totalUnits: actualUnitsReceived,
          currentQuantity: newQuantity,
          expectedQuantity: expectedQty,
          // Quanto falta para completar a NF-e após esta bipagem
          remainingQuantity: expectedQty > 0 ? Math.max(0, expectedQty - newQuantity) : null,
        }
      };
    }),

  /**
   * 3.5. Registrar Não-Conformidade (NCG)
   * REFATORADO: Cria inventory em NCG imediatamente e atualiza blockedQuantity
   */
  registerNCG: tenantProcedure
    .input(z.object({
      receivingOrderItemId: z.number(), // ID do item da ordem
      labelCode: z.string().optional(), // Opcional: será gerado se não fornecido
      conferenceId: z.number(),
      quantity: z.number().positive("Quantidade deve ser maior que zero"), // Quantidade bloqueada
      description: z.string().min(10, "Descrição deve ter no mínimo 10 caracteres"), // Motivo da NCG
      photoUrl: z.string().optional(),
      unitsPerBox: z.number().positive().optional(), // Obrigatório se etiqueta não existe
      batch: z.string().optional(), // Vindo da Tela 2
      expiryDate: z.string().optional(), // Vindo da Tela 2
      productId: z.number().optional(), // Vindo da Tela 2
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;

      // 2. BUSCAR DADOS DO ITEM DA ORDEM
      const [orderItem] = await db.select()
        .from(receivingOrderItems)
        .where(eq(receivingOrderItems.id, input.receivingOrderItemId))
        .limit(1);

      if (!orderItem) {
        throw new Error("Item da ordem não encontrado");
      }

      // ✅ BUSCAR receivingOrder PARA OBTER tenantId CORRETO
      const [receivingOrder] = await db.select()
        .from(receivingOrders)
        .where(eq(receivingOrders.id, orderItem.receivingOrderId))
        .limit(1);
      
      if (!receivingOrder) {
        throw new Error("Ordem de recebimento não encontrada");
      }
      
      const orderTenantId = receivingOrder.tenantId;

      // 1. BUSCAR LOCALIZAÇÃO NCG (Não Conformidade/Quarentena)
      // Tentativa 1: busca por zoneCode = 'NCG' + tenantId da ordem
      let [ncgLocation] = await db.select()
        .from(warehouseLocations)
        .where(
          and(
            eq(warehouseLocations.zoneCode, "NCG"),
            eq(warehouseLocations.tenantId, orderTenantId)
          )
        )
        .limit(1);

      // Tentativa 2 (fallback): busca por zoneId da zona NCG + tenantId
      if (!ncgLocation) {
        const [ncgZone] = await db.select({ id: warehouseZones.id })
          .from(warehouseZones)
          .where(eq(warehouseZones.code, "NCG"))
          .limit(1);
        if (ncgZone) {
          [ncgLocation] = await db.select()
            .from(warehouseLocations)
            .where(
              and(
                eq(warehouseLocations.zoneId, ncgZone.id),
                eq(warehouseLocations.tenantId, orderTenantId)
              )
            )
            .limit(1);
        }
      }

      if (!ncgLocation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Localização NCG não configurada. Cadastre um endereço na zona NCG para este cliente."
        });
      }
      console.log("[registerNCG] Usando tenantId da ordem:", orderTenantId);

      // ✅ BUSCAR PRODUTO PARA OBTER SKU E unitsPerBox
      const [product] = await db.select()
        .from(products)
        .where(eq(products.id, orderItem.productId))
        .limit(1);

      // 3. GERAR OU VERIFICAR ETIQUETA
      let labelCode = input.labelCode;
      
      if (!labelCode) {
        // Gerar labelCode automático: SKU + Lote + timestamp
        const timestamp = Date.now().toString().slice(-6); // Últimos 6 dígitos
        labelCode = `${product?.sku || orderItem.productId}${orderItem.batch || 'SL'}${timestamp}`;
        console.log("[registerNCG] LabelCode gerado automaticamente:", labelCode);
      }

      // Verificar se etiqueta já existe
      // ⚠️ IMPORTANTE: labelCode tem constraint UNIQUE global (sem tenant).
      // Buscar por labelCode sem filtro de tenant para detectar duplicatas cross-tenant.
      const [existingLabel] = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, labelCode))
        .limit(1);

      // Se não existir, criar nova etiqueta
      if (!existingLabel) {
        console.log("[registerNCG] Criando nova etiqueta:", labelCode);
        
        // Usar dados da Tela 2 se fornecidos, senão usar do orderItem
        const finalUnitsPerBox = input.unitsPerBox || product?.unitsPerBox || 1;
        const finalBatch = input.batch || orderItem.batch || null;
        const finalExpiryDateRaw = input.expiryDate || (orderItem.expiryDate ? String(orderItem.expiryDate) : null) || null;
        const finalExpiryDate = toDateStr(finalExpiryDateRaw) as any;
        const finalProductId = input.productId || orderItem.productId;
        
        await db.insert(labelAssociations).values({
          tenantId: orderTenantId, // ✅ USA tenantId DA ORDEM
          labelCode: labelCode,
          uniqueCode: orderItem.uniqueCode || `${finalProductId}-${finalBatch || 'SL'}`,
          productId: finalProductId,
          batch: finalBatch,
          expiryDate: finalExpiryDate,
          unitsPerBox: finalUnitsPerBox,
          associatedBy: userId,
          associatedAt: new Date(),
          status: 'AVAILABLE' as any,
        });
      }

      // 4. INVENTÁRIO NCG: criado apenas no confirmFinish com formato de data consistente
      // O registerNCG apenas registra a não-conformidade para auditoria.

      // 5. ATUALIZAR receivedQuantity E blockedQuantity NO ITEM DA ORDEM
      // O registerNCG representa uma leitura de etiqueta como qualquer outra.
      // receivedQuantity = total físico recebido (etiquetas normais + NCG)
      // blockedQuantity  = apenas unidades NCG (para calcular addressedQuantity)
      // addressedQuantity = receivedQuantity - blockedQuantity (calculado no prepareFinish)
      const ncgUnitsPerBox = input.unitsPerBox || product?.unitsPerBox || 1;
      const ncgPackages = Math.ceil(input.quantity / ncgUnitsPerBox);
      // 5a. Incrementar receivedQuantity (total físico) e blockedQuantity no receivingOrderItems
      await db.update(receivingOrderItems)
        .set({
          receivedQuantity: sql`${receivingOrderItems.receivedQuantity} + ${input.quantity}`,
          blockedQuantity: sql`${receivingOrderItems.blockedQuantity} + ${input.quantity}`,
          status: "receiving"
        })
        .where(eq(receivingOrderItems.id, input.receivingOrderItemId));
      // 5b. Registrar leitura NCG em blindConferenceItems (packagesRead + unitsRead)
      // NCG é uma leitura de etiqueta como qualquer outra — deve aparecer no contador de volumes
      const finalBatchNCG = input.batch || orderItem.batch || "";
      const finalExpiryNCG = toDateStr(input.expiryDate || (orderItem.expiryDate ? String(orderItem.expiryDate) : null)) as any;
      const finalProductIdNCG = input.productId || orderItem.productId;
      await db.insert(blindConferenceItems)
        .values({
          conferenceId: input.conferenceId,
          productId: finalProductIdNCG,
          batch: finalBatchNCG,
          expiryDate: finalExpiryNCG,
          tenantId: orderTenantId,
          packagesRead: ncgPackages,
          unitsRead: input.quantity,
          expectedQuantity: 0,
        })
        .onDuplicateKeyUpdate({
          set: {
            packagesRead: sql`${blindConferenceItems.packagesRead} + ${ncgPackages}`,
            unitsRead: sql`${blindConferenceItems.unitsRead} + ${input.quantity}`,
            updatedAt: new Date(),
          },
        });
      // 6. (JÁ FEITO NO PASSO 3) Etiqueta já foi criada/atualizada com status BLOCKED

      // 7. REGISTRAR NÃO-CONFORMIDADE
      await db.insert(nonConformities).values({
        tenantId: orderTenantId, // ✅ USA tenantId DA ORDEM
        receivingOrderItemId: input.receivingOrderItemId,
        labelCode: labelCode,
        conferenceId: input.conferenceId,
        locationId: ncgLocation.id, // Localização NCG onde foi alocado
        shippingId: null, // NULL enquanto em estoque
        description: input.description,
        photoUrl: input.photoUrl || null,
        registeredBy: userId,
      });

      return {
        success: true,
        message: "Não-conformidade registrada com sucesso",
        labelCode: labelCode,
        quantity: input.quantity,
        location: ncgLocation.code
      };
    }),

  /**
   * 4. Desfazer Última Leitura (REFATORADO)
   */
  undoLastReading: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const orderTenantId = await getOrderTenantId(db, input.conferenceId);
      const sessionId = `R${input.conferenceId}`;

      // 1. BUSCAR A ÚLTIMA LEITURA DA SESSÃO (LIFO via labelReadings)
      const lastReadings = await db.select()
        .from(labelReadings)
        .where(eq(labelReadings.sessionId, sessionId))
        .orderBy(desc(labelReadings.id))
        .limit(1);

      if (lastReadings.length === 0) {
        throw new Error("Nenhuma leitura encontrada para desfazer");
      }
      const lastReading = lastReadings[0];
      const unitsToRemove = lastReading.unitsAdded;

      // 2. BUSCAR DADOS DA ASSOCIAÇÃO (productId + batch)
      // Tenta por associationId primeiro; fallback por labelCode (para leituras antigas)
      let assoc = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.id, lastReading.associationId!))
        .limit(1);

      if (assoc.length === 0 && lastReading.labelCode) {
        assoc = await db.select()
          .from(labelAssociations)
          .where(eq(labelAssociations.labelCode, lastReading.labelCode))
          .limit(1);
      }

      if (assoc.length === 0) {
        // Sem associação: apenas deletar o labelReading e retornar sucesso
        await db.delete(labelReadings).where(eq(labelReadings.id, lastReading.id));
        return {
          success: true,
          message: "Leitura removida (etiqueta não encontrada no cadastro)",
          productId: null,
          batch: null,
          unitsRemoved: unitsToRemove,
        };
      }
      const { productId, batch } = assoc[0];
      const batchValue = batch || "";

      // 3. DECREMENTAR blindConferenceItems
      const conferenceItem = await db.select()
        .from(blindConferenceItems)
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, productId),
            eq(blindConferenceItems.batch, batchValue),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        )
        .limit(1);

      if (conferenceItem.length > 0) {
        const currentPackages = conferenceItem[0].packagesRead;
        if (currentPackages <= 1) {
          await db.delete(blindConferenceItems)
            .where(
              and(
                eq(blindConferenceItems.conferenceId, input.conferenceId),
                eq(blindConferenceItems.productId, productId),
                eq(blindConferenceItems.batch, batchValue),
                eq(blindConferenceItems.tenantId, orderTenantId)
              )
            );
        } else {
          await db.update(blindConferenceItems)
            .set({
              packagesRead: sql`${blindConferenceItems.packagesRead} - 1`,
              unitsRead: sql`GREATEST(0, ${blindConferenceItems.unitsRead} - ${unitsToRemove})`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(blindConferenceItems.conferenceId, input.conferenceId),
                eq(blindConferenceItems.productId, productId),
                eq(blindConferenceItems.batch, batchValue),
                eq(blindConferenceItems.tenantId, orderTenantId)
              )
            );
        }
      }

      // 4. DECREMENTAR receivedQuantity no receivingOrderItem
      const conference = await db.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);

      if (conference.length > 0) {
        const productSku = await db.select({ sku: products.sku })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);

        if (productSku.length > 0) {
          const uniqueCode = getUniqueCode(productSku[0].sku, batch || null);
          let orderItem = await db.select()
            .from(receivingOrderItems)
            .where(
              and(
                eq(receivingOrderItems.receivingOrderId, conference[0].receivingOrderId),
                eq(receivingOrderItems.uniqueCode, uniqueCode),
                eq(receivingOrderItems.tenantId, orderTenantId)
              )
            )
            .limit(1);
          // Fallback: buscar por productId (NF sem lote)
          if (orderItem.length === 0) {
            const candidates = await db.select()
              .from(receivingOrderItems)
              .where(
                and(
                  eq(receivingOrderItems.receivingOrderId, conference[0].receivingOrderId),
                  eq(receivingOrderItems.productId, productId),
                  eq(receivingOrderItems.tenantId, orderTenantId)
                )
              );
            const candidate = candidates.find(i => !i.batch || i.batch.trim() === '');
            if (candidate) orderItem = [candidate];
          }
          if (orderItem.length > 0) {
            await db.update(receivingOrderItems)
              .set({
                receivedQuantity: sql`GREATEST(0, ${receivingOrderItems.receivedQuantity} - ${unitsToRemove})`,
                updatedAt: new Date(),
              })
              .where(eq(receivingOrderItems.id, orderItem[0].id));
          }
        }
      }

      // 5. DELETAR O REGISTRO DE labelReadings (remove da história LIFO)
      await db.delete(labelReadings)
        .where(eq(labelReadings.id, lastReading.id));

      return {
        success: true,
        message: "Última leitura desfeita com sucesso",
        productId,
        batch: batchValue,
        unitsRemoved: unitsToRemove,
      };
    }),

  /**
   * 5. Ajustar Quantidade (REFATORADO)
   */
  adjustQuantity: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      productId: z.number(),
      batch: z.string().nullable(),
      newQuantity: z.number(),
      reason: z.string(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;
      // ✅ USA orderTenantId (tenant da ordem) para buscar blindConferenceItems
      const orderTenantId = await getOrderTenantId(db, input.conferenceId);
      const batchValue = input.batch || "";;

      // 1. BUSCAR ITEM NA CONFERÊNCIA
      const conferenceItem = await db.select()
        .from(blindConferenceItems)
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, input.productId),
            eq(blindConferenceItems.batch, batchValue),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        )
        .limit(1);

      if (conferenceItem.length === 0) {
        throw new Error("Item não encontrado na conferência");
      }

      const oldQuantity = conferenceItem[0].packagesRead;

      // 2. ATUALIZAR QUANTIDADE
      await db.update(blindConferenceItems)
        .set({
          packagesRead: input.newQuantity,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, input.productId),
            eq(blindConferenceItems.batch, batchValue),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        );

      // 3. REGISTRAR AJUSTE NO HISTÓRICO
      await db.insert(blindConferenceAdjustments).values({
        conferenceId: input.conferenceId,
        productId: input.productId,
        batch: input.batch,
        oldQuantity: oldQuantity,
        newQuantity: input.newQuantity,
        reason: input.reason,
        adjustedBy: userId,
      });

      return {
        success: true,
        message: "Quantidade ajustada com sucesso",
        oldQuantity,
        newQuantity: input.newQuantity
      };
    }),

  /**
   * 5.5. Definir Quantidade Manual de Unidades
   * Permite ao operador informar a quantidade total conferida após a primeira bipagem,
   * tratando como se cada unidade tivesse sido bipada individualmente.
   * Requer que o item já exista em blindConferenceItems (pelo menos 1 bipagem).
   */
  setManualUnits: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      productId: z.number(),
      batch: z.string().nullable(),
      receivingOrderItemId: z.number(),
      totalUnits: z.number().positive("Quantidade deve ser maior que zero"),
      reason: z.string().min(1, "Informe o motivo"),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const userId = ctx.user.id;
      const orderTenantId = await getOrderTenantId(db, input.conferenceId);
      const batchValue = input.batch || "";

      // 1. VERIFICAR QUE O ITEM JÁ FOI BIPADO (existe em blindConferenceItems)
      const conferenceItem = await db.select()
        .from(blindConferenceItems)
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, input.productId),
            eq(blindConferenceItems.batch, batchValue),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        )
        .limit(1);

      if (conferenceItem.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Realize pelo menos uma bipagem antes de informar a quantidade manualmente.",
        });
      }

      const oldUnits = conferenceItem[0].unitsRead || 0;
      const unitsPerBox = (conferenceItem[0].packagesRead || 1) > 0
        ? Math.round((conferenceItem[0].unitsRead || 1) / (conferenceItem[0].packagesRead || 1))
        : 1;
      const newPackages = unitsPerBox > 1 ? Math.ceil(input.totalUnits / unitsPerBox) : input.totalUnits;

      // 2. ATUALIZAR blindConferenceItems com a quantidade total informada
      await db.update(blindConferenceItems)
        .set({
          unitsRead: input.totalUnits,
          packagesRead: newPackages,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.productId, input.productId),
            eq(blindConferenceItems.batch, batchValue),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        );

      // 3. REGISTRAR NO HISTÓRICO DE AJUSTES
      await db.insert(blindConferenceAdjustments).values({
        sessionId: input.conferenceId,
        associationId: 0,
        previousQuantity: oldUnits,
        conferenceId: input.conferenceId,
        productId: input.productId,
        batch: input.batch,
        oldQuantity: oldUnits,
        newQuantity: input.totalUnits,
        reason: `[QTDE MANUAL] ${input.reason}`,
        adjustedBy: userId,
      });

      // 4. SINCRONIZAR receivingOrderItems.receivedQuantity
      const existingItem = await db.select()
        .from(receivingOrderItems)
        .where(
          and(
            eq(receivingOrderItems.id, input.receivingOrderItemId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        )
        .limit(1);

      if (existingItem.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Item da ordem não encontrado (ID: ${input.receivingOrderItemId}).`,
        });
      }

      await db.update(receivingOrderItems)
        .set({
          receivedQuantity: input.totalUnits,
          status: 'receiving',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(receivingOrderItems.id, input.receivingOrderItemId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        );

      return {
        success: true,
        message: `Quantidade definida manualmente: ${input.totalUnits} unidades`,
        oldUnits,
        newUnits: input.totalUnits,
      };
    }),

  /**
   * 6. Obter Resumo da Conferência (REFATORADO)
   */
  getSummary: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");


      const { effectiveTenantId, isGlobalAdmin } = ctx;
      // ✅ USA orderTenantId (tenant da ordem) para buscar blindConferenceItems
      const orderTenantId = await getOrderTenantId(db, input.conferenceId);

      // Buscar o receivingOrderId da sessão para fazer JOIN com receivingOrderItems
      const session = await db.select({ receivingOrderId: blindConferenceSessions.receivingOrderId })
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);
      const receivingOrderId = session[0]?.receivingOrderId ?? null;

      // 1a. BUSCAR expectedQuantity por produto da NF-e (somando todos os lotes do mesmo produto)
      // O JOIN por batch falha quando a NF-e não tem lote mas a etiqueta tem.
      // Solução: somar expectedQuantity por produto (independente de lote).
      const expectedByProduct = receivingOrderId
        ? await db.select({
            productId: receivingOrderItems.productId,
            totalExpected: sql<number>`SUM(${receivingOrderItems.expectedQuantity})`,
          })
          .from(receivingOrderItems)
          .where(and(
            eq(receivingOrderItems.receivingOrderId, receivingOrderId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          ))
          .groupBy(receivingOrderItems.productId)
        : [];

      const expectedMap = new Map<number, number>();
      for (const row of expectedByProduct) {
        expectedMap.set(row.productId, Number(row.totalExpected) || 0);
      }

      // 1b. BUSCAR ITENS DA CONFERÊNCIA com receivingOrderItemId via JOIN
      const items = await db.select({
        productId: blindConferenceItems.productId,
        productSku: products.sku,
        productName: products.description,
        productUnitsPerBox: products.unitsPerBox,
        batch: blindConferenceItems.batch,
        expiryDate: blindConferenceItems.expiryDate,
        packagesRead: blindConferenceItems.packagesRead,
        unitsRead: blindConferenceItems.unitsRead,
        receivingOrderItemId: receivingOrderItems.id,
      })
        .from(blindConferenceItems)
        .leftJoin(products, eq(blindConferenceItems.productId, products.id))
        .leftJoin(
          receivingOrderItems,
          and(
            receivingOrderId ? eq(receivingOrderItems.receivingOrderId, receivingOrderId) : sql`1=0`,
            eq(receivingOrderItems.productId, blindConferenceItems.productId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        )
        .where(
          and(
            eq(blindConferenceItems.conferenceId, input.conferenceId),
            eq(blindConferenceItems.tenantId, orderTenantId)
          )
        );

      // readLabel é a única fonte de verdade para unitsRead e packagesRead.
      // Toda etiqueta lida (incluindo NCG) passa pelo readLabel, então unitsRead já
      // inclui as unidades NCG. Não é necessário buscar blockedQuantity aqui.

      // DEDUPLICAR: o LEFT JOIN com receivingOrderItems pode retornar múltiplas linhas
      // para o mesmo blindConferenceItem quando o produto tem 2+ lotes na NF-e.
      // Manter apenas a primeira ocorrência de cada productId+batch.
      const seenKeys = new Set<string>();
      const dedupedItems = items.filter(item => {
        const key = `${item.productId}-${item.batch ?? ""}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      return {
        conferenceId: input.conferenceId,
        conferenceItems: dedupedItems.map(item => ({
          productId: item.productId,
          productSku: item.productSku || "",
          productName: item.productName || "",
          productUnitsPerBox: item.productUnitsPerBox ?? 1,
          batch: item.batch || null,
          expiryDate: item.expiryDate,
          packagesRead: item.packagesRead,
          unitsRead: (item.unitsRead || 0),
          // expectedQuantity está em unidades base (UN) — comparar com unitsRead
          // Busca do expectedMap (soma de todos os lotes do produto na NF-e)
          expectedQuantity: expectedMap.get(item.productId) ?? null,
          receivingOrderItemId: item.receivingOrderItemId ?? null,
        }))
      };
    }),
  /**
   * 6.5. Preparar Finalizaçãoo - Calcular addressedQuantity e retornar resumo
   */
  prepareFinish: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");


      const { effectiveTenantId, isGlobalAdmin } = ctx;

      // 1. BUSCAR SESSÃO
      const session = await db.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);

      if (!session || session.length === 0 || !session[0]) {
        throw new TRPCError({ 
          code: 'NOT_FOUND', 
          message: 'Sessão de conferência não encontrada.' 
        });
      }

      // 2. BUSCAR ORDEM DE RECEBIMENTO
      const [order] = await db.select()
        .from(receivingOrders)
        .where(eq(receivingOrders.id, session[0].receivingOrderId))
        .limit(1);
      
      if (!order) {
        throw new Error("Ordem de recebimento não encontrada");
      }
      const orderTenantId = order.tenantId;

      // 3a. BUSCAR ITENS DA ORDEM
      const orderItems = await db.select()
        .from(receivingOrderItems)
        .where(
          and(
            eq(receivingOrderItems.receivingOrderId, session[0].receivingOrderId),
            eq(receivingOrderItems.tenantId, orderTenantId)
          )
        );

      // 3b. BUSCAR UNIDADES LIDAS NA CONFERÊNCIA CEGA (agrupado por productId + batch)
      // Agrupa por SKU+Lote para evitar somar quantidades de lotes diferentes do mesmo SKU.
      const conferenceReadings = await db.select({
        productId: blindConferenceItems.productId,
        batch: blindConferenceItems.batch,
        totalUnitsRead: sql<number>`SUM(${blindConferenceItems.unitsRead})`,
      })
        .from(blindConferenceItems)
        .where(eq(blindConferenceItems.conferenceId, input.conferenceId))
        .groupBy(blindConferenceItems.productId, blindConferenceItems.batch);

      // Mapa: "productId|batch" → totalUnitsRead da conferência cega
      // Nota: readLabel já atualiza batch/uniqueCode do receivingOrderItem com dados reais da etiqueta,
      // portanto o casamento por productId+batch é sempre exato aqui.
      const readingsMap = new Map<string, number>();
      for (const r of conferenceReadings) {
        const key = `${r.productId}|${r.batch ?? ''}`;
        readingsMap.set(key, Number(r.totalUnitsRead) || 0);
      }

       const summary = [];
      // Rastrear quais chaves do readingsMap já foram casadas com um orderItem
      const matchedReadingKeys = new Set<string>();
      for (const orderItem of orderItems) {
        // SEMÂNTICA DEFINITIVA DOS CAMPOS:
        // receivedQuantity = total físico bipado na conferência cega (blindConferenceItems.unitsRead)
        //                    + NCG (registerNCG atualiza receivingOrderItems.receivedQuantity diretamente)
        // blockedQuantity  = apenas unidades NCG registradas pelo registerNCG
        // addressedQuantity = receivedQuantity - blockedQuantity
        const itemKey = `${orderItem.productId}|${orderItem.batch ?? ''}`;
        matchedReadingKeys.add(itemKey);
        // Se o item não tem lote (NF-e sem lote), somar TODAS as leituras deste produto
        // (independente do lote bipado), pois o operador pode ter bipado múltiplos lotes
        let blindReadUnits: number;
        const itemHasNoBatch = !orderItem.batch || orderItem.batch.trim() === '';
        if (itemHasNoBatch) {
          // Somar todas as leituras deste produto no readingsMap (qualquer lote)
          blindReadUnits = 0;
          for (const [rKey, rUnits] of Array.from(readingsMap.entries())) {
            const [rPidStr] = rKey.split('|');
            if (Number(rPidStr) === orderItem.productId) {
              blindReadUnits += rUnits;
              matchedReadingKeys.add(rKey); // marcar como processado para não ir para extras
            }
          }
        } else {
          blindReadUnits = readingsMap.get(itemKey) || 0;
        }
        const ncgUnits        = (orderItem.blockedQuantity || 0);            // NCG (já em receivingOrderItems)
        const totalPhysical   = blindReadUnits + ncgUnits;                   // total físico
        const blockedQtyDB    = ncgUnits;                                    // NCG
        const addressableQty  = totalPhysical - blockedQtyDB;               // endereçável

        // Atualizar receivedQuantity e addressedQuantity no banco
        await db.update(receivingOrderItems)
          .set({
            receivedQuantity: totalPhysical,
            addressedQuantity: addressableQty,
            status: "completed",
            updatedAt: new Date()
          })
          .where(eq(receivingOrderItems.id, orderItem.id));

        // Buscar produto para exibir no resumo
        const [product] = await db.select({ sku: products.sku, description: products.description })
          .from(products)
          .where(eq(products.id, orderItem.productId))
          .limit(1);

        summary.push({
          productId: orderItem.productId,
          productSku: product?.sku || '',
          productDescription: product?.description || '',
          batch: orderItem.batch,
          expectedQuantity: orderItem.expectedQuantity,
          receivedQuantity: totalPhysical,   // total físico para exibição
          blockedQuantity: blockedQtyDB,     // NCG
          addressedQuantity: addressableQty, // endereçável
        });
      }

      // ============================================================
      // REGRA DE CONSOLIDAÇÃO POR PRODUTO (lotes físicos ≠ lotes NF-e)
      // Se a NF-e declara um lote mas o físico chegou em múltiplos lotes,
      // e a SOMA total bipada do produto bate com o TOTAL esperado do produto,
      // considerar OK — sem divergência e sem lote extra.
      // ============================================================

      // Calcular total bipado por produto (todos os lotes)
      const totalBipedByProduct = new Map<number, number>();
      for (const [key, units] of Array.from(readingsMap.entries())) {
        const [pidStr] = key.split('|');
        const pid = Number(pidStr);
        totalBipedByProduct.set(pid, (totalBipedByProduct.get(pid) || 0) + units);
      }

      // Calcular total esperado por produto (todos os orderItems)
      const totalExpectedByProduct = new Map<number, number>();
      for (const oi of orderItems) {
        totalExpectedByProduct.set(oi.productId, (totalExpectedByProduct.get(oi.productId) || 0) + (oi.expectedQuantity || 0));
      }

      // Incluir leituras extras: lotes bipados que não têm receivingOrderItem correspondente
      for (const [key, unitsRead] of Array.from(readingsMap.entries())) {
        if (matchedReadingKeys.has(key)) continue; // já processado acima
        const [pidStr, batchStr] = key.split('|');
        const productId = Number(pidStr);
        const batch = batchStr || null;

        // REGRA 1: se existe orderItem sem lote para este produto, consolidar (NF-e sem lote)
        const summaryIdx = summary.findIndex(
          s => s.productId === productId && (!s.batch || s.batch === '')
        );

        if (summaryIdx >= 0) {
          // Consolidar: somar unidades lidas ao item sem lote existente no summary
          const existing: typeof summary[number] = summary[summaryIdx];
          const newReceived = (existing.receivedQuantity || 0) + unitsRead;
          const newAddressed = newReceived - (existing.blockedQuantity || 0);
          summary[summaryIdx] = {
            ...existing,
            receivedQuantity: newReceived,
            addressedQuantity: newAddressed,
          };
          // Atualizar também no banco
          const orderItemToUpdate = orderItems.find(
            oi => oi.productId === productId && (!oi.batch || oi.batch === '')
          );
          if (orderItemToUpdate) {
            await db.update(receivingOrderItems)
              .set({
                receivedQuantity: newReceived,
                addressedQuantity: newAddressed,
                updatedAt: new Date()
              })
              .where(eq(receivingOrderItems.id, orderItemToUpdate.id));
          }
          continue;
        }

        // REGRA 2: NF-e tem lote específico mas físico chegou em lotes diferentes.
        // Se a soma total bipada do produto = total esperado do produto → consolidar no primeiro item do produto
        const totalBiped = totalBipedByProduct.get(productId) || 0;
        const totalExpected = totalExpectedByProduct.get(productId) || 0;
        const productSummaryItems = summary.filter(s => s.productId === productId);

        if (totalExpected > 0 && totalBiped === totalExpected && productSummaryItems.length > 0) {
          // Somas batem: distribuir as unidades extras no item existente do produto
          // (atualizar o receivedQuantity do item principal para refletir o total real)
          const mainSummaryIdx = summary.findIndex(s => s.productId === productId);
          const existing: { productId: number; productSku: string; productDescription: string; batch: string | null; expectedQuantity: number; receivedQuantity: number; blockedQuantity: number; addressedQuantity: number } = summary[mainSummaryIdx];
          const newReceived = (existing.receivedQuantity || 0) + unitsRead;
          const newAddressed = newReceived - (existing.blockedQuantity || 0);
          summary[mainSummaryIdx] = {
            ...existing,
            receivedQuantity: newReceived,
            addressedQuantity: newAddressed,
          };
          // Atualizar no banco o item principal do produto
          const mainOrderItem = orderItems.find(oi => oi.productId === productId);
          if (mainOrderItem) {
            await db.update(receivingOrderItems)
              .set({
                receivedQuantity: newReceived,
                addressedQuantity: newAddressed,
                updatedAt: new Date()
              })
              .where(eq(receivingOrderItems.id, mainOrderItem.id));
          }
          // Criar receivingOrderItem extra para rastreabilidade do lote físico (sem afetar divergência)
          await db.insert(receivingOrderItems).values({
            receivingOrderId: orderItems[0]?.receivingOrderId ?? 0,
            tenantId: orderTenantId,
            productId,
            batch,
            uniqueCode: `${productId}-${batch ?? 'SEMLOTE'}-extra`,
            expectedQuantity: 0,    // esperado = 0 (lote físico extra, mas soma OK)
            receivedQuantity: unitsRead,
            addressedQuantity: unitsRead,
            blockedQuantity: 0,
            status: 'completed',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onDuplicateKeyUpdate({ set: { receivedQuantity: unitsRead, addressedQuantity: unitsRead, updatedAt: new Date() } });
          continue;
        }

        // REGRA 3: Lote genuinamente extra (produto não tem item na NF-e OU soma não bate)
        const [product] = await db.select({ sku: products.sku, description: products.description })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);
        summary.push({
          productId,
          productSku: product?.sku || '',
          productDescription: product?.description || '',
          batch,
          expectedQuantity: 0,   // não estava na NF-e como linha separada
          receivedQuantity: unitsRead,
          blockedQuantity: 0,
          addressedQuantity: unitsRead,
        });
      }
      return {
        success: true,
        receivingOrderId: session[0].receivingOrderId,
        receivingOrderCode: order.orderNumber,
        summary,
      };
    }),
  /**
   * 7. Finalizar Conferência (REFATORADO))
   */
  finish: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;

      // TRANSAÇÃO ATÔMICA: Tudo ou nada (mesmo padrão do closeReceivingOrder)
      return await db.transaction(async (tx) => {
        // 1. BUSCAR SESSÃO
        const session = await tx.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);

        if (!session || session.length === 0 || !session[0]) {
          throw new TRPCError({ 
            code: 'NOT_FOUND', 
            message: 'Sessão de conferência não encontrada.' 
          });
        }

        // Buscar receivingOrder para obter tenantId correto
        const [order] = await tx.select()
          .from(receivingOrders)
          .where(eq(receivingOrders.id, session[0].receivingOrderId))
          .limit(1);
        
        if (!order) {
          throw new Error("Ordem de recebimento não encontrada");
        }
        
        const orderTenantId = order.tenantId;

        // 2. CALCULAR addressedQuantity INTERNAMENTE a partir de blindConferenceItems
        // CORREÇÃO DO BUG: finish não depende mais de prepareFinish ter sido chamado antes.
        // A fonte de verdade é blindConferenceItems.unitsRead (total bipado na conferência cega).
        // AGRUPAMENTO POR SKU+LOTE para evitar somar quantidades de lotes diferentes do mesmo SKU.
        const conferenceReadings = await tx.select({
          productId: blindConferenceItems.productId,
          batch: blindConferenceItems.batch,
          expiryDate: sql<string | null>`MAX(${blindConferenceItems.expiryDate})`,
          totalUnitsRead: sql<number>`COALESCE(SUM(${blindConferenceItems.unitsRead}), 0)`,
        })
          .from(blindConferenceItems)
          .where(eq(blindConferenceItems.conferenceId, input.conferenceId))
          .groupBy(blindConferenceItems.productId, blindConferenceItems.batch);

          // Mapa: "productId|batch" → totalUnitsRead da conferência cega
        // Nota: readLabel já atualiza batch/uniqueCode do receivingOrderItem com dados reais da etiqueta.
        const readingsMap = new Map<string, number>();
        // Mapa: "productId|batch" → expiryDate da conferência cega (para propagar a lotes extras)
        const expiryMap = new Map<string, string | null>();
        for (const r of conferenceReadings) {
          const key = `${r.productId}|${r.batch ?? ''}`;
          readingsMap.set(key, Number(r.totalUnitsRead) || 0);
          expiryMap.set(key, r.expiryDate ?? null);
        }
        console.log('[finish] conferenceReadings:', conferenceReadings.length, 'SKU+Lote bipados | orderTenantId:', orderTenantId);
        if (conferenceReadings.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Nenhuma etiqueta foi bipada nesta conferência. Associe ao menos uma etiqueta antes de finalizar.'
          });
        }

        const rawItems = await tx.select({
          id: receivingOrderItems.id,
          productId: receivingOrderItems.productId,
          batch: receivingOrderItems.batch,
          expiryDate: receivingOrderItems.expiryDate,
          serialNumber: receivingOrderItems.serialNumber,
          uniqueCode: receivingOrderItems.uniqueCode,
          labelCode: receivingOrderItems.labelCode,
          tenantId: receivingOrderItems.tenantId,
          blockedQuantity: receivingOrderItems.blockedQuantity,
          expectedQuantity: receivingOrderItems.expectedQuantity,
        })
          .from(receivingOrderItems)
          .where(
            and(
              eq(receivingOrderItems.receivingOrderId, session[0].receivingOrderId),
              eq(receivingOrderItems.tenantId, orderTenantId)
            )
          );

        if (rawItems.length === 0) {
          throw new Error("Nenhum item encontrado para criar inventory");
        }

        // Rastrear quais chaves do readingsMap já foram casadas com um rawItem
        const matchedFinishReadingKeys = new Set<string>();

        // Calcular addressedQuantity para cada item e atualizar receivingOrderItems
        const itemsWithQty = await Promise.all(rawItems.map(async (item) => {
          const itemKey = `${item.productId}|${item.batch ?? ''}`;
          matchedFinishReadingKeys.add(itemKey);
            // Se o item não tem lote (NF-e sem lote), somar TODAS as leituras deste produto
          let blindReadUnits: number;
          const itemHasNoBatch = !item.batch || item.batch.trim() === '';
          // Capturar batch/expiryDate da leitura quando NF-e não tem lote
          let effectiveBatch = item.batch || '';
          let effectiveExpiryDate = item.expiryDate;
          if (itemHasNoBatch) {
            blindReadUnits = 0;
            for (const [rKey, rUnits] of Array.from(readingsMap.entries())) {
              const [rPidStr, rBatch] = rKey.split('|');
              if (Number(rPidStr) === item.productId) {
                blindReadUnits += rUnits;
                matchedFinishReadingKeys.add(rKey); // marcar como processado
                // Propagar batch e expiryDate da primeira leitura encontrada
                if (!effectiveBatch && rBatch) {
                  effectiveBatch = rBatch;
                  effectiveExpiryDate = (expiryMap.get(rKey) as any) || item.expiryDate;
                }
              }
            }
          } else {
            blindReadUnits = readingsMap.get(itemKey) || 0;
          }
          const ncgUnits       = Number(item.blockedQuantity) || 0;
          const totalPhysical  = blindReadUnits + ncgUnits;
          const addressableQty = totalPhysical - ncgUnits; // = blindReadUnits
          // Atualizar receivingOrderItems com os valores calculados (idempotente)
          await tx.update(receivingOrderItems)
            .set({
              receivedQuantity: totalPhysical,
              addressedQuantity: addressableQty,
              status: 'completed',
              updatedAt: new Date(),
            })
            .where(eq(receivingOrderItems.id, item.id));
          return { ...item, batch: effectiveBatch, expiryDate: effectiveExpiryDate, addressedQuantity: addressableQty, blockedQuantity: ncgUnits };
        }));

        console.log('[finish] Items calculados:', itemsWithQty.length, '| bipados com qty>0:', itemsWithQty.filter(i => (i.addressedQuantity || 0) > 0).length);

        // ============================================================
        // REGRA DE CONSOLIDAÇÃO POR PRODUTO (lotes físicos ≠ lotes NF-e)
        // Se a NF-e declara um lote mas o físico chegou em múltiplos lotes,
        // e a SOMA total bipada do produto bate com o TOTAL esperado do produto,
        // consolidar no item principal — sem criar inventory extra.
        // ============================================================

        // Calcular total bipado por produto (todos os lotes)
        const totalBipedByProductFinish = new Map<number, number>();
        for (const [key, units] of Array.from(readingsMap.entries())) {
          const [pidStr] = key.split('|');
          const pid = Number(pidStr);
          totalBipedByProductFinish.set(pid, (totalBipedByProductFinish.get(pid) || 0) + units);
        }

        // Calcular total esperado por produto (todos os rawItems originais da NF-e)
        const totalExpectedByProductFinish = new Map<number, number>();
        for (const ri of rawItems) {
          totalExpectedByProductFinish.set(ri.productId, (totalExpectedByProductFinish.get(ri.productId) || 0) + (ri.expectedQuantity || 0));
        }

        // 2b. CRIAR receivingOrderItems PARA LEITURAS EXTRAS (lotes bipados sem linha na NF-e)
        // Ex: NF-e tem lote específico mas operador bipou lote diferente
        // NÃO inclui itens sem lote na NF-e (já consolidados acima)
        for (const [key, unitsRead] of Array.from(readingsMap.entries())) {
          if (matchedFinishReadingKeys.has(key)) continue;
          const [pidStr, batchStr] = key.split('|');
          const extraProductId = Number(pidStr);
          const extraBatch = batchStr || null;

          // REGRA: se soma total bipada do produto = total esperado do produto,
          // consolidar no item principal (não criar inventory separado)
          const totalBiped = totalBipedByProductFinish.get(extraProductId) || 0;
          const totalExpected = totalExpectedByProductFinish.get(extraProductId) || 0;
          const mainItem = itemsWithQty.find(i => i.productId === extraProductId);

          if (totalExpected > 0 && totalBiped === totalExpected && mainItem) {
            // Somas batem: atualizar o receivedQuantity do item principal para incluir este lote
            const currentReceived = Number(mainItem.addressedQuantity) || 0;
            const newAddressed = currentReceived + unitsRead;
            // ✅ CORREÇÃO: buscar expiryDate do mapa de leituras para propagar ao item consolidado
            const consolidatedExpiryDate = expiryMap.get(key) ?? null;
            // Atualizar no banco — propagar expiryDate se o item principal ainda não tiver
            await tx.update(receivingOrderItems)
              .set({
                receivedQuantity: newAddressed + (Number(mainItem.blockedQuantity) || 0),
                addressedQuantity: newAddressed,
                // Propagar expiryDate se o item principal não tiver (lote NF-e sem validade)
                expiryDate: mainItem.expiryDate ? (mainItem.expiryDate as any) : (toDateStr(consolidatedExpiryDate) as any),
                updatedAt: new Date(),
              })
              .where(eq(receivingOrderItems.id, mainItem.id));
            // Atualizar no array em memória
            const mainIdx = itemsWithQty.findIndex(i => i.id === mainItem.id);
            if (mainIdx >= 0) {
              itemsWithQty[mainIdx] = { 
                ...itemsWithQty[mainIdx], 
                addressedQuantity: newAddressed,
                expiryDate: itemsWithQty[mainIdx].expiryDate ?? consolidatedExpiryDate,
              };
            }
            // Registrar receivingOrderItem de rastreabilidade (expectedQuantity=0, não afeta divergência)
            await tx.insert(receivingOrderItems).values({
              receivingOrderId: session[0].receivingOrderId,
              tenantId: orderTenantId,
              productId: extraProductId,
              batch: extraBatch,
              // ✅ CORREÇÃO: propagar expiryDate ao item de rastreabilidade
              expiryDate: toDateStr(consolidatedExpiryDate) as any,
              uniqueCode: `${extraProductId}-${extraBatch ?? 'SEMLOTE'}-extra`,
              expectedQuantity: 0,
              receivedQuantity: unitsRead,
              addressedQuantity: unitsRead,
              blockedQuantity: 0,
              status: 'completed',
              createdAt: new Date(),
              updatedAt: new Date(),
            }).onDuplicateKeyUpdate({ set: { receivedQuantity: unitsRead, addressedQuantity: unitsRead, expiryDate: toDateStr(consolidatedExpiryDate) as any, updatedAt: new Date() } });
            console.log(`[finish] Lote físico extra consolidado (soma OK): ${extraProductId}|${extraBatch} | ${unitsRead} un.`);
            continue;
          }

          // Lote genuinamente extra: criar inventory separado
          const [extraProduct] = await tx.select({ sku: products.sku })
            .from(products).where(eq(products.id, extraProductId)).limit(1);
          const extraUniqueCode = extraProduct ? `${extraProduct.sku}-${extraBatch ?? 'SEMLOTE'}` : `${extraProductId}-${extraBatch ?? ''}`;
          // ✅ CORREÇÃO: buscar expiryDate do mapa de leituras para propagar ao item extra
          const extraExpiryDate = expiryMap.get(key) ?? null;
          const [newItem] = await tx.insert(receivingOrderItems).values({
            receivingOrderId: session[0].receivingOrderId,
            tenantId: orderTenantId,
            productId: extraProductId,
            batch: extraBatch,
            expiryDate: toDateStr(extraExpiryDate) as any,
            uniqueCode: extraUniqueCode,
            expectedQuantity: 0,
            receivedQuantity: unitsRead,
            addressedQuantity: unitsRead,
            blockedQuantity: 0,
            status: 'completed',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).$returningId();
          itemsWithQty.push({
            id: newItem.id,
            productId: extraProductId,
            batch: extraBatch,
            expiryDate: extraExpiryDate,
            serialNumber: null,
            uniqueCode: extraUniqueCode,
            labelCode: null,
            tenantId: orderTenantId,
            blockedQuantity: 0,
            expectedQuantity: 0,
            addressedQuantity: unitsRead,
          });
          console.log(`[finish] Leitura extra criada (soma não bate): ${extraUniqueCode} | ${unitsRead} un.`);
        }

        // 3. BUSCAR ZONA E ENDEREÇO DE RECEBIMENTO (REC))
        const zoneREC = await tx.select()
          .from(warehouseZones)
          .where(eq(warehouseZones.code, 'REC'))
          .limit(1);

        if (zoneREC.length === 0) {
          throw new Error("Zona de Recebimento ('REC') não configurada");
        }

        const recLocation = await tx.select()
          .from(warehouseLocations)
          .where(
            and(
              eq(warehouseLocations.tenantId, orderTenantId),
              eq(warehouseLocations.zoneId, zoneREC[0].id)
            )
          )
          .limit(1);

        if (recLocation.length === 0) {
          throw new Error("Endereço de recebimento não encontrado para este tenant");
        }

        const locationId = recLocation[0].id;

        // 4. FILTRAR apenas itens que foram bipados (addressedQuantity > 0 ou blockedQuantity > 0)
        // Itens não bipados (addressedQuantity = 0 e blockedQuantity = 0) não geram inventory
        const itemsToProcess = itemsWithQty.filter(
          (item) => (Number(item.addressedQuantity) || 0) > 0 || (Number(item.blockedQuantity) || 0) > 0
        );

        console.log(`[finish] Total itens OR: ${itemsWithQty.length} | Itens a processar (bipados): ${itemsToProcess.length}`);

        // 4. VALIDATION GUARD: Validar apenas os itens a processar
        const validationErrors: string[] = [];
        
        for (const item of itemsToProcess) {
          if (!item.productId) {
            validationErrors.push(`Item ${item?.uniqueCode || 'desconhecido'}: productId ausente`);
          }
          // uniqueCode pode ser gerado a partir de sku+batch se ausente
          // labelCode não é obrigatório — itens com múltiplas etiquetas usam uniqueCode para rastreabilidade
        }
        
        if (validationErrors.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Validação falhou. Erros encontrados:\n${validationErrors.join('\n')}`
          });
        }

        // 5. CRIAR 1 INVENTORY POR receivingOrderItem (1 uniqueCode = 1 inventory)
        // Apenas itens bipados (addressedQuantity > 0 ou blockedQuantity > 0)
        for (const item of itemsToProcess) {
          const addressedQty = Number(item.addressedQuantity) || 0;
          console.log('[finish] Criando inventory para item:', item.uniqueCode, 'quantity:', addressedQty);
          
          // Buscar se já existe inventory para este uniqueCode
          const existingInventory = await tx.select()
            .from(inventory)
            .where(
              and(
                eq(inventory.uniqueCode, item.uniqueCode || ""),
                eq(inventory.tenantId, orderTenantId),
                eq(inventory.locationZone, 'REC')
              )
            )
            .limit(1);

          if (existingInventory.length > 0) {
            // Atualizar inventory existente
            // ✅ CORREÇÃO: propagar batch e expiryDate (podem ter sido atualizados no associateLabel)
            await tx.update(inventory)
              .set({
                quantity: addressedQty,
                locationId: locationId,
                batch: item.batch || "",
                expiryDate: toDateStr(item.expiryDate ? String(item.expiryDate) : null) as any,
                labelCode: item.labelCode || null,
                status: "available",
                updatedAt: new Date()
              })
              .where(eq(inventory.id, existingInventory[0].id));
          } else {
            // Criar novo inventory (idempotente: ON DUPLICATE KEY UPDATE evita erro em retentativas)
            await tx.insert(inventory).values({
              tenantId: orderTenantId,
              productId: item.productId,
              locationId: locationId,
              batch: item.batch || "",
              expiryDate: toDateStr(item.expiryDate) as any,
              uniqueCode: item.uniqueCode || "",
              labelCode: item.labelCode || null,
              serialNumber: null,
              locationZone: 'REC',
              quantity: addressedQty,
              reservedQuantity: 0,
              status: "available",
              createdAt: new Date(),
              updatedAt: new Date(),
            }).onDuplicateKeyUpdate({
              // ✅ Se o labelCode já existe (ex: retentativa), atualiza quantity, locationId e rastreabilidade
              set: {
                quantity: addressedQty,
                locationId: locationId,
                locationZone: 'REC',
                batch: item.batch || "",
                expiryDate: toDateStr(item.expiryDate ? String(item.expiryDate) : null) as any,
                labelCode: item.labelCode || null,
                status: "available",
                updatedAt: new Date(),
              },
            });
          }

          // ✅ REGISTRAR MOVIMENTO DE RECEBIMENTO (rastreabilidade ANVISA)
          if (addressedQty > 0) {
            await tx.insert(inventoryMovements).values({
              tenantId: orderTenantId,
              productId: item.productId,
              batch: item.batch || "",
              expiryDate: toDateStr(item.expiryDate) as any,
              uniqueCode: item.uniqueCode || "",
              labelCode: item.labelCode || null,
              serialNumber: null,
              fromLocationId: null,
              toLocationId: locationId,
              quantity: addressedQty,
              movementType: 'receiving',
              referenceType: 'receiving_order',
              referenceId: session[0].receivingOrderId,
              performedBy: userId,
              notes: `Recebimento via conferência cega #${input.conferenceId}`,
              // Rastreabilidade UOM
              originalUnit: null,   // Preenchido futuramente pelo motor UOM
              originalQty: null,
              conversionFactor: null,
              conversionSource: 'none',
              createdAt: new Date(),
            });
          }
        }

        // 5b. CRIAR INVENTORY PARA ITENS COM NCG (blockedQuantity > 0)
        const ncgZone = await tx.select()
          .from(warehouseZones)
          .where(eq(warehouseZones.code, 'NCG'))
          .limit(1);
        if (ncgZone.length > 0) {
          const ncgLocation = await tx.select()
            .from(warehouseLocations)
            .where(
              and(
                eq(warehouseLocations.tenantId, orderTenantId),
                eq(warehouseLocations.zoneId, ncgZone[0].id)
              )
            )
            .limit(1);
          if (ncgLocation.length > 0) {
            const ncgLocationId = ncgLocation[0].id;
            const ncgZoneCode = ncgLocation[0].zoneCode || 'NCG';
            for (const item of itemsWithQty) {
              const blockedQty = Number(item.blockedQuantity) || 0;
              if (blockedQty <= 0) continue;
              const ncgUniqueCode = `${item.uniqueCode || ""}-NCG`;
              const existingDamaged = await tx.select()
                .from(inventory)
                .where(
                  and(
                    eq(inventory.uniqueCode, ncgUniqueCode), // ✅ busca pelo uniqueCode com sufixo -NCG
                    eq(inventory.tenantId, orderTenantId),
                    eq(inventory.status, "quarantine"),
                    eq(inventory.locationId, ncgLocation[0].id)
                  )
                )
                .limit(1);
              if (existingDamaged.length > 0) {
                await tx.update(inventory)
                  .set({ quantity: blockedQty, locationId: ncgLocationId, updatedAt: new Date() })
                  .where(eq(inventory.id, existingDamaged[0].id));
              } else {
                // ✅ labelCode = null no registro NCG para evitar violação da UNIQUE KEY (labelCode, tenantId)
                // O labelCode já está no inventory REC e na tabela nonConformities para rastreabilidade
                // O uniqueCode NCG usa sufixo '-NCG' para diferenciar do registro REC
                await tx.insert(inventory).values({
                  tenantId: orderTenantId,
                  productId: item.productId,
                  locationId: ncgLocationId,
                  batch: item.batch || "",
                  expiryDate: toDateStr(item.expiryDate) as any,
                  uniqueCode: `${item.uniqueCode || ""}-NCG`,
                  labelCode: null, // ✅ null para evitar UNIQUE KEY violation com o registro REC
                  serialNumber: null,
                  locationZone: ncgZoneCode,
                  quantity: blockedQty,
                  reservedQuantity: 0,
                  status: "quarantine",
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              }
            }
          }
        }
        // 5c. ATUALIZAR STATUS DOS ENDEREÇOS
        await tx.update(warehouseLocations)
          .set({ status: "occupied", updatedAt: new Date() })
          .where(eq(warehouseLocations.id, locationId));
        if (ncgZone.length > 0) {
          const ncgLocForUpdate = await tx.select({ id: warehouseLocations.id })
            .from(warehouseLocations)
            .where(
              and(
                eq(warehouseLocations.tenantId, orderTenantId),
                eq(warehouseLocations.zoneId, ncgZone[0].id)
              )
            )
            .limit(1);
          if (ncgLocForUpdate.length > 0) {
            await tx.update(warehouseLocations)
              .set({ status: "quarantine", updatedAt: new Date() })
              .where(eq(warehouseLocations.id, ncgLocForUpdate[0].id));
          }
        }
        // 5. ATIVAR ETIQUETAS (RECEIVING → AVAILABLE)
        // Buscar todos os produtos conferidos para liberar suas etiquetas
        const productIds = itemsWithQty.map(item => item.productId);
        
        // Etiquetas ativas: status controlado por inventory.status (sem atualização em labelAssociations)

        // 5. FINALIZAR SESSÃO
        await tx.update(blindConferenceSessions)
          .set({
            status: "completed",
            finishedAt: new Date()
          })
          .where(eq(blindConferenceSessions.id, input.conferenceId));

        // 7. ATUALIZAR STATUS DA ORDEM DE RECEBIMENTO
        await tx.update(receivingOrders)
          .set({
            status: "completed",
            updatedAt: new Date()
          })
          .where(eq(receivingOrders.id, session[0].receivingOrderId));

          return {
            success: true,
            message: "Conferência finalizada com sucesso",
            itemsProcessed: itemsWithQty.length
          };
      }); // Fim da transação atômica
    }),

  /**
   * 7. Buscar Data de Validade do XML (getExpiryDateFromXML)
   * Busca expiryDate de receivingOrderItems por SKU+Lote
   */
  getExpiryDateFromXML: tenantProcedure
    .input(z.object({
      sku: z.string(),
      batch: z.string(),
      conferenceId: z.number().optional(), // Opcional: para buscar orderTenantId
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;

      // ✅ USA orderTenantId se conferenceId for fornecido, caso contrário usa effectiveTenantId
      const orderTenantId = input.conferenceId
        ? await getOrderTenantId(db, input.conferenceId)
        : effectiveTenantId;

      // Gera uniqueCode (SKU+Lote)
      const uniqueCode = getUniqueCode(input.sku, input.batch);

      // Busca item da NF-e por uniqueCode
      const item = await db.select({
        expiryDate: receivingOrderItems.expiryDate,
        expectedQuantity: receivingOrderItems.expectedQuantity,
      })
        .from(receivingOrderItems)
        .where(
          and(
            eq(receivingOrderItems.uniqueCode, uniqueCode),
            eq(receivingOrderItems.tenantId, orderTenantId) // ✅ USA orderTenantId
          )
        )
        .limit(1);

      if (item.length === 0) {
        return {
          found: false,
          expiryDate: null,
          expectedQuantity: null,
        };
      }

      return {
        found: true,
        expiryDate: item[0].expiryDate,
        expectedQuantity: item[0].expectedQuantity,
      };
    }),

  /**
   * 8. Fechar Ordem de Recebimento (closeReceivingOrder)
   * Valida divergências, atualiza saldos e ativa etiquetas (RECEIVING → AVAILABLE)
   */
  closeReceivingOrder: tenantProcedure
    .input(z.object({
      receivingOrderId: z.number(),
      adminApprovalToken: z.string().optional(), // Senha do admin se houver divergência
      tenantId: z.number().optional(), // Opcional: Admin Global pode enviar
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;
      const userId = ctx.user.id;
      // ✅ USA orderTenantId (tenant da ordem) para buscar blindConferenceItems
      const [receivingOrderForTenant] = await db.select({ tenantId: receivingOrders.tenantId })
        .from(receivingOrders)
        .where(eq(receivingOrders.id, input.receivingOrderId))
        .limit(1);
      if (!receivingOrderForTenant) throw new TRPCError({ code: "NOT_FOUND", message: "Ordem de recebimento não encontrada" });
      const orderTenantId = receivingOrderForTenant.tenantId;
      // TRANSAÇÃO ATÔMICA: Tudo ou nadaa
      return await db.transaction(async (tx) => {
        // 1. BUSCAR TODOS OS ITENS ESPERADOS (XML)
        const items = await tx.select()
          .from(receivingOrderItems)
          .where(
            and(
              eq(receivingOrderItems.receivingOrderId, input.receivingOrderId),
              eq(receivingOrderItems.tenantId, orderTenantId) // ✅ USA orderTenantId (tenant da ordem)
            )
          );

        if (items.length === 0) {
          throw new Error("Ordem de recebimento não possui itens");
        }

        // ✅ VALIDAÇÃO: Impedir fechamento se nenhum item foi conferido
        const totalReceived = items.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);
        console.log("[closeReceivingOrder] Total recebido:", totalReceived);
        
        if (totalReceived === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Não é possível finalizar uma ordem sem nenhum item conferido. Verifique se as etiquetas foram associadas corretamente."
          });
        }

        const divergences: string[] = [];

        for (const item of items) {
          // 2. BUSCAR TOTAL CONFERIDO (blindConferenceItems)
          const conferenceData = await tx.select({
            totalReceived: sql<number>`COALESCE(SUM(${blindConferenceItems.packagesRead}), 0)`,
          })
            .from(blindConferenceItems)
            .where(
              and(
                eq(blindConferenceItems.productId, item.productId),
                eq(blindConferenceItems.batch, item.batch || ""),
                eq(blindConferenceItems.tenantId, orderTenantId)
              )
            );

          const receivedPackages = Number(conferenceData[0]?.totalReceived || 0);
          const expectedPackages = item.expectedQuantity;

          // 3. VALIDAÇÃO DE DIVERGÊNCIA
          if (receivedPackages !== expectedPackages) {
            const product = await tx.select({ sku: products.sku, description: products.description })
              .from(products)
              .where(eq(products.id, item.productId))
              .limit(1);

            const productInfo = product[0] ? `${product[0].sku} - ${product[0].description}` : `ID ${item.productId}`;
            divergences.push(
              `${productInfo}: Esperado ${expectedPackages}, Recebido ${receivedPackages}`
            );
          }
        }

        // 4. SE HOUVER DIVERGÊNCIA, EXIGIR APROVAÇÃO ADMIN
        if (divergences.length > 0 && !input.adminApprovalToken) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Divergências encontradas:\n${divergences.join('\n')}\n\nRequer aprovação de administrador.`
          });
        }

        // 5. ATUALIZAR SALDOS E STATUS DOS ITENS
        for (const item of items) {
          const conferenceData = await tx.select({
            totalReceived: sql<number>`COALESCE(SUM(${blindConferenceItems.packagesRead}), 0)`,
          })
            .from(blindConferenceItems)
            .where(
              and(
                eq(blindConferenceItems.productId, item.productId),
                eq(blindConferenceItems.batch, item.batch || ""),
                eq(blindConferenceItems.tenantId, orderTenantId)
              )
            );

          const receivedUnits = Number(conferenceData[0]?.totalReceived || 0);
          const blockedUnits = item.blockedQuantity || 0;
          const addressedUnits = receivedUnits - blockedUnits;

          await tx.update(receivingOrderItems)
            .set({
              receivedQuantity: receivedUnits,
              blockedQuantity: blockedUnits,
              addressedQuantity: addressedUnits,
              approvedBy: divergences.length > 0 ? userId : null,
              status: "approved",
            })
            .where(eq(receivingOrderItems.id, item.id));
        }

        // 6. ETIQUETAS ATIVAS: status controlado por inventory.status (sem atualização em labelAssociations)

        // 7. FINALIZAR ORDEM DE RECEBIMENTO
        await tx.update(receivingOrders)
          .set({
            status: "completed",
            updatedAt: new Date()
          })
          .where(eq(receivingOrders.id, input.receivingOrderId));

        return {
          success: true,
          message: divergences.length > 0 
            ? `Ordem finalizada com ${divergences.length} divergência(s) aprovada(s)` 
            : "Ordem finalizada com sucesso",
          itemsProcessed: items.length,
          divergences: divergences
        };
      });
    }),

  /**
   * checkLabelExists: Verifica se uma etiqueta já está cadastrada em labelAssociations
   * Usado no fluxo NCG para autofill do produto quando a etiqueta já existe
   */
  checkLabelExists: tenantProcedure
    .input(z.object({
      labelCode: z.string(),
      conferenceId: z.number().optional(), // Opcional: para buscar orderTenantId
      tenantId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { effectiveTenantId, isGlobalAdmin } = ctx;

      // ✅ USA orderTenantId se conferenceId for fornecido, caso contrário usa effectiveTenantId
      const orderTenantId = input.conferenceId
        ? await getOrderTenantId(db, input.conferenceId)
        : effectiveTenantId;

      // Buscar etiqueta em labelAssociations (cadastro global, sem filtro de tenant)
      const [label] = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);

      if (!label) {
        return { exists: false, label: null, product: null };
      }

      // Buscar dados do produto vinculado à etiqueta
      const [product] = await db.select()
        .from(products)
        .where(eq(products.id, label.productId))
        .limit(1);

      return {
        exists: true,
        label: {
          id: label.id,
          labelCode: label.labelCode,
          productId: label.productId,
          batch: label.batch,
          expiryDate: label.expiryDate,
          unitsPerBox: label.unitsPerBox,
        },
        product: product ? {
          id: product.id,
          sku: product.sku,
          description: product.description,
        } : null,
      };
    }),

  /**
   * Liberação Gerencial de Estoque Restrito
   * Autentica um usuário admin/manager e libera itens com status blocked ou quarantine
   * para o status available, registrando em auditLogs.
   *
   * blocked: impede entrada E saída — requer liberação gerencial
   * quarantine: permite entrada, impede saída — requer liberação gerencial
   */
  releaseInventory: tenantProcedure
    .input(z.object({
      inventoryId: z.number().optional(),   // Liberar por ID de registro de estoque
      labelCode: z.string().optional(),     // Liberar por código de etiqueta (LPN)
      adminLogin: z.string().min(1),        // Login do admin autorizador
      adminPassword: z.string().min(1),     // Senha do admin autorizador
      reason: z.string().min(1),            // Motivo da liberação
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // 1. Autenticar o admin
      const [adminUser] = await db
        .select({
          id: systemUsers.id,
          tenantId: systemUsers.tenantId,
          fullName: systemUsers.fullName,
          passwordHash: systemUsers.passwordHash,
          active: systemUsers.active,
          failedLoginAttempts: systemUsers.failedLoginAttempts,
          lockedUntil: systemUsers.lockedUntil,
        })
        .from(systemUsers)
        .where(eq(systemUsers.login, input.adminLogin))
        .limit(1);

      if (!adminUser) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Credenciais inválidas." });
      }
      if (!adminUser.active) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Usuário inativo." });
      }
      if (adminUser.lockedUntil && adminUser.lockedUntil > new Date()) {
        const mins = Math.ceil((adminUser.lockedUntil.getTime() - Date.now()) / 60000);
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Conta bloqueada. Tente em ${mins} min.` });
      }

      const hashedInput = crypto.createHash("sha256").update(input.adminPassword).digest("hex");
      if (hashedInput !== adminUser.passwordHash) {
        const newAttempts = (adminUser.failedLoginAttempts ?? 0) + 1;
        const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
        await db.update(systemUsers).set({
          failedLoginAttempts: newAttempts,
          ...(lockedUntil ? { lockedUntil } : {}),
        }).where(eq(systemUsers.id, adminUser.id));
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Credenciais inválidas." });
      }

      // Reset tentativas falhas
      await db.update(systemUsers)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(systemUsers.id, adminUser.id));

      // 2. Verificar se o admin tem permissão (role admin ou manager na tabela users OAuth)
      // O ctx.user é o usuário que fez a requisição; o admin autorizador é adminUser (systemUsers)
      // Verificar role do adminUser via userRoles
      const { userRoles, roles } = await import("../drizzle/schema");
      const adminRoles = await db
        .select({ code: roles.code })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(userRoles.userId, adminUser.id));

      const allowedRoles = ["ADMIN_SISTEMA", "SUPERVISOR", "GERENTE", "admin", "manager"];
      const hasAdminRole = adminRoles.some(r => allowedRoles.includes(r.code));
      if (!hasAdminRole) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Usuário não possui permissão de gerente/administrador para liberar estoque." });
      }

      // 3. Buscar o(s) registro(s) de estoque a liberar
      let inventoryRecords: any[] = [];
      if (input.inventoryId) {
        inventoryRecords = await db
          .select()
          .from(inventory)
          .where(eq(inventory.id, input.inventoryId));
      } else if (input.labelCode) {
        inventoryRecords = await db
          .select()
          .from(inventory)
          .where(eq(inventory.labelCode, input.labelCode));
      } else {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Informe inventoryId ou labelCode." });
      }

      if (inventoryRecords.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Registro de estoque não encontrado." });
      }

      const restricted = inventoryRecords.filter((r: any) => r.status === "blocked" || r.status === "quarantine");
      if (restricted.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Estoque não está em status restrito (blocked/quarantine)." });
      }

      // 4. Liberar: atualizar status para available
      const releasedIds: number[] = [];
      for (const rec of restricted) {
        await db.update(inventory)
          .set({ status: "available" })
          .where(eq(inventory.id, rec.id));
        releasedIds.push(rec.id);

        // 5. Registrar em auditLogs
        await db.insert(auditLogs).values({
          tenantId: rec.tenantId,
          userId: adminUser.id,
          action: "release_inventory",
          entityType: "inventory",
          entityId: rec.id,
          oldValue: JSON.stringify({ status: rec.status }),
          newValue: JSON.stringify({ status: "available", reason: input.reason }),
          signature: crypto
            .createHash("sha256")
            .update(`${adminUser.id}:${rec.id}:${input.reason}:${Date.now()}`)
            .digest("hex"),
        });
      }

      return {
        ok: true,
        releasedCount: releasedIds.length,
        releasedIds,
        authorizedBy: adminUser.fullName,
      };
    }),

  /**
   * Apagar registro de conferência de um item (produto+lote)
   * Remove blindConferenceItem, reverte labelAssociations e labelReadings,
   * e zera receivedQuantity em receivingOrderItems para permitir nova associação.
   */
  deleteConferenceItem: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      productId: z.number(),
      batch: z.string().nullable(),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const orderTenantId = await getOrderTenantId(db, input.conferenceId);
      const batchValue = input.batch || "";

      // 1. VERIFICAR SE ITEM EXISTE
      const [conferenceItem] = await db.select()
        .from(blindConferenceItems)
        .where(and(
          eq(blindConferenceItems.conferenceId, input.conferenceId),
          eq(blindConferenceItems.productId, input.productId),
          eq(blindConferenceItems.batch, batchValue),
          eq(blindConferenceItems.tenantId, orderTenantId)
        ))
        .limit(1);

      if (!conferenceItem) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Item não encontrado na conferência" });
      }

      // 2. BUSCAR ETIQUETAS ASSOCIADAS A ESTE PRODUTO+LOTE NESTA CONFERÊNCIA
      // As etiquetas são identificadas via labelReadings (sessionId = 'R{conferenceId}')
      const sessionIdStr = `R${input.conferenceId}`;
      const readings = await db.select({
        associationId: labelReadings.associationId,
        labelCode: labelReadings.labelCode,
      })
        .from(labelReadings)
        .innerJoin(labelAssociations, eq(labelReadings.associationId, labelAssociations.id))
        .where(and(
          eq(labelReadings.sessionId, sessionIdStr),
          eq(labelAssociations.productId, input.productId),
          sql`COALESCE(${labelAssociations.batch}, '') = ${batchValue}`,
          eq(labelAssociations.tenantId, orderTenantId)
        ));

      const associationIds = Array.from(new Set(readings.map(r => r.associationId).filter(Boolean))) as number[];
      const labelCodes = Array.from(new Set(readings.map(r => r.labelCode).filter(Boolean))) as string[];

      // 3. APAGAR labelReadings DESTA SESSÃO PARA ESTE PRODUTO+LOTE
      if (labelCodes.length > 0) {
        for (const lc of labelCodes) {
          await db.delete(labelReadings)
            .where(and(
              eq(labelReadings.sessionId, sessionIdStr),
              eq(labelReadings.labelCode, lc)
            ));
        }
      }

      // 4. APAGAR labelAssociations (etiquetas criadas nesta conferência para este produto+lote)
      // labelAssociations é global: filtrar apenas por id
      if (associationIds.length > 0) {
        for (const aid of associationIds) {
          await db.delete(labelAssociations)
            .where(eq(labelAssociations.id, aid));
        }
      }

      // 5. APAGAR blindConferenceItem
      await db.delete(blindConferenceItems)
        .where(and(
          eq(blindConferenceItems.conferenceId, input.conferenceId),
          eq(blindConferenceItems.productId, input.productId),
          eq(blindConferenceItems.batch, batchValue),
          eq(blindConferenceItems.tenantId, orderTenantId)
        ));

      // 6. REVERTER receivedQuantity EM receivingOrderItems PARA 0
      // Buscar o receivingOrderId da sessão
      const [session] = await db.select({ receivingOrderId: blindConferenceSessions.receivingOrderId })
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);

      if (session) {
        await db.update(receivingOrderItems)
          .set({
            receivedQuantity: 0,
            labelCode: null,
            status: 'pending' as any,
            updatedAt: new Date(),
          })
          .where(and(
            eq(receivingOrderItems.receivingOrderId, session.receivingOrderId),
            eq(receivingOrderItems.productId, input.productId),
            sql`COALESCE(${receivingOrderItems.batch}, '') = ${batchValue}`,
            eq(receivingOrderItems.tenantId, orderTenantId)
          ));
      }

      return {
        success: true,
        message: "Registro de conferência apagado com sucesso",
        deletedAssociations: associationIds.length,
        deletedReadings: readings.length,
      };
    }),

  /**
   * Corrigir última leitura como caixa fracionada
   * Subtrai unitsPerBox e adiciona fractionalQty no blindConferenceItems e receivingOrderItem
   */
  correctFractionalBox: tenantProcedure
    .input(z.object({
      conferenceId: z.number(),
      labelCode: z.string(),
      fractionalQty: z.number().int().min(1),
      tenantId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const { effectiveTenantId } = ctx;

      // Buscar sessão de conferência
      const [conference] = await db.select()
        .from(blindConferenceSessions)
        .where(eq(blindConferenceSessions.id, input.conferenceId))
        .limit(1);
      if (!conference) throw new TRPCError({ code: 'NOT_FOUND', message: 'Sessão de conferência não encontrada' });

      const [order] = await db.select({ tenantId: receivingOrders.tenantId })
        .from(receivingOrders)
        .where(eq(receivingOrders.id, conference.receivingOrderId))
        .limit(1);
      const orderTenantId = order?.tenantId || effectiveTenantId;

      // Buscar a etiqueta para obter unitsPerBox (labelAssociations é global, sem filtro de tenant)
      const [label] = await db.select()
        .from(labelAssociations)
        .where(eq(labelAssociations.labelCode, input.labelCode))
        .limit(1);
      if (!label) throw new TRPCError({ code: 'NOT_FOUND', message: 'Etiqueta não encontrada' });

      const diff = input.fractionalQty - label.unitsPerBox; // negativo = redução

      // Atualizar blindConferenceItems: ajustar unitsRead
      await db.update(blindConferenceItems)
        .set({
          unitsRead: sql`${blindConferenceItems.unitsRead} + ${diff}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(blindConferenceItems.conferenceId, input.conferenceId),
          eq(blindConferenceItems.productId, label.productId),
          sql`COALESCE(${blindConferenceItems.batch}, '') = ${label.batch || ''}`
        ));

      // Sincronizar receivingOrderItem
      const [productForSync] = await db.select({ sku: products.sku })
        .from(products)
        .where(eq(products.id, label.productId))
        .limit(1);
      if (productForSync) {
        const uniqueCode = getUniqueCode(productForSync.sku, label.batch || null);
        await db.update(receivingOrderItems)
          .set({
            receivedQuantity: sql`GREATEST(0, ${receivingOrderItems.receivedQuantity} + ${diff})`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(receivingOrderItems.receivingOrderId, conference.receivingOrderId),
            eq(receivingOrderItems.uniqueCode, uniqueCode),
            eq(receivingOrderItems.tenantId, orderTenantId)
          ));
      }

      // Atualizar o labelReading mais recente com a quantidade corrigida
      const sessionIdStr = `R${input.conferenceId}`;
      const [lastReading] = await db.select()
        .from(labelReadings)
        .where(and(
          eq(labelReadings.sessionId, sessionIdStr),
          eq(labelReadings.labelCode, input.labelCode)
        ))
        .orderBy(sql`${labelReadings.id} DESC`)
        .limit(1);
      if (lastReading) {
        await db.update(labelReadings)
          .set({ unitsAdded: input.fractionalQty })
          .where(eq(labelReadings.id, lastReading.id));
      }

      return { success: true, unitsPerBox: label.unitsPerBox, fractionalQty: input.fractionalQty, diff };
    }),
});
