import { getDb } from "./db";
import { pickingOrders, pickingOrderItems, pickingWaves, pickingWaveItems, products, inventory, warehouseLocations, warehouseZones, tenants, pickingAllocations, labelAssociations } from "../drizzle/schema";
import { eq, and, inArray, sql, desc, asc } from "drizzle-orm";
import { getUniqueCode } from "./utils/uniqueCode";

/**
 * Lógica de geração e gerenciamento de ondas de separação (Wave Picking)
 */

interface CreateWaveParams {
  orderIds: number[]; // IDs dos pedidos a agrupar
  userId: number; // Usuário que está criando a onda
}

interface ConsolidatedItem {
  productId: number;
  productSku: string;
  productName: string;
  batch: string | null; // ✅ Lote específico (null quando produto não tem lote)
  expiryDate: string | null; // ✅ Validade do lote (null quando não tem validade)
  totalQuantity: number;
  orders: Array<{ orderId: number; quantity: number }>; // Rastreabilidade
}

/**
 * Gera número único de onda (OS)
 * Formato: OS-YYYYMMDD-XXXX
 */
async function generateWaveNumber(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

  // Buscar último número do dia
  const lastWave = await db
    .select({ waveNumber: pickingWaves.waveNumber })
    .from(pickingWaves)
    .where(sql`${pickingWaves.waveNumber} LIKE ${"OS-" + dateStr + "-%"}`)
    .orderBy(desc(pickingWaves.waveNumber))
    .limit(1);

  let sequence = 1;
  if (lastWave.length > 0) {
    const lastNumber = lastWave[0].waveNumber;
    const lastSeq = parseInt(lastNumber.split("-")[2]);
    sequence = lastSeq + 1;
  }

  return `OS-${dateStr}-${sequence.toString().padStart(4, "0")}`;
}

/**
 * Consolida itens de múltiplos pedidos
 * Soma quantidades de produtos iguais
 */
async function consolidateItems(orderIds: number[]): Promise<ConsolidatedItem[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Buscar todos os itens dos pedidos
  const items = await db
    .select({
      orderId: pickingOrderItems.pickingOrderId,
      productId: pickingOrderItems.productId,
      productSku: products.sku,
      productName: products.description,
      quantity: pickingOrderItems.requestedQuantity,
      batch: pickingOrderItems.batch, // ✅ Incluir lote
      expiryDate: pickingOrderItems.expiryDate, // ✅ Incluir validade
      uniqueCode: (pickingOrderItems as any).uniqueCode, // ✅ Incluir uniqueCode
    })
    .from(pickingOrderItems)
    .leftJoin(products, eq(pickingOrderItems.productId, products.id))
    .where(inArray(pickingOrderItems.pickingOrderId, orderIds));

  // ✅ CORREÇÃO: Consolidar por uniqueCode (SKU+Lote)
  const consolidated = new Map<string, ConsolidatedItem>();

  for (const item of items) {
    // Usar uniqueCode do banco (já calculado: SKU-LOTE)
    const key = (item as any).uniqueCode || `${item.productSku}-${item.batch || 'null'}`;
    const existing = consolidated.get(key);
    if (existing) {
      existing.totalQuantity += item.quantity;
      existing.orders.push({ orderId: item.orderId, quantity: item.quantity });
    } else {
      consolidated.set(key, {
        productId: item.productId,
        productSku: item.productSku!,
        productName: item.productName!,
        batch: item.batch, // ✅ Preservar lote
        expiryDate: item.expiryDate, // ✅ Preservar validade
        totalQuantity: item.quantity,
        orders: [{ orderId: item.orderId, quantity: item.quantity }],
      });
    }
  }

  return Array.from(consolidated.values());
}

/**
 * Aloca endereços para produtos consolidados baseado na regra FIFO/FEFO
 * Suporta múltiplos lotes: se um lote não tem saldo suficiente, busca próximo lote automaticamente
 */
async function allocateLocations(
  tenantId: number,
  consolidatedItems: ConsolidatedItem[],
  pickingRule: "FIFO" | "FEFO" | "Direcionado"
): Promise<Array<ConsolidatedItem & { inventoryId: number; locationId: number; locationCode: string; allocatedQuantity: number }>> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const allocated: Array<ConsolidatedItem & { inventoryId: number; locationId: number; locationCode: string; allocatedQuantity: number }> = [];

  for (const item of consolidatedItems) {
    // Buscar TODOS os lotes disponíveis do produto ordenado por FIFO ou FEFO
    const orderBy = pickingRule === "FEFO" ? asc(inventory.expiryDate) : asc(inventory.createdAt);

    // ✅ CORREÇÃO: Filtrar também por lote específico do item
    const whereConditions = [
      eq(inventory.tenantId, tenantId),
      eq(inventory.productId, item.productId),
      eq(inventory.status, "available"),
      sql`${inventory.quantity} - ${inventory.reservedQuantity} > 0`,
    ];

    // Se o item tem lote definido, filtrar apenas por esse lote
    if (item.batch) {
      whereConditions.push(eq(inventory.batch, item.batch));
    }

    const availableStock = await db
      .select({
        inventoryId: inventory.id,
        locationId: inventory.locationId,
        code: warehouseLocations.code,
        batch: inventory.batch,
        expiryDate: inventory.expiryDate,
        quantity: inventory.quantity,
        reservedQuantity: inventory.reservedQuantity,
        availableQuantity: sql<number>`${inventory.quantity} - ${inventory.reservedQuantity}`.as('availableQuantity'),
      })
      .from(inventory)
      .leftJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
      .where(and(...whereConditions))
      .orderBy(orderBy);

    if (availableStock.length === 0) {
      throw new Error(`Estoque insuficiente para produto ${item.productSku} (${item.productName})`);
    }

    // Calcular total disponível em todos os lotes (quantidade - reservado)
    const totalAvailable = availableStock.reduce((sum, loc) => sum + loc.availableQuantity, 0);

    if (totalAvailable < item.totalQuantity) {
      throw new Error(
        `Estoque insuficiente para produto ${item.productSku} (${item.productName}). ` +
        `Disponível: ${totalAvailable}, Necessário: ${item.totalQuantity}`
      );
    }

    // Alocar lotes em ordem FIFO/FEFO até completar a quantidade necessária
    let remainingQuantity = item.totalQuantity;

    for (const location of availableStock) {
      if (remainingQuantity <= 0) break;

      const quantityToAllocate = Math.min(location.availableQuantity, remainingQuantity);

      // Garantir tipos corretos para batch e expiryDate (leftJoin retorna undefined, converter para null)
      const batchValue: string | null = location.batch !== undefined ? location.batch : (item.batch !== undefined ? item.batch : null);
      const expiryValue: string | null = location.expiryDate !== undefined ? location.expiryDate : (item.expiryDate !== undefined ? item.expiryDate : null);

      allocated.push({
        productId: item.productId,
        productSku: item.productSku,
        productName: item.productName,
        batch: batchValue,
        expiryDate: expiryValue,
        totalQuantity: item.totalQuantity,
        orders: item.orders,
        inventoryId: location.inventoryId,
        locationId: location.locationId,
        locationCode: location.code!,
        allocatedQuantity: quantityToAllocate,
      });

      remainingQuantity -= quantityToAllocate;
    }
  }

  return allocated;
}

/**
 * Cria onda de separação consolidando múltiplos pedidos
 */
export async function createWave(params: CreateWaveParams) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Validar que todos os pedidos existem e são do mesmo cliente
  const orders = await db
    .select({
      id: pickingOrders.id,
      tenantId: pickingOrders.tenantId,
      status: pickingOrders.status,
    })
    .from(pickingOrders)
    .where(inArray(pickingOrders.id, params.orderIds));

  if (orders.length !== params.orderIds.length) {
    throw new Error("Um ou mais pedidos não foram encontrados");
  }

  const tenantIds = new Set(orders.map((o) => o.tenantId));
  if (tenantIds.size > 1) {
    throw new Error("Todos os pedidos devem ser do mesmo cliente");
  }

  const tenantId = orders[0].tenantId;

  // Verificar se algum pedido já está em onda
  const inWave = orders.filter((o) => o.status === "in_wave");
  if (inWave.length > 0) {
    throw new Error("Um ou mais pedidos já estão em uma onda");
  }

  // 2. Buscar regra de picking do cliente
  const [tenant] = await db
    .select({ pickingRule: tenants.pickingRule })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    throw new Error("Cliente não encontrado");
  }

  const pickingRule = tenant.pickingRule as "FIFO" | "FEFO" | "Direcionado";

  // 2.5. Validar que todos os produtos dos pedidos têm unitsPerBox cadastrado
  // Prioridade: products.unitsPerBox > labelAssociations.unitsPerBox (mais recente)
  const orderItemsForValidation = await db
    .select({
      productId: pickingOrderItems.productId,
      productSku: products.sku,
      productDescription: products.description,
      unitsPerBox: products.unitsPerBox,
    })
    .from(pickingOrderItems)
    .leftJoin(products, eq(pickingOrderItems.productId, products.id))
    .where(inArray(pickingOrderItems.pickingOrderId, params.orderIds));

  const productsWithoutUPB = orderItemsForValidation.filter(
    (item) => !item.unitsPerBox || item.unitsPerBox <= 0
  );

  if (productsWithoutUPB.length > 0) {
    // Tentar resolver unitsPerBox via labelAssociations para produtos sem cadastro
    const missingIds = [...new Set(productsWithoutUPB.map((p) => p.productId).filter(Boolean) as number[])];
    const labelUPBRows = await db
      .select({ productId: labelAssociations.productId, unitsPerBox: labelAssociations.unitsPerBox })
      .from(labelAssociations)
      .where(and(
        inArray(labelAssociations.productId, missingIds),
        sql`${labelAssociations.unitsPerBox} > 0`,
      ))
      .orderBy(desc(labelAssociations.associatedAt));
    // Mapear productId -> primeiro unitsPerBox encontrado
    const labelUPBMap = new Map<number, number>();
    for (const row of labelUPBRows) {
      if (row.productId && row.unitsPerBox && !labelUPBMap.has(row.productId)) {
        labelUPBMap.set(row.productId, row.unitsPerBox);
      }
    }
    // Atualizar products.unitsPerBox para os que foram encontrados na labelAssociation
    for (const [productId, upb] of labelUPBMap.entries()) {
      await db.update(products).set({ unitsPerBox: upb }).where(eq(products.id, productId));
    }
    // Verificar se ainda há produtos sem UPB após o fallback
    const stillMissing = productsWithoutUPB.filter(
      (item) => !item.productId || !labelUPBMap.has(item.productId)
    );
    if (stillMissing.length > 0) {
      const uniqueProducts = Array.from(
        new Map(stillMissing.map((p) => [p.productId, p])).values()
      );
      const productList = uniqueProducts
        .map((p) => `${p.productSku ?? `ID:${p.productId}`} — ${p.productDescription ?? "Produto sem descrição"}`)
        .join("; ");
      throw new Error(
        `Não é possível iniciar o picking: os seguintes produtos não possuem "Unidades por Caixa" cadastrado: ${productList}. Acesse o cadastro de produtos e preencha este campo antes de continuar.`
      );
    }
  }

  // 3. Buscar alocações dos pedidos (já criadas durante criação do pedido)
  console.log("[createWave] Buscando alocações para pedidos:", params.orderIds);
  
  const reservations = await db
    .select({
      pickingOrderId: pickingAllocations.pickingOrderId, // ID do pedido de origem
      productId: pickingAllocations.productId,
      inventoryId: sql<number>`NULL`.as('inventoryId'), // Não mais usado
      quantity: pickingAllocations.quantity,
      productSku: pickingAllocations.productSku,
      productName: products.description,
      locationId: pickingAllocations.locationId,
      locationCode: pickingAllocations.locationCode,
      batch: pickingAllocations.batch,
      expiryDate: pickingAllocations.expiryDate,
      // unit e unitsPerBox preenchidos durante leitura da etiqueta pelo operador
      unit: sql<string>`'unit'`.as('unit'),
      unitsPerBox: sql<number | null>`NULL`.as('unitsPerBox'),
      // labelCode vem diretamente de pickingAllocations (preenchido durante execução do picking)
      labelCode: pickingAllocations.labelCode,
    })
    .from(pickingAllocations)
    .leftJoin(products, eq(pickingAllocations.productId, products.id))
    .leftJoin(warehouseLocations, eq(pickingAllocations.locationId, warehouseLocations.id))
    .leftJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .where(
      and(
        inArray(pickingAllocations.pickingOrderId, params.orderIds),
        // Excluir zonas especiais (Expedição, Recebimento, Não Conformidades, Devoluções)
        // ✅ CORREÇÃO: usar IS NULL OR NOT IN para não excluir localizações sem zona cadastrada
        sql`(${warehouseZones.code} IS NULL OR ${warehouseZones.code} NOT IN ('EXP', 'REC', 'NCG', 'DEV'))`
      )
    );

  if (reservations.length === 0) {
    throw new Error("Nenhuma reserva encontrada para os pedidos selecionados");
  }

  // 4. Transformar reservas em formato de allocatedItems SEM CONSOLIDAR
  // ✅ CRIAR UMA LINHA POR ETIQUETA (labelCode) para rastreabilidade completa
  // 🛡️ VALIDAÇÃO DEFENSIVA: Filtrar registros com campos obrigatórios nulos
  const allocatedItems = reservations
    .filter(r => {
      // Validar campos obrigatórios
      if (!r.productSku || !r.productName || !r.locationId || !r.locationCode) {
        console.warn("[createWave] Registro ignorado por campos nulos:", {
          pickingOrderId: r.pickingOrderId,
          productId: r.productId,
          productSku: r.productSku,
          productName: r.productName,
          locationId: r.locationId,
          locationCode: r.locationCode,
        });
        return false;
      }
      return true;
    })
    .map(r => ({
      pickingOrderId: r.pickingOrderId,
      productId: r.productId,
      productSku: r.productSku!,
      productName: r.productName!,
      allocatedQuantity: r.quantity,
      locationId: r.locationId!,
      locationCode: r.locationCode!,
      batch: r.batch || undefined,
      expiryDate: r.expiryDate || undefined,
      unit: r.unit || "unit",
      unitsPerBox: r.unitsPerBox || undefined,
      labelCode: r.labelCode || undefined, // ✅ Código da etiqueta
    }));

  // ✅ VALIDAÇÃO: Garantir que há itens válidos após filtro
  if (allocatedItems.length === 0) {
    throw new Error("Nenhum item válido encontrado para criar onda. Verifique se os produtos e endereços estão cadastrados corretamente.");
  }

  // 5. Gerar número da onda
  const waveNumber = await generateWaveNumber();

  // 6. Criar registro da onda
  const [wave] = await db.insert(pickingWaves).values({
    tenantId,
    waveNumber,
    status: "pending",
    totalOrders: orders.length,
    totalItems: allocatedItems.length,
    totalQuantity: allocatedItems.reduce((sum, item) => sum + item.allocatedQuantity, 0),
    pickingRule,
    createdBy: params.userId,
  });

  const waveId = wave.insertId;

  // 7. Criar itens da onda (um registro por etiqueta/labelCode)
  const waveItemsData = allocatedItems.map((item) => ({
    waveId,
    pickingOrderId: item.pickingOrderId, // Pedido de origem do item
    productId: item.productId,
    productSku: item.productSku,
    productName: item.productName,
    totalQuantity: item.allocatedQuantity, // Sempre em UNIDADES (vem das reservas)
    pickedQuantity: 0,
    unit: "unit" as const, // SEMPRE "unit" porque totalQuantity está em unidades
    unitsPerBox: item.unitsPerBox, // Mantido apenas para referência
    locationId: item.locationId,
    locationCode: item.locationCode,
    batch: item.batch,
    expiryDate: item.expiryDate ?? null,
    uniqueCode: getUniqueCode(item.productSku, item.batch), // ✅ Adicionar uniqueCode
    // ✅ CORREÇÃO: Garantir que labelCode nunca seja undefined (causa desalinhamento de parâmetros)
    labelCode: item.labelCode || null, // Se undefined, usar null explícito
    status: "pending" as const, // ✅ Definir status DEPOIS de labelCode para evitar desalinhamento
  }));

  await db.insert(pickingWaveItems).values(waveItemsData);

  // Nota: A reserva de estoque já foi feita na criação dos pedidos,
  // então não precisamos incrementar reservedQuantity aqui novamente.

  // 8. Atualizar waveId em pickingAllocations para rastreabilidade
  await db
    .update(pickingAllocations)
    .set({ waveId })
    .where(inArray(pickingAllocations.pickingOrderId, params.orderIds));

  // 9. Atualizar status dos pedidos para "in_wave" e associar à onda
  await db
    .update(pickingOrders)
    .set({
      status: "in_wave",
      waveId,
    })
    .where(inArray(pickingOrders.id, params.orderIds));

  return {
    waveId,
    waveNumber,
    totalOrders: orders.length,
    totalItems: allocatedItems.length,
    totalQuantity: allocatedItems.reduce((sum, item) => sum + item.allocatedQuantity, 0),
    items: allocatedItems,
  };
}

/**
 * Busca detalhes de uma onda
 */
export async function getWaveById(waveId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [wave] = await db
    .select()
    .from(pickingWaves)
    .where(eq(pickingWaves.id, waveId))
    .limit(1);

  if (!wave) {
    throw new Error("Onda não encontrada");
  }

  const items = await db
    .select()
    .from(pickingWaveItems)
    .where(eq(pickingWaveItems.waveId, waveId));

  const orders = await db
    .select()
    .from(pickingOrders)
    .where(eq(pickingOrders.waveId, waveId));

  return {
    ...wave,
    items,
    orders,
  };
}
