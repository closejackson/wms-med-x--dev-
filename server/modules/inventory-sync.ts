/**
 * Módulo para sincronização e recálculo de saldos de inventário
 * 
 * Este módulo é responsável por recalcular os saldos da tabela `inventory`
 * a partir do histórico de movimentações na tabela `inventoryMovements`.
 */

import { getDb } from "../db";
import { inventory, inventoryMovements, products, warehouseLocations, warehouseZones } from "../../drizzle/schema";
import { eq, and, sql } from "drizzle-orm";
import { updateLocationStatus } from "./locations";

interface MovementSummary {
  productId: number;
  locationId: number;
  batch: string | null;
  tenantId: number | null;
  totalQuantity: number;
  expiryDate: string | null;
  serialNumber: string | null;
}

/**
 * Recalcula os saldos de inventário a partir das movimentações
 * 
 * Lógica:
 * - Movimentos de entrada (receiving, put_away, return, adjustment positivo): somam no destino
 * - Movimentos de saída (picking, transfer, disposal, adjustment negativo): subtraem da origem
 * - Transfer: subtrai da origem e soma no destino
 */
export async function recalculateInventoryBalances(): Promise<{
  created: number;
  updated: number;
  deleted: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  console.log("[Inventory Sync] Iniciando recálculo de saldos...");

  // 1. Limpar tabela inventory atual
  await db.delete(inventory);
  console.log("[Inventory Sync] Tabela inventory limpa");

  // 2. Buscar todas as movimentações agrupadas por produto, lote e localização
  const movements = await db
    .select({
      productId: inventoryMovements.productId,
      batch: inventoryMovements.batch,
      serialNumber: inventoryMovements.serialNumber,
      fromLocationId: inventoryMovements.fromLocationId,
      toLocationId: inventoryMovements.toLocationId,
      quantity: inventoryMovements.quantity,
      movementType: inventoryMovements.movementType,
      tenantId: inventoryMovements.tenantId,
      createdAt: inventoryMovements.createdAt,
    })
    .from(inventoryMovements)
    .orderBy(inventoryMovements.createdAt);

  console.log(`[Inventory Sync] Processando ${movements.length} movimentações...`);

  // 3. Calcular saldos por posição (produto + lote + localização)
  const balances = new Map<string, MovementSummary>();

  for (const mov of movements) {
    // Processar saída (origem)
    if (mov.fromLocationId) {
      const fromKey = `${mov.productId}-${mov.fromLocationId}-${mov.batch || "null"}`;
      const fromBalance = balances.get(fromKey) || {
        productId: mov.productId,
        locationId: mov.fromLocationId,
        batch: mov.batch,
        tenantId: mov.tenantId,
        totalQuantity: 0,
        expiryDate: null,
        serialNumber: mov.serialNumber,
      };
      fromBalance.totalQuantity -= mov.quantity;
      balances.set(fromKey, fromBalance);
    }

    // Processar entrada (destino)
    if (mov.toLocationId) {
      const toKey = `${mov.productId}-${mov.toLocationId}-${mov.batch || "null"}`;
      const toBalance = balances.get(toKey) || {
        productId: mov.productId,
        locationId: mov.toLocationId,
        batch: mov.batch,
        tenantId: mov.tenantId,
        totalQuantity: 0,
        expiryDate: null,
        serialNumber: mov.serialNumber,
      };
      toBalance.totalQuantity += mov.quantity;
      balances.set(toKey, toBalance);
    }
  }

  console.log(`[Inventory Sync] Calculados ${balances.size} saldos únicos`);

  // 4. Inserir saldos na tabela inventory (apenas saldos > 0)
  let created = 0;
  const recordsToInsert = [];

  // Buscar SKUs de todos os produtos de uma vez
  const productIds = Array.from(new Set(Array.from(balances.values()).map(b => b.productId)));
  const productSkus = await db.select({ id: products.id, sku: products.sku })
    .from(products)
    .where(sql`${products.id} IN (${sql.join(productIds.map(id => sql`${id}`), sql`, `)})`);

  // Buscar zonas de todos os endereços de uma vez
  const locationIds = Array.from(new Set(Array.from(balances.values()).map(b => b.locationId)));
  const locationZones = await db.select({ 
    locationId: warehouseLocations.id, 
    zoneCode: warehouseZones.code 
  })
    .from(warehouseLocations)
    .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .where(sql`${warehouseLocations.id} IN (${sql.join(locationIds.map(id => sql`${id}`), sql`, `)})`);

  const skuMap = new Map(productSkus.map(p => [p.id, p.sku]));
  const zoneMap = new Map(locationZones.map(l => [l.locationId, l.zoneCode]));
  const { getUniqueCode } = await import("../utils/uniqueCode");

  for (const [key, balance] of Array.from(balances.entries())) {
    if (balance.totalQuantity > 0) {
      const sku = skuMap.get(balance.productId) || "";
      const zoneCode = zoneMap.get(balance.locationId) || null;
      recordsToInsert.push({
        productId: balance.productId,
        locationId: balance.locationId,
        batch: balance.batch,
        expiryDate: balance.expiryDate,
        serialNumber: balance.serialNumber,
        quantity: balance.totalQuantity,
        tenantId: balance.tenantId,
        status: "available" as const,
        uniqueCode: getUniqueCode(sku, balance.batch), // ✅ Adicionar uniqueCode
        locationZone: zoneCode, // ✅ Adicionar locationZone
      });
    }
  }

  // Inserir em lotes de 100
  const batchSize = 100;
  for (let i = 0; i < recordsToInsert.length; i += batchSize) {
    const batch = recordsToInsert.slice(i, i + batchSize);
    await db.insert(inventory).values(batch);
    created += batch.length;
  }

  console.log(`[Inventory Sync] Criados ${created} registros de saldo`);

  return {
    created,
    updated: 0,
    deleted: 0,
  };
}

/**
 * Parâmetros opcionais de rastreabilidade UOM para updateInventoryBalance.
 * Quando fornecidos, garantem que a quantidade já foi processada pelo Motor de Conversão.
 */
export interface UOMTraceParams {
  originalUnit?: string | null;
  originalQty?: number | null;
  conversionFactor?: number | null;
  conversionSource?: "uTrib" | "uCom" | "manual" | "none";
}

/**
 * Atualiza o saldo de uma posição específica após uma movimentação
 * (Uso incremental para manter sincronizado em tempo real)
 *
 * @param uomTrace - Rastreabilidade de conversão de unidade (opcional).
 *   Se não fornecido, assume que a quantidade já está na unidade base.
 */
export async function updateInventoryBalance(
  productId: number,
  locationId: number,
  batch: string | null,
  quantityChange: number,
  tenantId: number | null,
  expiryDate: string | null = null,
  serialNumber: string | null = null,
  uomTrace?: UOMTraceParams
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // ✅ GUARD DE FRAÇÃO ÓRFÃ: Arredondar quantidades infinitesimais para evitar
  // saldos negativos por erros de ponto flutuante (ex: 3.3333 - 3 = 0.3333 em vez de 0).
  // Quantidades menores que 0.001 são consideradas zero operacional.
  const safeQuantityChange = Math.abs(quantityChange) < 0.001
    ? 0
    : Math.round(quantityChange);

  // Se a quantidade segura for zero, não há nada a fazer.
  if (safeQuantityChange === 0) {
    console.warn(
      `[UOM INTEGRIDADE] Fração órfã descartada (quantidade original: ${quantityChange})`,
      { productId, locationId, batch }
    );
    return;
  }

  // ✅ AVISO DE RASTREABILIDADE ANVISA: Logar quando quantidade decimal sem
  // rastreabilidade de conversão é detectada (não bloqueia, apenas registra).
  if (!Number.isInteger(quantityChange) && (!uomTrace || uomTrace.conversionSource === 'none' || !uomTrace.conversionSource)) {
    console.warn(
      `[UOM INTEGRIDADE] Quantidade decimal sem rastreabilidade de conversão!`,
      { productId, locationId, batch, quantityChange, safeQuantityChange, uomTrace }
    );
  }

  // Buscar registro existente
  const conditions = [
    eq(inventory.productId, productId),
    eq(inventory.locationId, locationId),
  ];

  if (batch) {
    conditions.push(eq(inventory.batch, batch));
  } else {
    conditions.push(sql`${inventory.batch} IS NULL`);
  }

  const existing = await db
    .select()
    .from(inventory)
    .where(and(...conditions))
    .limit(1);

  if (existing.length > 0) {
    // Atualizar quantidade existente
    const newQuantity = existing[0].quantity + safeQuantityChange;

    if (newQuantity <= 0) {
      // Remover registro se quantidade zerou
      await db
        .delete(inventory)
        .where(eq(inventory.id, existing[0].id));
      // ✅ Sincronizar status do endereço: pode ter ficado vazio
      await updateLocationStatus(locationId);
    } else {
      // Atualizar quantidade e validade (se fornecida)
      const updateData: any = { 
        quantity: newQuantity, 
        updatedAt: new Date() 
      };
      
      // Atualizar expiryDate se fornecido (sobrescrever com valor mais recente)
      if (expiryDate) {
        updateData.expiryDate = expiryDate;
      }
      
      await db
        .update(inventory)
        .set(updateData)
        .where(eq(inventory.id, existing[0].id));
    }
  } else if (quantityChange > 0) {
    // CORREÇÃO CRÍTICA: Validar tenantId antes de criar inventory
    // Bug recorrente: inventory com tenantId NULL causa falha em pedidos
    // Data: 11/01/2026 - Terceira ocorrência
    if (tenantId === null || tenantId === undefined) {
      console.error('[INVENTORY SYNC CRÍTICO] Tentativa de criar inventory sem tenantId!', {
        productId,
        locationId,
        batch,
        quantityChange
      });
      throw new Error('tenantId é obrigatório para criar inventory. Verifique o fluxo de chamada.');
    }
    
    // Buscar SKU do produto para gerar uniqueCode
    const product = await db.select({ sku: products.sku })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    // Buscar zona do endereço
    const location = await db.select({ zoneCode: warehouseZones.code })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .where(eq(warehouseLocations.id, locationId))
      .limit(1);

    const { getUniqueCode } = await import("../utils/uniqueCode");

    // Criar novo registro
    await db.insert(inventory).values({
      productId,
      locationId,
      batch,
      expiryDate,
      serialNumber,
      quantity: safeQuantityChange,
      tenantId,
      uniqueCode: getUniqueCode(product[0]?.sku || "", batch), // ✅ Adicionar uniqueCode
      locationZone: location[0]?.zoneCode || null, // ✅ Adicionar locationZone
      status: "available",
    });
  }
}
