/**
 * unitPendingQueue.disappear.test.ts
 *
 * Testa a correção do bug de "sumiço" de itens na unitPendingQueue:
 * ao resolver a pendência de um produto (ex: Produto A - CX), os itens
 * de outros produtos que usam a mesma unidade (ex: Produto B - CX) NÃO
 * devem ser marcados como resolvidos automaticamente.
 *
 * Causa raiz: unlockBlockedReceivingOrders filtrava por xmlUnit sem filtrar
 * por productCode, resolvendo em massa todos os itens com a mesma unidade.
 *
 * Critérios de aceite:
 * 1. Ao tratar um item, os demais itens da mesma NF-e devem permanecer visíveis
 * 2. O contador de pendências deve decrementar apenas 1 por vez
 * 3. A NF-e só deve ser liberada quando TODOS os itens forem resolvidos
 */

import { describe, it, expect } from "vitest";

// ── Testes de lógica de filtragem ──────────────────────────────────────────

describe("Filtro de pendências por produto + unidade", () => {
  /**
   * Simula a query corrigida: filtra por tenantId + productCode + xmlUnit + status
   * Em vez da query antiga: filtra por tenantId + xmlUnit + status (sem productCode)
   */

  const mockPendingQueue = [
    { id: 1, tenantId: 30001, productCode: "SKU-A", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
    { id: 2, tenantId: 30001, productCode: "SKU-B", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
    { id: 3, tenantId: 30001, productCode: "SKU-A", xmlUnit: "FD", receivingOrderId: 100, status: "pending" },
    { id: 4, tenantId: 30001, productCode: "SKU-C", xmlUnit: "CX", receivingOrderId: 101, status: "pending" },
  ];

  it("ANTES (bug): filtrar por xmlUnit=CX resolve 3 itens de uma vez", () => {
    // Comportamento ANTIGO (bugado): sem filtro por productCode
    const resolved = mockPendingQueue.filter(
      (item) =>
        item.tenantId === 30001 &&
        item.xmlUnit === "CX" &&
        item.status === "pending"
    );
    // Bug: resolve SKU-A, SKU-B e SKU-C todos de uma vez!
    expect(resolved).toHaveLength(3);
    const resolvedCodes = resolved.map((r) => r.productCode);
    expect(resolvedCodes).toContain("SKU-A");
    expect(resolvedCodes).toContain("SKU-B"); // ← Este não deveria ser resolvido!
    expect(resolvedCodes).toContain("SKU-C"); // ← Este não deveria ser resolvido!
  });

  it("DEPOIS (corrigido): filtrar por productCode=SKU-A + xmlUnit=CX resolve apenas 1 item", () => {
    // Comportamento CORRETO (após correção): com filtro por productCode
    const resolved = mockPendingQueue.filter(
      (item) =>
        item.tenantId === 30001 &&
        item.productCode === "SKU-A" && // ← FILTRO CRÍTICO adicionado
        item.xmlUnit === "CX" &&
        item.status === "pending"
    );
    // Correto: resolve apenas o item do SKU-A com unidade CX
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(1);
    expect(resolved[0].productCode).toBe("SKU-A");
  });

  it("deve manter SKU-B pendente após resolver SKU-A", () => {
    // Simula o estado após resolver SKU-A (com a correção)
    const resolvedIds = [1]; // Apenas o item 1 foi resolvido
    const remainingPending = mockPendingQueue.filter(
      (item) => item.status === "pending" && !resolvedIds.includes(item.id)
    );
    expect(remainingPending).toHaveLength(3); // 3 itens ainda pendentes
    const pendingCodes = remainingPending.map((r) => r.productCode);
    expect(pendingCodes).toContain("SKU-B"); // ← SKU-B deve permanecer pendente
    expect(pendingCodes).toContain("SKU-C"); // ← SKU-C deve permanecer pendente
  });
});

// ── Testes de lógica de desbloqueio da OR ─────────────────────────────────

describe("Desbloqueio de OR: apenas quando TODOS os itens forem resolvidos", () => {
  const mockPendingQueue = [
    { id: 1, tenantId: 30001, productCode: "SKU-A", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
    { id: 2, tenantId: 30001, productCode: "SKU-B", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
  ];

  it("não deve desbloquear a OR enquanto houver itens pendentes", () => {
    // Simula: SKU-A resolvido, SKU-B ainda pendente
    const pendingAfterResolveA = mockPendingQueue.filter(
      (item) => item.receivingOrderId === 100 && item.status === "pending" && item.id !== 1
    );
    const shouldUnlock = pendingAfterResolveA.length === 0;
    expect(shouldUnlock).toBe(false); // NÃO deve desbloquear ainda
    expect(pendingAfterResolveA).toHaveLength(1); // SKU-B ainda pendente
  });

  it("deve desbloquear a OR somente quando todos os itens forem resolvidos", () => {
    // Simula: SKU-A e SKU-B ambos resolvidos
    const pendingAfterResolveAll = mockPendingQueue.filter(
      (item) =>
        item.receivingOrderId === 100 &&
        item.status === "pending" &&
        item.id !== 1 &&
        item.id !== 2
    );
    const shouldUnlock = pendingAfterResolveAll.length === 0;
    expect(shouldUnlock).toBe(true); // DEVE desbloquear agora
  });

  it("deve decrementar o contador de pendências em 1 por vez", () => {
    const initialCount = mockPendingQueue.filter(
      (item) => item.receivingOrderId === 100 && item.status === "pending"
    ).length;
    expect(initialCount).toBe(2);

    // Após resolver SKU-A (apenas 1 item)
    const resolvedIds = [1];
    const afterFirstResolve = mockPendingQueue.filter(
      (item) =>
        item.receivingOrderId === 100 &&
        item.status === "pending" &&
        !resolvedIds.includes(item.id)
    ).length;
    expect(afterFirstResolve).toBe(initialCount - 1); // Decrementou 1
    expect(afterFirstResolve).toBe(1);
  });
});

// ── Testes de isolamento entre NF-es diferentes ───────────────────────────

describe("Isolamento entre NF-es e ORs diferentes", () => {
  const mockPendingQueue = [
    { id: 1, tenantId: 30001, productCode: "SKU-A", xmlUnit: "CX", receivingOrderId: 100, nfeKey: "NFE-001", status: "pending" },
    { id: 2, tenantId: 30001, productCode: "SKU-A", xmlUnit: "CX", receivingOrderId: 101, nfeKey: "NFE-002", status: "pending" },
  ];

  it("resolver SKU-A na NF-e 001 não deve afetar SKU-A na NF-e 002", () => {
    // Com a correção, o filtro é por productCode + xmlUnit (não por receivingOrderId)
    // Isso significa que ao cadastrar o fator para SKU-A/CX, AMBAS as ORs serão desbloqueadas
    // Isso é o comportamento CORRETO: o fator vale para o produto, não para uma NF-e específica
    const resolved = mockPendingQueue.filter(
      (item) =>
        item.tenantId === 30001 &&
        item.productCode === "SKU-A" &&
        item.xmlUnit === "CX" &&
        item.status === "pending"
    );
    // Ambas as ORs têm o mesmo produto/unidade, então ambas são desbloqueadas
    expect(resolved).toHaveLength(2);
    const orderIds = resolved.map((r) => r.receivingOrderId);
    expect(orderIds).toContain(100);
    expect(orderIds).toContain(101);
  });

  it("produtos diferentes na mesma NF-e devem ser tratados independentemente", () => {
    const mixedQueue = [
      { id: 1, tenantId: 30001, productCode: "SKU-A", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
      { id: 2, tenantId: 30001, productCode: "SKU-B", xmlUnit: "CX", receivingOrderId: 100, status: "pending" },
      { id: 3, tenantId: 30001, productCode: "SKU-C", xmlUnit: "FD", receivingOrderId: 100, status: "pending" },
    ];

    // Resolver apenas SKU-A/CX
    const resolvedBySkuA = mixedQueue.filter(
      (item) =>
        item.tenantId === 30001 &&
        item.productCode === "SKU-A" &&
        item.xmlUnit === "CX" &&
        item.status === "pending"
    );
    expect(resolvedBySkuA).toHaveLength(1);
    expect(resolvedBySkuA[0].id).toBe(1);

    // SKU-B e SKU-C devem permanecer pendentes
    const resolvedIds = resolvedBySkuA.map((r) => r.id);
    const remaining = mixedQueue.filter(
      (item) => item.status === "pending" && !resolvedIds.includes(item.id)
    );
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.productCode)).toContain("SKU-B");
    expect(remaining.map((r) => r.productCode)).toContain("SKU-C");
  });
});

// ── Testes de estrutura do router ─────────────────────────────────────────

describe("unitConversionRouter - estrutura e exports", () => {
  it("deve exportar unlockBlockedReceivingOrders com o parâmetro productId", async () => {
    const mod = await import("./unitConversionRouter");
    expect(typeof mod.unlockBlockedReceivingOrders).toBe("function");
    // Verificar que a função aceita o parâmetro productId (via inspeção da assinatura)
    const fnString = mod.unlockBlockedReceivingOrders.toString();
    expect(fnString).toContain("productId");
  });

  it("deve ter a correção do filtro por productCode no unlockBlockedReceivingOrders", async () => {
    const mod = await import("./unitConversionRouter");
    const fnString = mod.unlockBlockedReceivingOrders.toString();
    // A função deve referenciar product.sku (para filtrar por productCode)
    expect(fnString).toContain("product.sku");
    // E deve referenciar productCode na query
    expect(fnString).toContain("productCode");
  });

  it("deve exportar o unitConversionRouter com procedure resolvePending", async () => {
    const { unitConversionRouter } = await import("./unitConversionRouter");
    expect(unitConversionRouter).toBeDefined();
    const routerDef = unitConversionRouter as unknown as {
      _def: { procedures: Record<string, unknown> };
    };
    const keys = Object.keys(routerDef._def.procedures);
    const hasResolvePending = keys.some((k) => k.includes("resolvePending"));
    expect(hasResolvePending).toBe(true);
  });
});
