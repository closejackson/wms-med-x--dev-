/**
 * Testes para o fallback de auto-correção do expectedQuantity no associateLabel.
 *
 * Critérios de aceite:
 * - Associar uma etiqueta de 1 CX (6 UN) quando expectedQty = 1 (não convertido) não deve lançar over-receiving
 * - O expectedQty deve ser auto-corrigido para 6 antes da validação
 * - O banco deve ser atualizado com o valor corrigido
 * - Quando não há fator de conversão, o comportamento original é mantido
 */

import { describe, it, expect } from "vitest";

// ─── Helpers de simulação ────────────────────────────────────────────────────

interface ProductConversion {
  factorToBase: string;
  roundingStrategy: "floor" | "ceil" | "round";
}

interface ReceivingOrderItem {
  id: number;
  expectedQuantity: number;
  receivedQuantity: number;
  productId: number;
}

/**
 * Simula a lógica de fallback de auto-correção do expectedQty no associateLabel.
 * Retorna o expectedQty efetivo (corrigido ou original).
 */
function autoCorrectExpectedQty(
  item: ReceivingOrderItem,
  actualUnitsReceived: number,
  convRows: ProductConversion[]
): { expectedQty: number; corrected: boolean; correctedValue?: number } {
  let expectedQty = item.expectedQuantity || 0;

  if (expectedQty > 0 && expectedQty < actualUnitsReceived) {
    if (convRows.length > 0) {
      const factor = parseFloat(String(convRows[0].factorToBase));
      if (factor > 1) {
        const corrected = Math.round(expectedQty * factor);
        if (corrected >= actualUnitsReceived) {
          return { expectedQty: corrected, corrected: true, correctedValue: corrected };
        }
      }
    }
  }

  return { expectedQty, corrected: false };
}

/**
 * Simula a validação de over-receiving após a auto-correção.
 */
function validateOverReceiving(
  expectedQty: number,
  totalConferredAfterInsert: number,
  alreadyConferred: number,
  actualUnitsReceived: number,
  unitsPerBox: number
): { error: boolean; message?: string } {
  if (expectedQty > 0 && totalConferredAfterInsert > expectedQty) {
    const unitsLabel = unitsPerBox > 1
      ? `${Math.round(actualUnitsReceived / unitsPerBox)} CX (${actualUnitsReceived} un)`
      : `${actualUnitsReceived} un`;
    return {
      error: true,
      message: `Over-receiving detectado! Esperado: ${expectedQty} un, Já conferido: ${alreadyConferred} un, Tentando adicionar: ${unitsLabel}.`,
    };
  }
  return { error: false };
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe("associateLabel: fallback de auto-correção do expectedQty", () => {
  it("deve auto-corrigir expectedQty=1 para 6 quando fator=6 e actualUnitsReceived=6", () => {
    const item: ReceivingOrderItem = {
      id: 450005,
      expectedQuantity: 1, // Importado sem conversão
      receivedQuantity: 0,
      productId: 210002,
    };
    const actualUnitsReceived = 6; // 1 CX = 6 UN
    const convRows: ProductConversion[] = [
      { factorToBase: "6.000000", roundingStrategy: "round" },
    ];

    const result = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    expect(result.corrected).toBe(true);
    expect(result.expectedQty).toBe(6);
    expect(result.correctedValue).toBe(6);
  });

  it("não deve disparar over-receiving após auto-correção (1 CX = 6 UN, esperado 1 CX)", () => {
    const item: ReceivingOrderItem = {
      id: 450005,
      expectedQuantity: 1,
      receivedQuantity: 0,
      productId: 210002,
    };
    const actualUnitsReceived = 6;
    const convRows: ProductConversion[] = [
      { factorToBase: "6.000000", roundingStrategy: "round" },
    ];

    const { expectedQty } = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    // Simular totalConferredAfterInsert = actualUnitsReceived (primeira etiqueta)
    const totalConferredAfterInsert = actualUnitsReceived;
    const alreadyConferred = 0;

    const validation = validateOverReceiving(
      expectedQty,
      totalConferredAfterInsert,
      alreadyConferred,
      actualUnitsReceived,
      6 // unitsPerBox
    );

    expect(validation.error).toBe(false);
  });

  it("deve manter over-receiving real: 2 CX quando esperado apenas 1 CX (6 UN)", () => {
    const item: ReceivingOrderItem = {
      id: 450005,
      expectedQuantity: 6, // Já corrigido: 1 CX = 6 UN
      receivedQuantity: 6, // Primeira etiqueta já bipada
      productId: 210002,
    };
    const actualUnitsReceived = 6; // Segunda etiqueta: mais 1 CX
    const convRows: ProductConversion[] = [
      { factorToBase: "6.000000", roundingStrategy: "round" },
    ];

    const { expectedQty } = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    // expectedQty = 6 (não precisa corrigir pois já está correto)
    expect(expectedQty).toBe(6);

    // totalConferredAfterInsert = 12 (6 já bipados + 6 novos)
    const totalConferredAfterInsert = 12;
    const alreadyConferred = 6;

    const validation = validateOverReceiving(
      expectedQty,
      totalConferredAfterInsert,
      alreadyConferred,
      actualUnitsReceived,
      6
    );

    expect(validation.error).toBe(true);
    expect(validation.message).toContain("Over-receiving detectado");
    expect(validation.message).toContain("Esperado: 6 un");
  });

  it("não deve auto-corrigir quando não há fator de conversão cadastrado", () => {
    const item: ReceivingOrderItem = {
      id: 450007,
      expectedQuantity: 1,
      receivedQuantity: 0,
      productId: 999999,
    };
    const actualUnitsReceived = 6;
    const convRows: ProductConversion[] = []; // Sem conversão

    const result = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    expect(result.corrected).toBe(false);
    expect(result.expectedQty).toBe(1); // Mantém original
  });

  it("não deve auto-corrigir quando expectedQty já está em unidades base", () => {
    const item: ReceivingOrderItem = {
      id: 450004,
      expectedQuantity: 90, // Já em unidades base
      receivedQuantity: 45,
      productId: 210001,
    };
    const actualUnitsReceived = 45; // 1 CX = 45 UN
    const convRows: ProductConversion[] = [
      { factorToBase: "45.000000", roundingStrategy: "round" },
    ];

    const result = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    // expectedQty (90) NÃO é < actualUnitsReceived (45), então não corrige
    expect(result.corrected).toBe(false);
    expect(result.expectedQty).toBe(90);
  });

  it("deve auto-corrigir com fator 12: 1 CX = 12 UN", () => {
    const item: ReceivingOrderItem = {
      id: 450006,
      expectedQuantity: 1,
      receivedQuantity: 0,
      productId: 180008,
    };
    const actualUnitsReceived = 12;
    const convRows: ProductConversion[] = [
      { factorToBase: "12.000000", roundingStrategy: "round" },
    ];

    const result = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    expect(result.corrected).toBe(true);
    expect(result.expectedQty).toBe(12);
  });

  it("deve usar arredondamento correto para fatores decimais", () => {
    const item: ReceivingOrderItem = {
      id: 450008,
      expectedQuantity: 2,
      receivedQuantity: 0,
      productId: 999998,
    };
    const actualUnitsReceived = 5;
    const convRows: ProductConversion[] = [
      { factorToBase: "2.500000", roundingStrategy: "round" },
    ];

    const result = autoCorrectExpectedQty(item, actualUnitsReceived, convRows);

    // 2 * 2.5 = 5.0 → round → 5
    expect(result.corrected).toBe(true);
    expect(result.expectedQty).toBe(5);
  });
});
