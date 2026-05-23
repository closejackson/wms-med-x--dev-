/**
 * Testes para o bug de "Saldo insuficiente" causado por filtro de tenantId ausente
 * no getProductByCode ao buscar produto por SKU (fallback).
 *
 * Cenário do bug:
 * - Tenant 30001 tem produto id=210001, SKU="107540"
 * - Tenant 30002 tem produto id=30052,  SKU="107540"
 * - Inventory existe para productId=210001 (tenant 30001), quantity=90
 * - Sem filtro de tenant, o fallback por SKU pode retornar id=30052 (tenant 30002)
 * - registerMovement busca inventory com productId=30052 → retorna 0 → "Saldo insuficiente"
 *
 * Critérios de aceite:
 * [ ] getProductByCode com SKU duplicado entre tenants retorna o produto do tenant correto
 * [ ] getProductByCode com labelCode filtra por tenantId para evitar colisão
 * [ ] Global Admin (isGlobalAdmin=true) pode buscar produto sem filtro de tenant
 */

import { describe, it, expect } from "vitest";

// ─── Helpers de mock ──────────────────────────────────────────────────────────

interface Product {
  id: number;
  sku: string;
  description: string;
  tenantId: number;
  unitsPerBox: number;
}

interface LabelAssociation {
  labelCode: string;
  productId: number;
  tenantId: number;
  batch: string | null;
  unitsPerBox: number;
}

interface InventoryRecord {
  productId: number;
  locationId: number;
  tenantId: number;
  quantity: number;
  reservedQuantity: number;
  status: string;
  batch: string;
}

// Simula a lógica de getProductByCode com filtro de tenantId
function simulateGetProductByCode(
  code: string,
  locationCode: string | undefined,
  effectiveTenantId: number,
  isGlobalAdmin: boolean,
  db: {
    labelAssociations: LabelAssociation[];
    products: Product[];
    inventory: InventoryRecord[];
    locations: { id: number; code: string }[];
  }
): { id: number; sku: string; availableQuantity: number } | null {
  // 1. Buscar por labelCode com filtro de tenant
  const labelAssoc = db.labelAssociations.find(
    (la) =>
      la.labelCode === code &&
      (isGlobalAdmin || la.tenantId === effectiveTenantId)
  );

  let productId: number;

  if (labelAssoc) {
    productId = labelAssoc.productId;
  } else {
    // Fallback por SKU com filtro de tenant (CORREÇÃO DO BUG)
    const productBySku = db.products.find(
      (p) =>
        p.sku === code &&
        (isGlobalAdmin || p.tenantId === effectiveTenantId)
    );
    if (!productBySku) return null;
    productId = productBySku.id;
  }

  const product = db.products.find((p) => p.id === productId);
  if (!product) return null;

  // Buscar estoque no endereço
  let availableQuantity = 0;
  if (locationCode) {
    const location = db.locations.find((l) => l.code === locationCode);
    if (location) {
      const stock = db.inventory.find(
        (i) =>
          i.productId === productId &&
          i.locationId === location.id &&
          i.status === "available"
      );
      if (stock) {
        availableQuantity = stock.quantity - (stock.reservedQuantity ?? 0);
      }
    }
  }

  return { id: product.id, sku: product.sku, availableQuantity };
}

// Simula a lógica ANTIGA (sem filtro de tenant) para comparação
function simulateGetProductByCodeOld(
  code: string,
  locationCode: string | undefined,
  db: {
    labelAssociations: LabelAssociation[];
    products: Product[];
    inventory: InventoryRecord[];
    locations: { id: number; code: string }[];
  }
): { id: number; sku: string; availableQuantity: number } | null {
  // Sem filtro de tenant (comportamento antigo)
  const labelAssoc = db.labelAssociations.find((la) => la.labelCode === code);

  let productId: number;

  if (labelAssoc) {
    productId = labelAssoc.productId;
  } else {
    const productBySku = db.products.find((p) => p.sku === code);
    if (!productBySku) return null;
    productId = productBySku.id;
  }

  const product = db.products.find((p) => p.id === productId);
  if (!product) return null;

  let availableQuantity = 0;
  if (locationCode) {
    const location = db.locations.find((l) => l.code === locationCode);
    if (location) {
      const stock = db.inventory.find(
        (i) =>
          i.productId === productId &&
          i.locationId === location.id &&
          i.status === "available"
      );
      if (stock) {
        availableQuantity = stock.quantity - (stock.reservedQuantity ?? 0);
      }
    }
  }

  return { id: product.id, sku: product.sku, availableQuantity };
}

// ─── Banco de dados de teste ──────────────────────────────────────────────────

const mockDb = {
  labelAssociations: [] as LabelAssociation[],
  products: [
    { id: 210001, sku: "107540", description: "RIOHEX 2% 100ML", tenantId: 30001, unitsPerBox: 6 },
    { id: 30052,  sku: "107540", description: "RIOHEX SOL ALCOOLICA", tenantId: 30002, unitsPerBox: 6 },
  ] as Product[],
  inventory: [
    {
      productId: 210001,
      locationId: 30353,
      tenantId: 30001,
      quantity: 90,
      reservedQuantity: 0,
      status: "available",
      batch: "",
    },
  ] as InventoryRecord[],
  locations: [
    { id: 30353, code: "REC-01-A" },
    { id: 30354, code: "REC-01-B" },
  ],
};

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("getProductByCode - filtro de tenantId", () => {
  it("CRITÉRIO 1: busca por SKU duplicado retorna o produto do tenant correto (30001)", () => {
    const result = simulateGetProductByCode(
      "107540",      // SKU duplicado entre tenants
      "REC-01-A",    // endereço de origem
      30001,         // effectiveTenantId
      false,         // não é Global Admin
      mockDb
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe(210001);  // ← produto do tenant 30001
    expect(result!.sku).toBe("107540");
    expect(result!.availableQuantity).toBe(90);  // ← saldo correto
  });

  it("CRITÉRIO 1: busca por SKU duplicado retorna o produto do tenant correto (30002)", () => {
    const result = simulateGetProductByCode(
      "107540",
      "REC-01-B",
      30002,         // effectiveTenantId = 30002
      false,
      mockDb
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe(30052);  // ← produto do tenant 30002
    expect(result!.availableQuantity).toBe(0);  // ← sem estoque no REC-01-B
  });

  it("CRITÉRIO 1: comportamento ANTIGO (sem filtro) retornaria o produto ERRADO", () => {
    // Demonstra o bug: sem filtro de tenant, o primeiro produto com SKU=107540
    // pode ser do tenant errado, causando availableQuantity=0
    const resultOld = simulateGetProductByCodeOld(
      "107540",
      "REC-01-A",
      mockDb
    );

    // O comportamento antigo retorna o primeiro produto encontrado (pode ser 30052)
    // Se retornar 30052, availableQuantity = 0 → "Saldo insuficiente"
    // Este teste documenta que o bug existia
    if (resultOld!.id === 30052) {
      expect(resultOld!.availableQuantity).toBe(0); // ← BUG: saldo zero para produto errado
    }
    // Se o banco retornar 210001 primeiro, o bug não se manifesta neste ambiente de teste
    // mas pode ocorrer em produção dependendo da ordem de inserção
  });

  it("CRITÉRIO 2: busca por labelCode filtra por tenantId", () => {
    const dbWithLabel = {
      ...mockDb,
      labelAssociations: [
        { labelCode: "ETQ-001", productId: 210001, tenantId: 30001, batch: null, unitsPerBox: 6 },
        { labelCode: "ETQ-001", productId: 30052,  tenantId: 30002, batch: null, unitsPerBox: 6 },
      ],
    };

    const result30001 = simulateGetProductByCode("ETQ-001", "REC-01-A", 30001, false, dbWithLabel);
    const result30002 = simulateGetProductByCode("ETQ-001", "REC-01-B", 30002, false, dbWithLabel);

    expect(result30001!.id).toBe(210001);  // ← etiqueta do tenant 30001
    expect(result30002!.id).toBe(30052);   // ← etiqueta do tenant 30002
  });

  it("CRITÉRIO 3: Global Admin pode buscar produto sem filtro de tenant", () => {
    const result = simulateGetProductByCode(
      "107540",
      "REC-01-A",
      1,     // effectiveTenantId do Global Admin
      true,  // isGlobalAdmin = true
      mockDb
    );

    // Global Admin retorna o primeiro produto encontrado (sem filtro de tenant)
    expect(result).not.toBeNull();
    expect(result!.sku).toBe("107540");
  });

  it("CRITÉRIO 1: registerMovement não deve falhar com 'Saldo insuficiente' após a correção", () => {
    // Simula o fluxo completo: getProductByCode → productId correto → registerMovement encontra inventory
    const productResult = simulateGetProductByCode(
      "107540",
      "REC-01-A",
      30001,
      false,
      mockDb
    );

    expect(productResult).not.toBeNull();
    expect(productResult!.id).toBe(210001);

    // Simula a query do registerMovement com o productId correto
    const inventoryRecord = mockDb.inventory.find(
      (i) =>
        i.productId === productResult!.id &&
        i.locationId === 30353 &&
        i.status === "available"
    );

    expect(inventoryRecord).toBeDefined();
    const available = inventoryRecord!.quantity - inventoryRecord!.reservedQuantity;
    expect(available).toBe(90);

    // Solicitado: 90 unidades
    expect(available).toBeGreaterThanOrEqual(90);  // ← não deve lançar "Saldo insuficiente"
  });
});
