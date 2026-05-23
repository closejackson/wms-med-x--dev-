import { eq, and, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { 
  pickingOrders, 
  pickingOrderItems,
  inventory,
  inventoryMovements,
  products,
  contracts,
  warehouseLocations,
  productConversions
} from "../../drizzle/schema";

// ============================================================================
// UOM-AWARE: RESOLUÇÃO DE FATOR DE CONVERSÃO PARA PICKING
// ============================================================================

/**
 * Resultado da resolução do fator de conversão para picking.
 * Contém o fator aplicado, a fonte (dinâmica ou fallback) e o log de auditoria.
 */
export interface PickingConversionResult {
  /** Fator de conversão para a unidade base (UN). Ex: 1 CX = 12 UN → factor = 12 */
  factor: number;
  /** Quantidade convertida para unidade base */
  quantityInUnits: number;
  /** Fonte do fator: 'productConversions' (dinâmico) ou 'unitsPerBox_fallback' (estático) */
  source: "productConversions" | "unitsPerBox_fallback" | "unit_passthrough";
  /** Código da unidade solicitada (CX, FD, UN...) */
  unitCode: string;
  /** Log de auditoria para rastreabilidade ANVISA */
  auditLog: string;
}

/**
 * Resolve o fator de conversão para picking de forma UOM-Aware.
 *
 * Prioridade:
 *   1. productConversions (fator dinâmico por tenant + produto + unidade)
 *   2. products.unitsPerBox (fallback estático, com aviso de auditoria)
 *   3. Erro bloqueante se nenhum fator for encontrado e a unidade não for base
 *
 * Validação de fração:
 *   Se requestedQuantity * factor resultar em fração (ex: 10.33 UN),
 *   a operação é BLOQUEADA com TRPCError BAD_REQUEST.
 *
 * @param tenantId   - ID do tenant (cliente)
 * @param productId  - ID do produto
 * @param requestedQuantity - Quantidade solicitada na unidade do pedido
 * @param requestedUM - Unidade do pedido: "unit" | "box" | "pallet" ou código livre (CX, FD...)
 * @param productSku - SKU do produto (para mensagens de erro)
 */
export async function resolvePickingFactor(
  tenantId: number,
  productId: number,
  requestedQuantity: number,
  requestedUM: string,
  productSku: string
): Promise<PickingConversionResult> {
  // Normalizar unidade: "unit" e "UN" são passthrough (fator = 1)
  const normalizedUM = requestedUM.toUpperCase();
  if (normalizedUM === "UNIT" || normalizedUM === "UN") {
    return {
      factor: 1,
      quantityInUnits: requestedQuantity,
      source: "unit_passthrough",
      unitCode: "UN",
      auditLog: `[PICKING UOM] produto=${productSku} | unidade=UN | fator=1 | qtd_solicitada=${requestedQuantity} | qtd_base=${requestedQuantity} | fonte=unit_passthrough`,
    };
  }

  // Mapear alias de enum para código livre
  const unitCodeMap: Record<string, string> = {
    BOX: "CX",
    PALLET: "PL",
    PCT: "PCT",
    FD: "FD",
    CX: "CX",
    PL: "PL",
  };
  const unitCode = unitCodeMap[normalizedUM] ?? normalizedUM;

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

  // 1. Tentar buscar fator dinâmico em productConversions (tenant-específico)
  const [convRow] = await db
    .select({
      factorToBase: productConversions.factorToBase,
      roundingStrategy: productConversions.roundingStrategy,
    })
    .from(productConversions)
    .where(
      and(
        eq(productConversions.tenantId, tenantId),
        eq(productConversions.productId, productId),
        eq(productConversions.unitCode, unitCode)
      )
    )
    .limit(1);

  let factor: number;
  let source: PickingConversionResult["source"];

  if (convRow) {
    factor = parseFloat(String(convRow.factorToBase));
    source = "productConversions";
  } else {
    // 2. Fallback: buscar unitsPerBox do produto (campo estático)
    const [prod] = await db
      .select({ unitsPerBox: products.unitsPerBox })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!prod?.unitsPerBox || prod.unitsPerBox <= 0) {
      // 3. Nenhum fator disponível → BLOQUEAR a reserva
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Erro de Conversão: Produto ${productSku} não possui fator de conversão cadastrado para a unidade "${unitCode}". Cadastre o fator em Unidades de Medida antes de criar o pedido.`,
      });
    }

    factor = prod.unitsPerBox;
    source = "unitsPerBox_fallback";
    console.warn(
      `[PICKING UOM] Fallback para products.unitsPerBox — produto ${productSku} (id=${productId}) não tem fator em productConversions para ${unitCode}. ` +
      `Cadastre o fator para garantir rastreabilidade ANVISA.`
    );
  }

  // Calcular quantidade em unidade base
  const rawQuantityInUnits = requestedQuantity * factor;

  // Validação de fração: resultado deve ser inteiro (medicamentos são dispensados em unidades inteiras)
  const FRACTION_TOLERANCE = 0.001;
  const fractionalPart = Math.abs(rawQuantityInUnits - Math.round(rawQuantityInUnits));
  if (fractionalPart > FRACTION_TOLERANCE) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Erro de Conversão: A quantidade solicitada resulta numa fração não suportada para este SKU. ` +
        `${requestedQuantity} ${unitCode} × ${factor} = ${rawQuantityInUnits} UN (fração: ${fractionalPart.toFixed(4)}). ` +
        `Ajuste a quantidade ou o fator de conversão para ${productSku}.`,
    });
  }

  const quantityInUnits = Math.round(rawQuantityInUnits);

  const auditLog =
    `[PICKING UOM] produto=${productSku} | unidade=${unitCode} | fator=${factor} | ` +
    `qtd_solicitada=${requestedQuantity} | qtd_base=${quantityInUnits} | fonte=${source} | ` +
    `tenant=${tenantId} | produto_id=${productId}`;

  console.info(auditLog);

  return { factor, quantityInUnits, source, unitCode, auditLog };
}

// ============================================================================
// PICKING ORDERS
// ============================================================================

export async function getPickingOrderById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(pickingOrders).where(eq(pickingOrders.id, id)).limit(1);
  return result[0] || null;
}

export async function getPickingOrdersByTenant(tenantId: number) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(pickingOrders)
    .where(eq(pickingOrders.tenantId, tenantId))
    .orderBy(desc(pickingOrders.createdAt));
}

export async function getAllPickingOrders() {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(pickingOrders)
    .orderBy(desc(pickingOrders.createdAt));
}

export async function createPickingOrder(data: typeof pickingOrders.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(pickingOrders).values(data);
  return result;
}

export async function updatePickingOrder(id: number, data: Partial<typeof pickingOrders.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(pickingOrders).set(data).where(eq(pickingOrders.id, id));
}

export async function deletePickingOrder(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // Soft delete: atualizar status ao invés de deletar fisicamente
  // Mantém rastreabilidade e conformidade com ANVISA (RDC 430/2020)
  await db.update(pickingOrders).set({ status: "cancelled" }).where(eq(pickingOrders.id, id));
}

// ============================================================================
// PICKING ORDER ITEMS
// ============================================================================

export async function getPickingOrderItems(pickingOrderId: number) {
  const db = await getDb();
  if (!db) return [];
  
  const items = await db
    .select({
      item: pickingOrderItems,
      product: products,
    })
    .from(pickingOrderItems)
    .leftJoin(products, eq(pickingOrderItems.productId, products.id))
    .where(eq(pickingOrderItems.pickingOrderId, pickingOrderId));
  
  return items;
}

export async function getPickingOrderItemById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(pickingOrderItems).where(eq(pickingOrderItems.id, id)).limit(1);
  return result[0] || null;
}

export async function createPickingOrderItem(data: typeof pickingOrderItems.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(pickingOrderItems).values(data);
  return result;
}

export async function updatePickingOrderItem(id: number, data: Partial<typeof pickingOrderItems.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(pickingOrderItems).set(data).where(eq(pickingOrderItems.id, id));
}

// ============================================================================
// ALOCAÇÃO DE ESTOQUE COM REGRAS FEFO/FIFO
// ============================================================================

/**
 * Aloca estoque para um item de picking seguindo regras parametrizáveis.
 * FEFO (First Expire First Out) - Prioriza lotes com validade mais próxima.
 * FIFO (First In First Out) - Prioriza lotes mais antigos.
 *
 * IMPORTANTE: requestedQuantity deve estar em UNIDADE BASE (UN) antes de chamar esta função.
 * Use resolvePickingFactor() para converter a quantidade solicitada para unidade base.
 */
export async function allocateInventory(
  tenantId: number,
  productId: number,
  requestedQuantity: number,
  allocationRule: "fefo" | "fifo" = "fefo",
  forcedAllocation?: {
    locationId: number;
    batch?: string;
    sku?: string; // para log de erro
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const allocations: Array<{
    inventoryId: number;
    locationId: number;
    batch: string;
    expiryDate: string | null;
    serialNumber: string | null;
    quantity: number;
  }> = [];

  // ── MODO MIGRAÇÃO: alocação forçada no endereço/lote do sistema legado ──
  if (forcedAllocation) {
    const conditions = [
      eq(inventory.tenantId, tenantId),
      eq(inventory.productId, productId),
      eq(inventory.locationId, forcedAllocation.locationId),
      eq(inventory.status, "available"),
      sql`${inventory.quantity} - ${inventory.reservedQuantity} > 0`,
    ];
    if (forcedAllocation.batch) {
      conditions.push(eq(inventory.batch, forcedAllocation.batch));
    }
    const [forcedInv] = await db
      .select()
      .from(inventory)
      .where(and(...conditions))
      .limit(1);

    if (!forcedInv) {
      const sku = forcedAllocation.sku ?? String(productId);
      throw new Error(
        `Divergência de Migração: Saldo insuficiente no endereço ${forcedAllocation.locationId} para o SKU ${sku}`
      );
    }
    const available = forcedInv.quantity - (forcedInv.reservedQuantity ?? 0);
    if (available < requestedQuantity) {
      const sku = forcedAllocation.sku ?? String(productId);
      throw new Error(
        `Divergência de Migração: Saldo insuficiente no endereço ${forcedAllocation.locationId} para o SKU ${sku}. Disponível: ${available}, Solicitado: ${requestedQuantity}`
      );
    }
    allocations.push({
      inventoryId: forcedInv.id,
      locationId: forcedInv.locationId,
      batch: forcedInv.batch || "",
      expiryDate: forcedInv.expiryDate,
      serialNumber: forcedInv.serialNumber,
      quantity: requestedQuantity,
    });
    return { allocations, fullyAllocated: true, shortQuantity: 0 };
  }

  // ── MODO NORMAL: FEFO / FIFO ──
  let availableInventory;
  if (allocationRule === "fefo") {
    availableInventory = await db
      .select()
      .from(inventory)
      .where(
        and(
          eq(inventory.tenantId, tenantId),
          eq(inventory.productId, productId),
          eq(inventory.status, "available"),
          sql`${inventory.quantity} > 0`
        )
      )
      .orderBy(inventory.expiryDate);
  } else {
    availableInventory = await db
      .select()
      .from(inventory)
      .where(
        and(
          eq(inventory.tenantId, tenantId),
          eq(inventory.productId, productId),
          eq(inventory.status, "available"),
          sql`${inventory.quantity} > 0`
        )
      )
      .orderBy(inventory.createdAt);
  }

  let remainingQuantity = requestedQuantity;
  for (const inv of availableInventory) {
    if (remainingQuantity <= 0) break;
    const quantityToAllocate = Math.min(remainingQuantity, inv.quantity);
    allocations.push({
      inventoryId: inv.id,
      locationId: inv.locationId,
      batch: inv.batch || "",
      expiryDate: inv.expiryDate,
      serialNumber: inv.serialNumber,
      quantity: quantityToAllocate,
    });
    remainingQuantity -= quantityToAllocate;
  }

  return {
    allocations,
    fullyAllocated: remainingQuantity === 0,
    shortQuantity: remainingQuantity > 0 ? remainingQuantity : 0,
  };
}

// ============================================================================
// PICKING GUIADO
// ============================================================================

/**
 * Inicia processo de picking para um pedido.
 * Retorna instruções de picking ordenadas por localização.
 */
export async function startPicking(pickingOrderId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const order = await getPickingOrderById(pickingOrderId);
  if (!order) throw new Error("Ordem de picking não encontrada");
  
  await db
    .select()
    .from(contracts)
    .where(eq(contracts.tenantId, order.tenantId))
    .limit(1);
  
  const allocationRule = "fefo";
  
  const items = await getPickingOrderItems(pickingOrderId);
  
  const pendingItems = items.filter(({ item }) => 
    item && item.status === 'pending'
  );
  
  const totalItems = items.length;
  const completedItems = items.filter(({ item }) => item && item.status === 'picked').length;
  
  const pickingInstructions = [];
  
  for (const { item, product } of pendingItems) {
    if (!item || !product) continue;
    
    const remainingQuantity = item.requestedQuantity - (item.pickedQuantity || 0);
    
    const allocation = await allocateInventory(
      order.tenantId,
      item.productId,
      remainingQuantity,
      allocationRule as "fefo" | "fifo"
    );
    
    const allocationsWithLocation = await Promise.all(
      allocation.allocations.map(async (alloc) => {
        const locationResult = await db
          .select()
          .from(warehouseLocations)
          .where(eq(warehouseLocations.id, alloc.locationId))
          .limit(1);
        
        return {
          ...alloc,
          locationCode: locationResult[0]?.code || "UNKNOWN",
        };
      })
    );
    
    pickingInstructions.push({
      itemId: item.id,
      productId: item.productId,
      productName: product.description,
      productSku: product.sku,
      productGtin: product.gtin,
      requestedQuantity: item.requestedQuantity,
      allocations: allocationsWithLocation,
      fullyAllocated: allocation.fullyAllocated,
      shortQuantity: allocation.shortQuantity,
    });
    
    if (allocationsWithLocation.length > 0) {
      await db
        .update(pickingOrderItems)
        .set({ 
          fromLocationId: allocationsWithLocation[0].locationId,
          batch: allocationsWithLocation[0].batch,
          expiryDate: allocationsWithLocation[0].expiryDate,
        })
        .where(eq(pickingOrderItems.id, item.id));
    }
  }
  
  if (order.status === 'pending') {
    await updatePickingOrder(pickingOrderId, {
      status: "picking",
      assignedTo: userId,
    });
  }
  
  return {
    instructions: pickingInstructions,
    progress: {
      total: totalItems,
      completed: completedItems,
      remaining: pendingItems.length,
    },
  };
}

/**
 * Confirma picking de um item.
 * Aplica rounding_strategy do produto e registra log de auditoria ANVISA.
 */
export async function confirmPicking(
  itemId: number,
  pickedQuantity: number,
  batch: string,
  expiryDate: string | null,
  serialNumber: string | undefined,
  fromLocationId: number,
  userId: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const item = await getPickingOrderItemById(itemId);
  if (!item) throw new Error("Item não encontrado");
  
  const order = await getPickingOrderById(item.pickingOrderId);
  if (!order) throw new Error("Ordem não encontrada");

  // ✅ CORREÇÃO DE FRAÇÕES ÓRFÃS: Aplicar rounding_strategy do produto antes de debitar estoque.
  let safePicked = pickedQuantity;
  try {
    const conversionRow = await db.select({
      roundingStrategy: productConversions.roundingStrategy,
    })
      .from(productConversions)
      .where(and(
        eq(productConversions.productId, item.productId),
        eq(productConversions.tenantId, order.tenantId)
      ))
      .limit(1);

    const strategy = conversionRow[0]?.roundingStrategy || "round";
    switch (strategy) {
      case "floor":  safePicked = Math.floor(pickedQuantity); break;
      case "ceil":   safePicked = Math.ceil(pickedQuantity);  break;
      case "round":
      default:       safePicked = Math.round(pickedQuantity); break;
    }

    if (safePicked !== pickedQuantity) {
      const fractionLost = Math.abs(pickedQuantity - safePicked);
      console.warn(
        `[PICKING UOM] Fração órfã corrigida: ${pickedQuantity} → ${safePicked} (strategy: ${strategy}, fração perdida: ${fractionLost.toFixed(4)})`,
        { itemId, productId: item.productId, fractionLost }
      );
    }
  } catch (err) {
    safePicked = Math.round(pickedQuantity);
    console.error("[PICKING UOM] Erro ao buscar rounding_strategy, usando round:", err);
  }

  const status = safePicked < item.requestedQuantity ? "short_picked" : "picked";
  
  await updatePickingOrderItem(itemId, {
    pickedQuantity: safePicked,
    batch,
    expiryDate,
    serialNumber,
    fromLocationId,
    status,
  });
  
  // Registrar movimentação com log de auditoria ANVISA
  await db.insert(inventoryMovements).values({
    tenantId: order.tenantId,
    productId: item.productId,
    batch,
    serialNumber,
    fromLocationId,
    quantity: safePicked,
    movementType: "picking",
    referenceType: "picking_order",
    referenceId: item.pickingOrderId,
    performedBy: userId,
    notes: `Picking do pedido ${order.orderNumber}`,
    conversionSource: "manual", // ANVISA: operação interna de separação
  });

  // Atualizar saldo de inventário em tempo real (deduzir)
  const inventorySync = await import("./inventory-sync");
  await inventorySync.updateInventoryBalance(
    item.productId,
    fromLocationId,
    batch,
    -safePicked,
    order.tenantId,
    expiryDate || null,
    serialNumber || null
  );
  
  const locationsModule = await import("./locations");
  await locationsModule.updateLocationStatus(fromLocationId);
  
  return { success: true, status };
}

/**
 * Finaliza ordem de picking.
 */
export async function finishPicking(pickingOrderId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const items = await getPickingOrderItems(pickingOrderId);
  const allPicked = items.every(({ item }) => 
    item && (item.status === "picked" || item.status === "short_picked")
  );
  
  if (!allPicked) {
    throw new Error("Nem todos os itens foram separados");
  }
  
  await updatePickingOrder(pickingOrderId, {
    status: "picked",
    pickedBy: userId,
    pickedAt: new Date(),
  });
  
  return { success: true };
}
