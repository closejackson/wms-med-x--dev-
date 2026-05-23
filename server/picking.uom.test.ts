/**
 * picking.uom.test.ts
 *
 * Testes unitários para a função resolvePickingFactor (Motor de Picking UOM-Aware).
 * Cobre os critérios de aceite definidos na Ação 2 do Plano de Mitigação de Riscos UOM.
 *
 * Critérios de aceite:
 *   [CA-1] O picking de um item em "Fardo" subtrai a quantidade correta de "Unidades" do inventário.
 *   [CA-2] O sistema não permite reservar stock se não houver fator de conversão válido.
 *   [CA-3] Logs de auditoria mostram o fator utilizado na conversão do pedido para a reserva.
 *   [CA-4] Frações inválidas são bloqueadas com mensagem de erro clara.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// ─── Controle de respostas do mock de banco ───────────────────────────────────
// Usamos uma fila de respostas para simular múltiplas chamadas sequenciais ao banco.
const dbResponseQueue: Array<any[]> = [];

function pushDbResponse(rows: any[]) {
  dbResponseQueue.push(rows);
}

function clearDbQueue() {
  dbResponseQueue.length = 0;
}

// ─── Mock do módulo de banco de dados ────────────────────────────────────────
vi.mock("../server/db", () => {
  const limitFn = vi.fn().mockImplementation(() => {
    return dbResponseQueue.shift() ?? [];
  });
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return {
    getDb: vi.fn().mockResolvedValue({ select: selectFn }),
  };
});

// ─── Importar a função após os mocks ─────────────────────────────────────────
import { resolvePickingFactor } from "./modules/picking";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Simula fator encontrado em productConversions */
function mockProductConversion(factorToBase: number, roundingStrategy = "round") {
  pushDbResponse([{ factorToBase, roundingStrategy }]);
}

/** Simula ausência em productConversions + fallback em products.unitsPerBox */
function mockFallbackUnitsPerBox(unitsPerBox: number) {
  pushDbResponse([]); // productConversions: sem resultado
  pushDbResponse([{ unitsPerBox }]); // products: com unitsPerBox
}

/** Simula ausência em ambas as fontes */
function mockNoConversion() {
  pushDbResponse([]); // productConversions: sem resultado
  pushDbResponse([{ unitsPerBox: null }]); // products: sem unitsPerBox
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("resolvePickingFactor — Motor de Picking UOM-Aware", () => {

  beforeEach(() => {
    clearDbQueue();
  });

  // ─── CA-1: Conversão correta para unidade base ───────────────────────────

  it("[CA-1] deve converter 2 CX para 24 UN quando fator = 12 (productConversions)", async () => {
    mockProductConversion(12);

    const result = await resolvePickingFactor(1, 101, 2, "box", "MED-001");

    expect(result.quantityInUnits).toBe(24);
    expect(result.factor).toBe(12);
    expect(result.source).toBe("productConversions");
    expect(result.unitCode).toBe("CX");
  });

  it("[CA-1] deve converter 1 FD (Fardo) para 30 UN quando fator = 30", async () => {
    mockProductConversion(30);

    const result = await resolvePickingFactor(1, 102, 1, "FD", "MED-002");

    expect(result.quantityInUnits).toBe(30);
    expect(result.factor).toBe(30);
    expect(result.source).toBe("productConversions");
    expect(result.unitCode).toBe("FD");
  });

  it("[CA-1] deve retornar passthrough (fator=1) para unidade base UN sem consultar banco", async () => {
    const result = await resolvePickingFactor(1, 103, 5, "unit", "MED-003");

    expect(result.quantityInUnits).toBe(5);
    expect(result.factor).toBe(1);
    expect(result.source).toBe("unit_passthrough");
  });

  it("[CA-1] deve usar fallback products.unitsPerBox quando productConversions não tem fator", async () => {
    mockFallbackUnitsPerBox(24);

    const result = await resolvePickingFactor(1, 104, 3, "box", "MED-004");

    expect(result.quantityInUnits).toBe(72); // 3 × 24
    expect(result.factor).toBe(24);
    expect(result.source).toBe("unitsPerBox_fallback");
  });

  // ─── CA-2: Bloqueio quando não há fator ─────────────────────────────────

  it("[CA-2] deve lançar TRPCError BAD_REQUEST quando não há fator de conversão cadastrado", async () => {
    mockNoConversion();

    await expect(
      resolvePickingFactor(1, 105, 2, "box", "MED-005")
    ).rejects.toThrow(/Erro de Convers/);
  });

  it("[CA-2] deve lançar TRPCError com código BAD_REQUEST", async () => {
    mockNoConversion();

    try {
      await resolvePickingFactor(1, 106, 1, "pallet", "MED-006");
      expect.fail("Deveria ter lançado erro");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe("BAD_REQUEST");
    }
  });

  // ─── CA-3: Log de auditoria ──────────────────────────────────────────────

  it("[CA-3] deve incluir log de auditoria com fator, produto e tenant", async () => {
    mockProductConversion(12);

    const result = await resolvePickingFactor(42, 101, 5, "box", "MED-007");

    expect(result.auditLog).toContain("produto=MED-007");
    expect(result.auditLog).toContain("fator=12");
    expect(result.auditLog).toContain("qtd_solicitada=5");
    expect(result.auditLog).toContain("qtd_base=60");
    expect(result.auditLog).toContain("tenant=42");
    expect(result.auditLog).toContain("fonte=productConversions");
  });

  it("[CA-3] log de auditoria do fallback deve indicar fonte unitsPerBox_fallback", async () => {
    mockFallbackUnitsPerBox(10);

    const result = await resolvePickingFactor(1, 108, 2, "box", "MED-008");

    expect(result.auditLog).toContain("fonte=unitsPerBox_fallback");
    expect(result.auditLog).toContain("qtd_base=20");
  });

  // ─── CA-4: Bloqueio de frações ───────────────────────────────────────────

  it("[CA-4] deve bloquear reserva quando resultado é fracionário (ex: 1.5 × 3 = 4.5 UN)", async () => {
    mockProductConversion(3);

    await expect(
      resolvePickingFactor(1, 109, 1.5, "box", "MED-009")
    ).rejects.toThrow(/fra.*o n.*o suportada/i);
  });

  it("[CA-4] deve aceitar resultado inteiro exato (sem fração)", async () => {
    mockProductConversion(12);

    const result = await resolvePickingFactor(1, 110, 3, "box", "MED-010");

    expect(result.quantityInUnits).toBe(36); // 3 × 12 = 36
  });

  it("[CA-4] deve bloquear fração com código BAD_REQUEST", async () => {
    mockProductConversion(7);

    try {
      await resolvePickingFactor(1, 111, 2, "box", "MED-011"); // 2 × 7 = 14 (OK)
      // Agora testar fração
    } catch {
      // não esperado aqui
    }

    mockProductConversion(7);
    try {
      await resolvePickingFactor(1, 111, 1.1, "box", "MED-011"); // 1.1 × 7 = 7.7 (FRAÇÃO)
      expect.fail("Deveria ter lançado erro");
    } catch (err: any) {
      expect(err).toBeInstanceOf(TRPCError);
      expect(err.code).toBe("BAD_REQUEST");
    }
  });

  // ─── Normalização de unidade ─────────────────────────────────────────────

  it("deve normalizar 'pallet' para 'PL' e buscar em productConversions", async () => {
    mockProductConversion(120);

    const result = await resolvePickingFactor(1, 112, 1, "pallet", "MED-012");

    expect(result.unitCode).toBe("PL");
    expect(result.quantityInUnits).toBe(120);
  });

  it("deve normalizar 'UN' (maiúsculo) como passthrough sem consultar banco", async () => {
    const result = await resolvePickingFactor(1, 113, 10, "UN", "MED-013");

    expect(result.source).toBe("unit_passthrough");
    expect(result.quantityInUnits).toBe(10);
  });
});
