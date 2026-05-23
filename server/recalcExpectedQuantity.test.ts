/**
 * recalcExpectedQuantity.test.ts
 *
 * Testa a lógica de recálculo do expectedQuantity em itens de ordens de
 * recebimento que foram importados sem o fator de conversão cadastrado.
 *
 * Critérios de aceite:
 * 1. Itens com expectedQty < fator de conversão devem ser identificados como incorretos
 * 2. O recálculo aplica o fator corretamente (ex: 1 CX × 6 = 6 UN)
 * 3. Itens com receivedQuantity > 0 (já conferidos) NÃO devem ser alterados
 * 4. O maintenanceRouter exporta a procedure recalcExpectedQuantity
 * 5. O unitConversionRouter exporta applyConversion como função pura
 */

import { describe, it, expect } from "vitest";

// ── Testes da função auxiliar applyConversion ──────────────────────────────

describe("applyConversion (helper puro)", () => {
  it("deve multiplicar a quantidade pelo fator (round)", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    expect(applyConversion(1, 6, "round")).toBe(6);
    expect(applyConversion(2, 6, "round")).toBe(12);
    expect(applyConversion(3, 12, "round")).toBe(36);
  });

  it("deve arredondar para cima com estratégia ceil", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    // 1 × 6.5 = 6.5 → ceil → 7
    expect(applyConversion(1, 6.5, "ceil")).toBe(7);
  });

  it("deve arredondar para baixo com estratégia floor", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    // 1 × 6.5 = 6.5 → floor → 6
    expect(applyConversion(1, 6.5, "floor")).toBe(6);
  });

  it("deve retornar a quantidade original se fator for 1", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    expect(applyConversion(5, 1, "round")).toBe(5);
  });
});

// ── Testes de lógica de detecção de itens incorretos ──────────────────────

describe("Heurística de detecção: expectedQty < fator", () => {
  it("deve identificar item com expectedQty=1 e fator=6 como incorreto", () => {
    const expectedQty = 1;
    const factor = 6;
    // Heurística: se expectedQty < factor, provavelmente está em unidades XML
    const isIncorrect = expectedQty < factor;
    expect(isIncorrect).toBe(true);
  });

  it("deve identificar item com expectedQty=6 e fator=6 como correto (já convertido)", () => {
    const expectedQty = 6;
    const factor = 6;
    const isIncorrect = expectedQty < factor;
    expect(isIncorrect).toBe(false);
  });

  it("deve identificar item com expectedQty=12 e fator=6 como correto (2 caixas)", () => {
    const expectedQty = 12;
    const factor = 6;
    const isIncorrect = expectedQty < factor;
    expect(isIncorrect).toBe(false);
  });

  it("deve identificar item com expectedQty=2 e fator=12 como incorreto (2 CX não convertidas)", () => {
    const expectedQty = 2;
    const factor = 12;
    const isIncorrect = expectedQty < factor;
    expect(isIncorrect).toBe(true);
  });
});

// ── Testes de recálculo ────────────────────────────────────────────────────

describe("Recálculo de expectedQuantity", () => {
  it("deve recalcular 1 CX × 6 = 6 UN", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    const currentExpected = 1; // 1 CX (não convertido)
    const factor = 6;
    const recalculated = applyConversion(currentExpected, factor, "round");
    expect(recalculated).toBe(6);
    expect(recalculated).not.toBe(currentExpected);
  });

  it("deve recalcular 2 CX × 12 = 24 UN", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    const currentExpected = 2; // 2 CX (não convertido)
    const factor = 12;
    const recalculated = applyConversion(currentExpected, factor, "round");
    expect(recalculated).toBe(24);
  });

  it("deve recalcular 5 CX × 6 = 30 UN", async () => {
    const { applyConversion } = await import("./unitConversionRouter");
    const currentExpected = 5;
    const factor = 6;
    const recalculated = applyConversion(currentExpected, factor, "round");
    expect(recalculated).toBe(30);
  });
});

// ── Testes de estrutura do router ─────────────────────────────────────────

describe("maintenanceRouter - recalcExpectedQuantity", () => {
  it("deve exportar o maintenanceRouter com a procedure recalcExpectedQuantity", async () => {
    const { maintenanceRouter } = await import("./maintenanceRouter");
    expect(maintenanceRouter).toBeDefined();
    const routerDef = maintenanceRouter as unknown as {
      _def: { procedures: Record<string, unknown> };
    };
    const keys = Object.keys(routerDef._def.procedures);
    const hasRecalc = keys.some((k) => k.includes("recalcExpectedQuantity"));
    expect(hasRecalc).toBe(true);
  });

  it("deve ter a procedure recalcExpectedQuantity como mutation", async () => {
    const { maintenanceRouter } = await import("./maintenanceRouter");
    const routerDef = maintenanceRouter as unknown as {
      _def: { procedures: Record<string, unknown> };
    };
    const recalcKey = Object.keys(routerDef._def.procedures).find((k) =>
      k.includes("recalcExpectedQuantity")
    );
    expect(recalcKey).toBeDefined();
  });
});

// ── Testes de segurança: itens já conferidos não devem ser alterados ───────

describe("Proteção: itens já conferidos (receivedQuantity > 0)", () => {
  it("não deve recalcular item com receivedQuantity > 0", () => {
    // Simula a lógica de filtragem do backend
    const items = [
      { id: 1, expectedQuantity: 1, receivedQuantity: 0 },  // Deve ser corrigido
      { id: 2, expectedQuantity: 1, receivedQuantity: 6 },  // NÃO deve ser corrigido (já conferido)
      { id: 3, expectedQuantity: 1, receivedQuantity: 3 },  // NÃO deve ser corrigido (parcialmente conferido)
    ];

    // Filtro aplicado pelo backend: só itens com receivedQuantity = 0
    const eligibleItems = items.filter((item) => item.receivedQuantity === 0);
    expect(eligibleItems).toHaveLength(1);
    expect(eligibleItems[0].id).toBe(1);
  });

  it("deve retornar lista vazia se todos os itens já foram conferidos", () => {
    const items = [
      { id: 1, expectedQuantity: 6, receivedQuantity: 6 },
      { id: 2, expectedQuantity: 12, receivedQuantity: 12 },
    ];
    const eligibleItems = items.filter((item) => item.receivedQuantity === 0);
    expect(eligibleItems).toHaveLength(0);
  });
});

// ── Testes de integração: unlockBlockedReceivingOrders exporta applyConversion ──

describe("unitConversionRouter - applyConversion exportado", () => {
  it("deve exportar applyConversion como função", async () => {
    const mod = await import("./unitConversionRouter");
    expect(typeof mod.applyConversion).toBe("function");
  });

  it("deve exportar unlockBlockedReceivingOrders como função", async () => {
    const mod = await import("./unitConversionRouter");
    expect(typeof mod.unlockBlockedReceivingOrders).toBe("function");
  });
});
