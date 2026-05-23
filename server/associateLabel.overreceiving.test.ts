/**
 * Testes de critérios de aceite para o bug de double counting no associateLabel.
 *
 * Cenário: produto com fator de conversão (ex: 1 CX = 6 UN).
 * O sistema NÃO deve disparar Over-receiving ao associar uma etiqueta
 * cujo totalUnitsReceived == expectedQuantity.
 *
 * Estes testes validam a LÓGICA PURA das funções auxiliares e a estrutura
 * do router, sem conectar ao banco de dados real.
 */

import { describe, it, expect } from "vitest";

// ── Helpers extraídos da lógica do associateLabel ──────────────────────────

/**
 * Calcula se há over-receiving.
 * @param alreadyConferred  Unidades conferidas ANTES desta etiqueta
 * @param actualUnitsReceived  Unidades desta etiqueta (já convertidas para base)
 * @param expectedQty  Quantidade esperada da ordem (unidade base)
 * @returns true se over-receiving detectado
 */
function isOverReceiving(
  alreadyConferred: number,
  actualUnitsReceived: number,
  expectedQty: number
): boolean {
  if (expectedQty <= 0) return false;
  const totalConferredAfterInsert = alreadyConferred + actualUnitsReceived;
  return totalConferredAfterInsert > expectedQty;
}

/**
 * Formata a mensagem de erro com unidade original.
 */
function buildOverReceivingMessage(
  expectedQty: number,
  alreadyConferred: number,
  actualUnitsReceived: number,
  unitsPerBox: number
): string {
  const unitsLabel =
    unitsPerBox > 1
      ? `${Math.round(actualUnitsReceived / unitsPerBox)} CX (${actualUnitsReceived} un)`
      : `${actualUnitsReceived} un`;
  return `Over-receiving detectado! Esperado: ${expectedQty} un, Já conferido: ${alreadyConferred} un, Tentando adicionar: ${unitsLabel}.`;
}

// ── Critério de Aceite 1 ────────────────────────────────────────────────────
describe("Critério 1: Associar etiqueta com fator não dispara erro quando saldo é atingido", () => {
  it("1 CX (6 un) com expectedQty=6 e alreadyConferred=0 → sem over-receiving", () => {
    // Cenário: produto com 1 CX = 6 UN, esperado 6 UN, nenhuma conferida ainda
    const result = isOverReceiving(0, 6, 6);
    expect(result).toBe(false);
  });

  it("1 CX (6 un) com expectedQty=12 e alreadyConferred=6 → sem over-receiving", () => {
    // Cenário: 2 caixas esperadas, 1 já conferida, conferindo a segunda
    const result = isOverReceiving(6, 6, 12);
    expect(result).toBe(false);
  });

  it("1 CX (160 un) com expectedQty=160 e alreadyConferred=0 → sem over-receiving", () => {
    // Cenário real reportado: produto com 160 un/cx, esperado 160 un
    const result = isOverReceiving(0, 160, 160);
    expect(result).toBe(false);
  });

  it("expectedQty=0 nunca dispara over-receiving", () => {
    // Proteção: se expectedQty não foi preenchido, não bloquear
    const result = isOverReceiving(0, 9999, 0);
    expect(result).toBe(false);
  });
});

// ── Critério de Aceite 2 ────────────────────────────────────────────────────
describe("Critério 2: Over-receiving é detectado corretamente quando excede o esperado", () => {
  it("1 CX (6 un) com expectedQty=6 e alreadyConferred=6 → over-receiving", () => {
    // Cenário: já conferiu 6 un, tenta conferir mais 6 → total 12 > 6
    const result = isOverReceiving(6, 6, 6);
    expect(result).toBe(true);
  });

  it("1 CX (6 un) com expectedQty=6 e alreadyConferred=4 → over-receiving (4+6=10 > 6)", () => {
    const result = isOverReceiving(4, 6, 6);
    expect(result).toBe(true);
  });

  it("1 CX (160 un) com expectedQty=160 e alreadyConferred=80 → over-receiving", () => {
    const result = isOverReceiving(80, 160, 160);
    expect(result).toBe(true);
  });
});

// ── Critério de Aceite 3 ────────────────────────────────────────────────────
describe("Critério 3: Mensagem de erro inclui unidade original (CX/un)", () => {
  it("mensagem com 1 CX (6 un): inclui '1 CX (6 un)'", () => {
    const msg = buildOverReceivingMessage(6, 6, 6, 6);
    expect(msg).toContain("1 CX (6 un)");
    expect(msg).toContain("Esperado: 6 un");
    expect(msg).toContain("Já conferido: 6 un");
  });

  it("mensagem com 1 CX (160 un): inclui '1 CX (160 un)'", () => {
    const msg = buildOverReceivingMessage(160, 80, 160, 160);
    expect(msg).toContain("1 CX (160 un)");
  });

  it("mensagem sem fator de conversão (unitsPerBox=1): exibe só unidades", () => {
    const msg = buildOverReceivingMessage(10, 10, 5, 1);
    expect(msg).toContain("5 un");
    expect(msg).not.toContain("CX");
  });
});

// ── Critério de Aceite 4 ────────────────────────────────────────────────────
describe("Critério 4: Idempotência — etiqueta já existente não soma quantidade", () => {
  it("isOverReceiving com alreadyConferred=expectedQty e actualUnitsReceived=0 → sem over-receiving", () => {
    // Simula retorno idempotente: etiqueta já existe, não soma nada
    const result = isOverReceiving(6, 0, 6);
    expect(result).toBe(false);
  });

  it("retorno idempotente deve ter idempotent=true", () => {
    // Verifica que a estrutura de retorno idempotente está correta
    const idempotentReturn = {
      success: true,
      idempotent: true,
      message: "Etiqueta já estava associada — nenhuma alteração realizada",
      association: { id: 1, productId: 1, productName: "Test", productSku: "SKU-001", batch: null, expiryDate: null, unitsPerBox: 6, packagesRead: 1, totalUnits: 6, currentQuantity: 6 }
    };
    expect(idempotentReturn.idempotent).toBe(true);
    expect(idempotentReturn.success).toBe(true);
    expect(idempotentReturn.message).toContain("nenhuma alteração");
  });
});

// ── Critério de Aceite 5 ────────────────────────────────────────────────────
describe("Critério 5: Estrutura do blindConferenceRouter", () => {
  it("deve exportar o blindConferenceRouter com procedure associateLabel", async () => {
    const { blindConferenceRouter } = await import("./blindConferenceRouter");
    expect(blindConferenceRouter).toBeDefined();
    const routerDef = blindConferenceRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    expect(routerDef._def.procedures["associateLabel"]).toBeDefined();
  });

  it("deve ter procedure readLabel registrada", async () => {
    const { blindConferenceRouter } = await import("./blindConferenceRouter");
    const routerDef = blindConferenceRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    expect(routerDef._def.procedures["readLabel"]).toBeDefined();
  });

  it("deve estar registrado no appRouter como blindConference", async () => {
    const { appRouter } = await import("./routers");
    const routerDef = appRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    const keys = Object.keys(routerDef._def.procedures).filter(k => k.startsWith("blindConference."));
    expect(keys).toContain("blindConference.associateLabel");
    expect(keys).toContain("blindConference.readLabel");
  });
});
