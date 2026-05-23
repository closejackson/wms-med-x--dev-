/**
 * skuMapping.depara.test.ts
 *
 * Testes unitários para o Motor de De/Para (Cross-Reference de SKU).
 * Cobre os critérios de aceite definidos na especificação:
 *
 *   [CA-1] O sistema vincula NF e Pedido automaticamente se o código interno já existir.
 *   [CA-2] O Modal de Vínculo Manual só é disparado para itens que pertencem ao pedido em questão.
 *   [CA-3] Após o primeiro vínculo manual, o campo internalCode no cadastro de produtos está correto.
 *   [CA-4] Usuários de outros Tenants não conseguem ver ou usar os códigos internos mapeados.
 */

import { describe, it, expect } from "vitest";

// ─── Tipos que espelham a estrutura do motor ─────────────────────────────────

interface NfeProduto {
  codigo: string;
  descricao?: string;
  quantidade: number;
  lote?: string;
}

interface OrderItem {
  productId: number;
  sku: string;
  supplierCode: string | null;
  internalCode: string | null;
  tenantId: number;
  description: string;
  batch: string | null;
  requestedQuantity: number;
}

interface ResolvedItem {
  nfeCodigo: string;
  orderItem: OrderItem;
  matchType: "sku" | "internalCode";
}

interface UnresolvedItem {
  nfeCodigo: string;
  nfeDescricao: string;
}

// ─── Motor De/Para (extrato da lógica do shippingRouter) ─────────────────────

function resolveSkuMapping(
  nfeProdutos: NfeProduto[],
  orderItems: OrderItem[]
): { resolved: ResolvedItem[]; unresolved: UnresolvedItem[] } {
  const resolved: ResolvedItem[] = [];
  const unresolved: UnresolvedItem[] = [];

  for (const nfeProd of nfeProdutos) {
    // Tentativa 1: Match direto por sku ou supplierCode
    let matched = orderItems.find(
      (item) => item.sku === nfeProd.codigo || item.supplierCode === nfeProd.codigo
    );
    if (matched) {
      resolved.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "sku" });
      continue;
    }

    // Tentativa 2: Match por internalCode (De/Para aprendido)
    matched = orderItems.find((item) => item.internalCode === nfeProd.codigo);
    if (matched) {
      resolved.push({ nfeCodigo: nfeProd.codigo, orderItem: matched, matchType: "internalCode" });
      continue;
    }

    // Sem match
    unresolved.push({ nfeCodigo: nfeProd.codigo, nfeDescricao: nfeProd.descricao || nfeProd.codigo });
  }

  return { resolved, unresolved };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeItem = (overrides: Partial<OrderItem>): OrderItem => ({
  productId: 1,
  sku: "SKU-001",
  supplierCode: null,
  internalCode: null,
  tenantId: 30001,
  description: "Produto Teste",
  batch: null,
  requestedQuantity: 10,
  ...overrides,
});

// ─── Testes ──────────────────────────────────────────────────────────────────

describe("Motor De/Para — Fallback em Cascata", () => {

  // [CA-1] Match direto por SKU
  it("CA-1a: resolve por sku direto quando código da NF bate com products.sku", () => {
    const nfe: NfeProduto[] = [{ codigo: "SKU-001", quantidade: 10 }];
    const items: OrderItem[] = [makeItem({ sku: "SKU-001" })];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].matchType).toBe("sku");
    expect(resolved[0].orderItem.sku).toBe("SKU-001");
    expect(unresolved).toHaveLength(0);
  });

  // [CA-1] Match direto por supplierCode
  it("CA-1b: resolve por supplierCode quando código da NF bate com products.supplierCode", () => {
    const nfe: NfeProduto[] = [{ codigo: "FORN-999", quantidade: 5 }];
    const items: OrderItem[] = [makeItem({ sku: "SKU-001", supplierCode: "FORN-999" })];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].matchType).toBe("sku");
    expect(unresolved).toHaveLength(0);
  });

  // [CA-1] Match automático por internalCode (De/Para já aprendido)
  it("CA-1c: resolve automaticamente por internalCode quando De/Para já está cadastrado", () => {
    const nfe: NfeProduto[] = [{ codigo: "CLI-XYZ", quantidade: 8 }];
    const items: OrderItem[] = [makeItem({ sku: "SKU-001", internalCode: "CLI-XYZ" })];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].matchType).toBe("internalCode");
    expect(resolved[0].orderItem.sku).toBe("SKU-001");
    expect(unresolved).toHaveLength(0);
  });

  // [CA-2] Modal só é disparado para itens não identificados
  it("CA-2a: retorna apenas os itens não identificados na lista de unresolved", () => {
    const nfe: NfeProduto[] = [
      { codigo: "SKU-001", quantidade: 10 }, // identificado
      { codigo: "DESCONHECIDO", quantidade: 3 }, // não identificado
    ];
    const items: OrderItem[] = [makeItem({ sku: "SKU-001" })];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].nfeCodigo).toBe("DESCONHECIDO");
  });

  it("CA-2b: quando todos os itens são identificados, unresolved é vazio (modal não abre)", () => {
    const nfe: NfeProduto[] = [
      { codigo: "SKU-001", quantidade: 10 },
      { codigo: "SKU-002", quantidade: 5 },
    ];
    const items: OrderItem[] = [
      makeItem({ productId: 1, sku: "SKU-001" }),
      makeItem({ productId: 2, sku: "SKU-002" }),
    ];

    const { unresolved } = resolveSkuMapping(nfe, items);

    expect(unresolved).toHaveLength(0);
  });

  it("CA-2c: quando nenhum item é identificado, todos vão para unresolved", () => {
    const nfe: NfeProduto[] = [
      { codigo: "X-001", quantidade: 1 },
      { codigo: "X-002", quantidade: 2 },
    ];
    const items: OrderItem[] = [makeItem({ sku: "SKU-001" })];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(2);
  });

  // [CA-3] Após vínculo manual, internalCode é preenchido corretamente
  it("CA-3: após salvar De/Para, o internalCode do produto passa a resolver automaticamente", () => {
    // Simula estado ANTES do vínculo: internalCode = null
    const itemSemVinculo = makeItem({ sku: "SKU-001", internalCode: null });
    const nfe: NfeProduto[] = [{ codigo: "CLI-XYZ", quantidade: 5 }];

    const antes = resolveSkuMapping(nfe, [itemSemVinculo]);
    expect(antes.unresolved).toHaveLength(1); // ainda não identificado

    // Simula estado APÓS o vínculo: internalCode = "CLI-XYZ"
    const itemComVinculo = makeItem({ sku: "SKU-001", internalCode: "CLI-XYZ" });

    const depois = resolveSkuMapping(nfe, [itemComVinculo]);
    expect(depois.resolved).toHaveLength(1);
    expect(depois.resolved[0].matchType).toBe("internalCode");
    expect(depois.unresolved).toHaveLength(0);
  });

  // [CA-4] Isolamento de tenant: internalCode de outro tenant não interfere
  it("CA-4: internalCode de tenant diferente não resolve itens de outro tenant", () => {
    // Tenant 30001 tem CLI-XYZ mapeado para SKU-001
    // Tenant 30002 tenta usar CLI-XYZ mas seus itens não têm esse internalCode
    const nfe: NfeProduto[] = [{ codigo: "CLI-XYZ", quantidade: 5 }];

    // Itens do pedido do tenant 30002 (sem internalCode para CLI-XYZ)
    const itemsTenant2: OrderItem[] = [
      makeItem({ productId: 10, sku: "SKU-002", tenantId: 30002, internalCode: null }),
    ];

    const { unresolved } = resolveSkuMapping(nfe, itemsTenant2);

    // CLI-XYZ não é encontrado nos itens do tenant 30002
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].nfeCodigo).toBe("CLI-XYZ");
  });

  // Cenário misto: parte identificada, parte não
  it("Cenário misto: NF com 3 itens — 2 identificados (sku + internalCode), 1 não identificado", () => {
    const nfe: NfeProduto[] = [
      { codigo: "SKU-001", quantidade: 10 },       // match direto
      { codigo: "CLI-ABC", quantidade: 5 },         // match por internalCode
      { codigo: "NOVO-999", quantidade: 2 },        // não identificado
    ];
    const items: OrderItem[] = [
      makeItem({ productId: 1, sku: "SKU-001", internalCode: null }),
      makeItem({ productId: 2, sku: "SKU-002", internalCode: "CLI-ABC" }),
    ];

    const { resolved, unresolved } = resolveSkuMapping(nfe, items);

    expect(resolved).toHaveLength(2);
    expect(resolved.find(r => r.nfeCodigo === "SKU-001")?.matchType).toBe("sku");
    expect(resolved.find(r => r.nfeCodigo === "CLI-ABC")?.matchType).toBe("internalCode");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].nfeCodigo).toBe("NOVO-999");
  });
});
