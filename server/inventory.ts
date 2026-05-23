import { eq, and, or, gte, lte, gt, inArray, isNull, isNotNull, sql, like } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { getDb } from "./db";
import {
  inventory,
  products,
  warehouseLocations,
  warehouseZones,
  tenants,
  receivingPreallocations,
  
  pickingAllocations,
} from "../drizzle/schema";

export interface InventoryFilters {
  tenantId?: number | null;
  productId?: number;
  locationId?: number;
  zoneId?: number;
  batch?: string;
  // 'vacant' = endereços sem nenhum saldo (LEFT JOIN retorna inventory.id IS NULL)
  // 'available' = endereços com saldo que ainda aceitam mais produtos (multi-item)
  // 'occupied' = endereços com saldo que não aceitam mais produtos (single-item)
  status?: "vacant" | "available" | "occupied" | "blocked" | "counting" | "quarantine" | ("vacant" | "available" | "occupied" | "blocked" | "counting" | "quarantine")[];
  minQuantity?: number;
  search?: string;
  locationCode?: string;
}

export interface InventoryPosition {
  id: number;
  productId: number;
  productSku: string;
  productDescription: string;
  locationId: number;
  locationCode: string;
  locationStatus: string;
  locationTenantId: number | null;
  zoneName: string;
  batch: string | null;
  expiryDate: string | null;
  quantity: number;
  reservedQuantity: number;
  status: string;
  tenantId: number | null;
  tenantName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Consulta posições de estoque com filtros avançados
 */
export async function getInventoryPositions(
  filters: InventoryFilters
): Promise<InventoryPosition[]> {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  const locationConditions = [];
  const inventoryConditions = [];

  // Normalizar status para array
  const statusArray = filters.status 
    ? (Array.isArray(filters.status) ? filters.status : [filters.status])
    : [];

  // Filtro por tenant do endereço
  if (filters.tenantId !== undefined) {
    if (filters.tenantId === null) {
      locationConditions.push(isNull(warehouseLocations.tenantId));
    } else {
      locationConditions.push(eq(warehouseLocations.tenantId, filters.tenantId));
    }
  }

  // Filtro por zona
  if (filters.zoneId) {
    locationConditions.push(eq(warehouseLocations.zoneId, filters.zoneId));
  }

  // Filtro por código de endereço
  if (filters.locationCode) {
    locationConditions.push(like(warehouseLocations.code, `%${filters.locationCode}%`));
  }

  // Separar 'vacant' dos status de warehouseLocations
  // 'vacant' = endereços sem nenhum saldo (não é um status da tabela, é uma condição de inventory)
  const hasVacantFilter = statusArray.includes("vacant");
  const locationStatusArray = statusArray.filter(s => s !== "vacant");

  // Filtro por status de endereço (apenas status reais da tabela warehouseLocations)
  if (locationStatusArray.length > 0) {
    locationConditions.push(inArray(warehouseLocations.status, locationStatusArray as any));
  }

  // Filtros de inventory (apenas quando há produtos)
  if (filters.productId) {
    inventoryConditions.push(eq(inventory.productId, filters.productId));
  }
  if (filters.locationId) {
    inventoryConditions.push(eq(inventory.locationId, filters.locationId));
  }
  if (filters.minQuantity !== undefined) {
    inventoryConditions.push(gte(inventory.quantity, filters.minQuantity));
  }

  // Filtrar apenas posições com quantidade > 0
  inventoryConditions.push(gt(inventory.quantity, 0));

  // Filtros que devem ser aplicados no WHERE (não no JOIN)
  const whereConditions = [];
  if (filters.batch) {
    whereConditions.push(like(inventory.batch, `%${filters.batch}%`));
    // Quando filtra por lote, exigir que haja produto (não retornar endereços vazios)
    whereConditions.push(isNotNull(inventory.productId));
  }
  if (filters.search) {
    whereConditions.push(
      sql`(${products.sku} LIKE ${`%${filters.search}%`} OR ${products.description} LIKE ${`%${filters.search}%`})`
    );
    // Quando filtra por produto, exigir que haja produto (não retornar endereços vazios)
    whereConditions.push(isNotNull(inventory.productId));
  }

  const locationTenant = alias(tenants, "locationTenant");

  // Determinar se deve usar LEFT JOIN (inclui endereços vazios):
  // - Sem filtro de status (mostrar tudo)
  // - Filtro inclui 'vacant' (mostrar endereços sem saldo)
  // - Filtro inclui 'available' sem outros status (mostrar endereços com saldo multi-item)
  const includeEmpty = statusArray.length === 0 || hasVacantFilter;
  // Se APENAS 'vacant' foi selecionado, mostrar somente endereços sem inventory
  const onlyVacantFilter = hasVacantFilter && locationStatusArray.length === 0;

  if (includeEmpty) {
    // LEFT JOIN: inclui endereços sem inventory
    const inventoryJoinConditions = [
      eq(inventory.locationId, warehouseLocations.id),
      gt(inventory.quantity, 0),
    ];
    
    // Quando filtro inclui outros status além de 'vacant', adicionar condições de inventory
    if (!onlyVacantFilter) {
      inventoryJoinConditions.push(
        ...inventoryConditions.filter(c => c.toString() !== gt(inventory.quantity, 0).toString())
      );
    }
    
    const results = await dbConn
      .select({
        // Usar locationId como ID principal para incluir endereços vazios
        id: sql<number>`COALESCE(${inventory.id}, ${warehouseLocations.id})`.as('id'),
        productId: inventory.productId,
        productSku: products.sku,
        productDescription: products.description,
        locationId: warehouseLocations.id,
        locationCode: warehouseLocations.code,
        locationStatus: warehouseLocations.status,
        locationTenantId: warehouseLocations.tenantId,
        zoneName: warehouseZones.name,
        batch: inventory.batch,
        expiryDate: inventory.expiryDate,
        quantity: inventory.quantity,
        reservedQuantity: inventory.reservedQuantity,
        status: inventory.status,
        tenantId: sql`COALESCE(${inventory.tenantId}, ${warehouseLocations.tenantId})`.as('tenantId'),
        tenantName: locationTenant.name,
        createdAt: inventory.createdAt,
        updatedAt: inventory.updatedAt,
      })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .leftJoin(locationTenant, eq(warehouseLocations.tenantId, locationTenant.id))
      .leftJoin(inventory, and(...inventoryJoinConditions))
      .leftJoin(products, eq(inventory.productId, products.id))
      .where(
        and(
          ...(locationConditions.length > 0 ? locationConditions : []),
          ...(whereConditions.length > 0 ? whereConditions : []),
          // Garantia final: nunca retornar linhas de inventory com quantidade zerada ou negativa.
          // O filtro no JOIN não é suficiente pois o LEFT JOIN pode retornar inventory.quantity = null
          // para registros que passaram pelo join mas têm quantity <= 0.
          // A condição OR isNull permite que endereços genuinamente vazios (sem inventory) ainda aparecem.
          sql`(${inventory.quantity} > 0 OR ${inventory.id} IS NULL)`,
          // Se filtro é APENAS 'vacant', retornar somente endereços sem inventory
          ...(onlyVacantFilter ? [sql`${inventory.id} IS NULL`] : [])
        )
      )
      .orderBy(warehouseLocations.code)
      .limit(1000);

    return results as InventoryPosition[];
  } else {
    // INNER JOIN: apenas endereços com inventory
    const results = await dbConn
      .select({
        id: inventory.id,
        productId: inventory.productId,
        productSku: products.sku,
        productDescription: products.description,
        locationId: inventory.locationId,
        locationCode: warehouseLocations.code,
        locationStatus: warehouseLocations.status,
        locationTenantId: warehouseLocations.tenantId,
        zoneName: warehouseZones.name,
        batch: inventory.batch,
        expiryDate: inventory.expiryDate,
        quantity: inventory.quantity,
        reservedQuantity: inventory.reservedQuantity,
        status: inventory.status,
        tenantId: inventory.tenantId,
        tenantName: locationTenant.name,
        createdAt: inventory.createdAt,
        updatedAt: inventory.updatedAt,
      })
      .from(inventory)
      .innerJoin(products, eq(inventory.productId, products.id))
      .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .leftJoin(locationTenant, eq(warehouseLocations.tenantId, locationTenant.id))
      .where(
        and(
          ...locationConditions,
          ...inventoryConditions,
          ...(whereConditions.length > 0 ? whereConditions : []),
          // Garantia explícita: nunca retornar registros com quantidade zerada
          gt(inventory.quantity, 0)
        )
      )
      .orderBy(warehouseLocations.code, products.sku)
      .limit(1000);

    return results;
  }
}

/**
 * Obtém resumo de estoque (cards de métricas)
 */
export async function getInventorySummary(filters: InventoryFilters) {
  const positions = await getInventoryPositions(filters);

  const totalQuantity = positions.reduce((sum, p) => sum + (p.quantity ?? 0), 0);
  // Contar apenas endereços que têm produto alocado (quantity > 0)
  const uniqueLocations = new Set(
    positions.filter((p) => p.productId != null && (p.quantity ?? 0) > 0).map((p) => p.locationId)
  ).size;
  const uniqueBatches = new Set(positions.map((p) => p.batch).filter(Boolean)).size;

  return {
    totalPositions: positions.length,
    totalQuantity,
    uniqueLocations,
    uniqueBatches,
  };
}

/**
 * Obtém saldo disponível em um endereço específico
 */
export async function getLocationStock(
  locationId: number,
  productId?: number,
  batch?: string
): Promise<number> {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  const conditions = [eq(inventory.locationId, locationId)];
  if (productId) conditions.push(eq(inventory.productId, productId));
  if (batch) conditions.push(eq(inventory.batch, batch));

  const result = await dbConn
    .select({ total: sql<number>`SUM(${inventory.quantity})` })
    .from(inventory)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}

/**
 * Obtém produtos com estoque abaixo do mínimo
 */
export async function getLowStockProducts(
  minQuantity: number = 10
): Promise<InventoryPosition[]> {
  return getInventoryPositions({ minQuantity });
}

/**
 * Obtém produtos próximos do vencimento
 */
export async function getExpiringProducts(
  daysThreshold: number = 30
): Promise<InventoryPosition[]> {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysThreshold);
  const futureDateStr = futureDate.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const locationTenant = alias(tenants, "locationTenant");

  const results = await dbConn
    .select({
      id: inventory.id,
      productId: inventory.productId,
      productSku: products.sku,
      productDescription: products.description,
      locationId: inventory.locationId,
      locationCode: warehouseLocations.code,
      locationStatus: warehouseLocations.status,
      locationTenantId: warehouseLocations.tenantId,
      zoneName: warehouseZones.name,
      batch: inventory.batch,
      expiryDate: inventory.expiryDate,
      quantity: inventory.quantity,
      reservedQuantity: inventory.reservedQuantity,
      status: inventory.status,
      tenantId: inventory.tenantId,
      tenantName: locationTenant.name,
      createdAt: inventory.createdAt,
      updatedAt: inventory.updatedAt,
    })
    .from(inventory)
    .innerJoin(products, eq(inventory.productId, products.id))
    .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
    .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .leftJoin(locationTenant, eq(warehouseLocations.tenantId, locationTenant.id))
    .where(
      and(
        lte(inventory.expiryDate, futureDateStr),
        gt(inventory.expiryDate, todayStr)
      )
    )
    .orderBy(inventory.expiryDate)
    .limit(1000);

  return results as InventoryPosition[];
}

/**
 * Lista endereços que possuem estoque disponível (descontando reservas)
 */
export async function getLocationsWithStock(tenantId?: number | null) {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");
  
  // Construir condições WHERE
  let whereConditions = [gt(inventory.quantity, 0)];
  if (tenantId !== undefined && tenantId !== null) {
    whereConditions.push(eq(inventory.tenantId, tenantId));
  }
  
  // Buscar endereços com estoque e calcular saldo disponível
  const results = await dbConn
    .select({
      locationId: inventory.locationId,
      code: warehouseLocations.code,
      zoneName: warehouseZones.name,
      zoneCode: warehouseZones.code,
      totalQuantity: sql<number>`SUM(${inventory.quantity})`,
      reservedQuantity: sql<number>`COALESCE(SUM(${pickingAllocations.quantity}), 0)`,
    })
    .from(inventory)
    .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
    .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .leftJoin(pickingAllocations, eq(pickingAllocations.locationId, inventory.locationId))
    .where(and(...whereConditions))
    .groupBy(
      inventory.locationId,
      warehouseLocations.id,
      warehouseLocations.code,
      warehouseZones.name,
      warehouseZones.code
    )
    .orderBy(warehouseLocations.code);
  
  // Filtrar apenas endereços com saldo disponível > 0
  const locationsWithAvailableStock = results
    .filter(loc => (loc.totalQuantity - loc.reservedQuantity) > 0)
    .map(loc => ({
      id: loc.locationId,
      code: loc.code,
      zoneName: loc.zoneName,
      zoneCode: loc.zoneCode,
    }));
  
  return locationsWithAvailableStock;
}

export async function getDestinationLocations(params: {
  movementType: string;
  productId?: number;
  batch?: string;
  tenantId?: number | null;
}) {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  const { movementType, productId, batch, tenantId } = params;

  // Para TRANSFERÊNCIA: filtrar por regras de armazenagem
  if (movementType === "transfer") {
    // Buscar todos os endereços (vazios E ocupados) do tenant selecionado
    // Endereços ocupados podem ser destino se contiverem o mesmo item-lote
    const allLocations = await dbConn
      .select({
        id: warehouseLocations.id,
        code: warehouseLocations.code,
        storageRule: warehouseLocations.storageRule,
        zoneName: warehouseZones.name,
        zoneCode: warehouseZones.code,
      })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .where(
        tenantId !== undefined && tenantId !== null
          ? eq(warehouseLocations.tenantId, tenantId)
          : sql`1=1`
      )
      .orderBy(warehouseLocations.code);

    // Buscar estoque atual de cada endereço (filtrado por tenant se fornecido)
    const locationStocks = await dbConn
      .select({
        locationId: inventory.locationId,
        productId: inventory.productId,
        batch: inventory.batch,
        quantity: inventory.quantity,
      })
      .from(inventory)
      .where(
        tenantId !== undefined && tenantId !== null
          ? and(
              gt(inventory.quantity, 0),
              eq(inventory.tenantId, tenantId)
            )
          : gt(inventory.quantity, 0)
      );

    // Criar mapa de estoque por endereço
    const stockMap = new Map<number, Array<{ productId: number; batch: string | null }>>();
    for (const stock of locationStocks) {
      if (!stockMap.has(stock.locationId)) {
        stockMap.set(stock.locationId, []);
      }
      stockMap.get(stock.locationId)!.push({
        productId: stock.productId,
        batch: stock.batch,
      });
    }

    // Filtrar endereços válidos
    const validLocations = allLocations.filter((loc) => {
      const stocks = stockMap.get(loc.id) || [];
      
      if (loc.storageRule === "single") {
        // Regra ÚNICO: aceita vazios ou ocupados pelo mesmo item-lote
        if (stocks.length === 0) return true; // Vazio
        if (stocks.length === 1 && stocks[0].productId === productId && stocks[0].batch === batch) {
          return true; // Mesmo item-lote
        }
        return false;
      } else {
        // Regra MULTI: aceita vazios ou ocupados por diferentes SKUs
        if (stocks.length === 0) return true; // Vazio
        // Verifica se já tem outros produtos (multi-SKU)
        const uniqueProducts = new Set(stocks.map(s => s.productId));
        return uniqueProducts.size >= 1; // Aceita se já tem produtos
      }
    });

    return validLocations;
  }

  // Para DEVOLUÇÃO: filtrar por zona "DEV" do cliente
  if (movementType === "return") {
    const results = await dbConn
      .select({
        id: warehouseLocations.id,
        code: warehouseLocations.code,
        storageRule: warehouseLocations.storageRule,
        zoneName: warehouseZones.name,
        zoneCode: warehouseZones.code,
      })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .where(
        tenantId !== undefined && tenantId !== null
          ? and(
              eq(warehouseLocations.status, "available"),
              eq(warehouseZones.code, "DEV"),
              eq(warehouseLocations.tenantId, tenantId)
            )
          : and(
              eq(warehouseLocations.status, "available"),
              eq(warehouseZones.code, "DEV")
            )
      )
      .orderBy(warehouseLocations.code);

    return results;
  }

  // Para QUALIDADE: filtrar por zona "NCG" do cliente
  if (movementType === "quality") {
    const results = await dbConn
      .select({
        id: warehouseLocations.id,
        code: warehouseLocations.code,
        storageRule: warehouseLocations.storageRule,
        zoneName: warehouseZones.name,
        zoneCode: warehouseZones.code,
      })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .where(
        tenantId !== undefined && tenantId !== null
          ? and(
              eq(warehouseLocations.status, "available"),
              eq(warehouseZones.code, "NCG"),
              eq(warehouseLocations.tenantId, tenantId)
            )
          : and(
              eq(warehouseLocations.status, "available"),
              eq(warehouseZones.code, "NCG")
            )
      )
      .orderBy(warehouseLocations.code);

    return results;
  }

  // Para AJUSTE e DESCARTE: retornar todos os endereços com estoque
  const results = await dbConn
    .selectDistinct({
      id: warehouseLocations.id,
      code: warehouseLocations.code,
      storageRule: warehouseLocations.storageRule,
      zoneName: warehouseZones.name,
      zoneCode: warehouseZones.code,
    })
    .from(inventory)
    .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
    .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .where(gt(inventory.quantity, 0))
    .orderBy(warehouseLocations.code);

  return results;
}

/**
 * Sugere endereço de destino baseado em pré-alocação
 * Usado quando movimentação origina da zona REC
 */
export async function getSuggestedDestination(params: {
  fromLocationId: number;
  productId: number;
  batch: string | null;
  quantity: number;
}) {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  // 1. Verificar se endereço origem é da zona REC
  const fromLocation = await dbConn
    .select({
      zoneCode: warehouseZones.code,
    })
    .from(warehouseLocations)
    .leftJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .where(eq(warehouseLocations.id, params.fromLocationId))
    .limit(1);

  if (!fromLocation[0] || fromLocation[0].zoneCode !== "REC") {
    return null; // Não é zona REC, não há sugestão
  }

  // 2. Buscar pré-alocação correspondente
  const preallocation = await dbConn
    .select({
      locationId: receivingPreallocations.locationId,
      code: warehouseLocations.code,
      zoneName: warehouseZones.name,
      quantity: receivingPreallocations.quantity,
    })
    .from(receivingPreallocations)
    .innerJoin(warehouseLocations, eq(receivingPreallocations.locationId, warehouseLocations.id))
    .leftJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
    .where(
      and(
        eq(receivingPreallocations.productId, params.productId),
        params.batch 
          ? eq(receivingPreallocations.batch, params.batch)
          : sql`${receivingPreallocations.batch} IS NULL`,
        eq(receivingPreallocations.quantity, params.quantity),
        eq(receivingPreallocations.status, "pending")
      )
    )
    .limit(1);

  if (!preallocation[0]) {
    return null; // Não há pré-alocação correspondente
  }

  return {
    locationId: preallocation[0].locationId,
    locationCode: preallocation[0].code,
    zoneName: preallocation[0].zoneName,
    quantity: preallocation[0].quantity,
  };
}

/**
 * Reconstrói a posição de estoque em uma data de referência específica.
 * Agrega todas as movimentações até o final do dia informado e retorna
 * o saldo por (produto, endereço, lote) com quantidade > 0.
 */
export async function getInventoryPositionsAtDate(
  referenceDate: string, // formato "YYYY-MM-DD"
  filters: Pick<InventoryFilters, "tenantId" | "search" | "zoneId" | "batch" | "locationCode">
): Promise<InventoryPosition[]> {
  const dbConn = await getDb();
  if (!dbConn) throw new Error("Database connection failed");

  // Importar inventoryMovements aqui para evitar dependência circular
  const { inventoryMovements } = await import("../drizzle/schema");

  // Fim do dia da data de referência (23:59:59)
  const endOfDay = `${referenceDate} 23:59:59`;

  const locationTenant = alias(tenants, "locationTenant");

  // Condições de filtro
  const conditions: ReturnType<typeof eq>[] = [
    lte(inventoryMovements.createdAt, sql`${endOfDay}` as any),
  ];

  if (filters.tenantId !== undefined) {
    if (filters.tenantId === null) {
      conditions.push(isNull(inventoryMovements.tenantId) as any);
    } else {
      conditions.push(eq(inventoryMovements.tenantId, filters.tenantId) as any);
    }
  }

  if (filters.batch) {
    conditions.push(like(inventoryMovements.batch, `%${filters.batch}%`) as any);
  }

  // Reconstruir saldo: entradas (toLocationId) somam, saídas (fromLocationId) subtraem
  // Usamos SQL raw para o UNION ALL + GROUP BY
  const snapshotQuery = sql`
    SELECT
      m.productId,
      m.batch,
      m.expiryDate,
      m.tenantId,
      CASE
        WHEN m.toLocationId IS NOT NULL THEN m.toLocationId
        ELSE m.fromLocationId
      END AS locationId,
      SUM(
        CASE
          WHEN m.toLocationId IS NOT NULL THEN m.quantity
          ELSE -m.quantity
        END
      ) AS quantity
    FROM inventoryMovements m
    WHERE m.createdAt <= ${endOfDay}
      ${filters.tenantId !== undefined
        ? filters.tenantId === null
          ? sql`AND m.tenantId IS NULL`
          : sql`AND m.tenantId = ${filters.tenantId}`
        : sql``}
      ${filters.batch ? sql`AND m.batch LIKE ${`%${filters.batch}%`}` : sql``}
    GROUP BY
      m.productId,
      m.batch,
      m.expiryDate,
      m.tenantId,
      CASE
        WHEN m.toLocationId IS NOT NULL THEN m.toLocationId
        ELSE m.fromLocationId
      END
    HAVING SUM(
      CASE
        WHEN m.toLocationId IS NOT NULL THEN m.quantity
        ELSE -m.quantity
      END
    ) > 0
  `;

  // Executar a query de snapshot
  const snapshotRows = await dbConn.execute(snapshotQuery) as any;
  const rows: Array<{
    productId: number;
    batch: string | null;
    expiryDate: string | null;
    tenantId: number | null;
    locationId: number;
    quantity: number;
  }> = Array.isArray(snapshotRows[0]) ? snapshotRows[0] : snapshotRows;

  if (rows.length === 0) return [];

  // Buscar detalhes de produtos e endereços para os IDs retornados
  const productIds = Array.from(new Set(rows.map(r => r.productId)));
  const locationIds = Array.from(new Set(rows.map(r => r.locationId)));

  const [productRows, locationRows] = await Promise.all([
    dbConn
      .select({ id: products.id, sku: products.sku, description: products.description })
      .from(products)
      .where(inArray(products.id, productIds)),
    dbConn
      .select({
        id: warehouseLocations.id,
        code: warehouseLocations.code,
        status: warehouseLocations.status,
        tenantId: warehouseLocations.tenantId,
        zoneId: warehouseLocations.zoneId,
        zoneName: warehouseZones.name,
        tenantName: locationTenant.name,
      })
      .from(warehouseLocations)
      .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
      .leftJoin(locationTenant, eq(warehouseLocations.tenantId, locationTenant.id))
      .where(inArray(warehouseLocations.id, locationIds)),
  ]);

  const productMap = new Map(productRows.map(p => [p.id, p]));
  const locationMap = new Map(locationRows.map(l => [l.id, l]));

  // Aplicar filtros adicionais (zona, endereço, busca por SKU/descrição)
  const now = new Date();
  const result: InventoryPosition[] = [];

  for (const row of rows) {
    const product = productMap.get(row.productId);
    const location = locationMap.get(row.locationId);
    if (!product || !location) continue;

    // Filtro de zona
    if (filters.zoneId && location.zoneId !== filters.zoneId) continue;

    // Filtro de código de endereço
    if (filters.locationCode && !location.code.toLowerCase().includes(filters.locationCode.toLowerCase())) continue;

    // Filtro de busca por SKU ou descrição
    if (filters.search) {
      const term = filters.search.toLowerCase();
      if (!product.sku.toLowerCase().includes(term) && !product.description.toLowerCase().includes(term)) continue;
    }

    result.push({
      id: row.productId * 100000 + row.locationId, // ID sintético para o frontend
      productId: row.productId,
      productSku: product.sku,
      productDescription: product.description,
      locationId: row.locationId,
      locationCode: location.code,
      locationStatus: location.status,
      locationTenantId: location.tenantId,
      zoneName: location.zoneName,
      batch: row.batch,
      expiryDate: row.expiryDate,
      quantity: Number(row.quantity),
      reservedQuantity: 0, // Reservas históricas não são reconstruídas
      status: "available",
      tenantId: row.tenantId,
      tenantName: location.tenantName ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return result.sort((a, b) => a.locationCode.localeCompare(b.locationCode));
}
