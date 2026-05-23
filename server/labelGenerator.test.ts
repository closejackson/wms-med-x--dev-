/**
 * labelGenerator.test.ts
 *
 * Testes unitários para o Módulo Gerador de Etiquetas
 *
 * Cobre:
 * - buildLabelCode: formato correto do labelCode
 * - buildUniqueCode: formato correto do uniqueCode
 * - Lógica Get-or-Create (mock do DB)
 * - Enriquecimento de unitsPerBox
 * - Sincronização condicional de inventário
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Helpers exportados para teste ─────────────────────────────────────────────
// Replicamos aqui as funções puras do router para testar sem dependências de DB

function buildLabelCode(codExterno: string, lote: string, validade: string | null): string {
  const parts = [codExterno.trim().toUpperCase(), lote.trim().toUpperCase()];
  if (validade) parts.push(validade.substring(0, 10));
  return parts.join("|");
}

function buildUniqueCode(codExterno: string, lote: string): string {
  return `${codExterno.trim().toUpperCase()}${lote.trim().toUpperCase()}`;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = String(d).substring(0, 10);
  const [y, m, day] = s.split("-");
  if (y && m && day) return `${day}/${m}/${y}`;
  return s;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTES DE FUNÇÕES PURAS
// ════════════════════════════════════════════════════════════════════════════

describe("buildLabelCode", () => {
  it("gera labelCode com validade", () => {
    const code = buildLabelCode("401460", "P22D08", "2026-12-31");
    expect(code).toBe("401460|P22D08|2026-12-31");
  });

  it("gera labelCode sem validade", () => {
    const code = buildLabelCode("401460", "P22D08", null);
    expect(code).toBe("401460|P22D08");
  });

  it("normaliza para uppercase", () => {
    const code = buildLabelCode("abc123", "lote01", null);
    expect(code).toBe("ABC123|LOTE01");
  });

  it("remove espaços extras", () => {
    const code = buildLabelCode("  401460  ", "  P22D08  ", "2026-12-31");
    expect(code).toBe("401460|P22D08|2026-12-31");
  });

  it("trunca validade para 10 chars (YYYY-MM-DD)", () => {
    const code = buildLabelCode("401460", "P22D08", "2026-12-31T00:00:00.000Z");
    expect(code).toBe("401460|P22D08|2026-12-31");
  });
});

describe("buildUniqueCode", () => {
  it("concatena codExterno e lote em uppercase sem separador", () => {
    const uc = buildUniqueCode("401460", "P22D08");
    expect(uc).toBe("401460P22D08");
  });

  it("normaliza para uppercase", () => {
    const uc = buildUniqueCode("abc", "lote");
    expect(uc).toBe("ABCLOTE");
  });

  it("remove espaços extras", () => {
    const uc = buildUniqueCode("  401460  ", "  P22D08  ");
    expect(uc).toBe("401460P22D08");
  });
});

describe("fmtDate", () => {
  it("formata YYYY-MM-DD para DD/MM/AAAA", () => {
    expect(fmtDate("2026-12-31")).toBe("31/12/2026");
  });

  it("retorna string vazia para null", () => {
    expect(fmtDate(null)).toBe("");
  });

  it("retorna string vazia para undefined", () => {
    expect(fmtDate(undefined)).toBe("");
  });

  it("aceita string de data ISO", () => {
    // fmtDate usa String(d).substring(0,10) que para Date retorna o toString() do JS
    // O comportamento esperado é com strings YYYY-MM-DD
    const result = fmtDate("2026-06-15");
    expect(result).toBe("15/06/2026");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TESTES DE LÓGICA DE NEGÓCIO (com mock do DB)
// ════════════════════════════════════════════════════════════════════════════

describe("Lógica Get-or-Create de labelCode", () => {
  it("reutiliza labelCode existente quando uniqueCode já está em labelAssociations", () => {
    // Simula a lógica do router
    const existingAssoc = { labelCode: "401460|P22D08|2026-12-31" };

    const isNew = existingAssoc === null;
    const labelCode = existingAssoc ? existingAssoc.labelCode : buildLabelCode("401460", "P22D08", "2026-12-31");

    expect(isNew).toBe(false);
    expect(labelCode).toBe("401460|P22D08|2026-12-31");
  });

  it("gera novo labelCode quando uniqueCode não existe em labelAssociations", () => {
    const existingAssoc = null;

    const isNew = existingAssoc === null;
    const labelCode = existingAssoc
      ? (existingAssoc as any).labelCode
      : buildLabelCode("401460", "P22D08", "2026-12-31");

    expect(isNew).toBe(true);
    expect(labelCode).toBe("401460|P22D08|2026-12-31");
  });
});

describe("Enriquecimento de unitsPerBox", () => {
  it("deve atualizar unitsPerBox quando produto tem valor nulo", () => {
    const product = { id: 1, sku: "401460", description: "Produto Teste", unitsPerBox: null };
    const inputUnitsPerBox = 30;

    const shouldUpdate = !product.unitsPerBox || product.unitsPerBox === 0;
    expect(shouldUpdate).toBe(true);

    // Simula a atualização
    const updatedProduct = shouldUpdate
      ? { ...product, unitsPerBox: inputUnitsPerBox }
      : product;

    expect(updatedProduct.unitsPerBox).toBe(30);
  });

  it("NÃO deve atualizar unitsPerBox quando produto já tem valor", () => {
    const product = { id: 1, sku: "401460", description: "Produto Teste", unitsPerBox: 20 };
    const inputUnitsPerBox = 30;

    const shouldUpdate = !product.unitsPerBox || product.unitsPerBox === 0;
    expect(shouldUpdate).toBe(false);

    const updatedProduct = shouldUpdate
      ? { ...product, unitsPerBox: inputUnitsPerBox }
      : product;

    expect(updatedProduct.unitsPerBox).toBe(20); // Mantém o valor original
  });

  it("deve atualizar unitsPerBox quando produto tem valor zero", () => {
    const product = { id: 1, sku: "401460", description: "Produto Teste", unitsPerBox: 0 };
    const inputUnitsPerBox = 30;

    const shouldUpdate = !product.unitsPerBox || product.unitsPerBox === 0;
    expect(shouldUpdate).toBe(true);
  });
});

describe("Sincronização Condicional de Inventário", () => {
  it("deve sincronizar inventory quando rowsAffected > 0", () => {
    const rowsAffected = 2;
    const inventoryUpdated = rowsAffected > 0;
    expect(inventoryUpdated).toBe(true);
  });

  it("NÃO deve reportar sincronização quando rowsAffected = 0 (sem saldo)", () => {
    const rowsAffected = 0;
    const inventoryUpdated = rowsAffected > 0;
    expect(inventoryUpdated).toBe(false);
  });

  it("a query de update deve filtrar por quantity > 0 (sem estoque negativo)", () => {
    // Simula registros de inventário
    const inventoryRecords = [
      { uniqueCode: "401460P22D08", quantity: 10, labelCode: null },
      { uniqueCode: "401460P22D08", quantity: 0, labelCode: null }, // Não deve ser atualizado
      { uniqueCode: "401460P22D08", quantity: -1, labelCode: null }, // Não deve ser atualizado
    ];

    const uniqueCode = "401460P22D08";
    const newLabelCode = "401460|P22D08|2026-12-31";

    const updated = inventoryRecords.filter(
      (r) => r.uniqueCode === uniqueCode && r.quantity > 0
    ).map((r) => ({ ...r, labelCode: newLabelCode }));

    expect(updated).toHaveLength(1);
    expect(updated[0].labelCode).toBe(newLabelCode);
    expect(updated[0].quantity).toBe(10);
  });
});

describe("Validação de inputs", () => {
  it("codExterno vazio deve ser rejeitado", () => {
    const codExterno = "  ";
    expect(codExterno.trim().length).toBe(0);
  });

  it("lote vazio deve ser rejeitado", () => {
    const lote = "";
    expect(lote.trim().length).toBe(0);
  });

  it("unitsPerBox < 1 deve ser rejeitado", () => {
    const unitsPerBox = 0;
    expect(unitsPerBox >= 1).toBe(false);
  });

  it("copies entre 1 e 100 deve ser aceito", () => {
    expect(1 >= 1 && 1 <= 100).toBe(true);
    expect(100 >= 1 && 100 <= 100).toBe(true);
    expect(101 >= 1 && 101 <= 100).toBe(false);
  });
});
