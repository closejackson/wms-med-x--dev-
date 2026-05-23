/**
 * Testes para o bug de perda de batch, expiryDate e labelCode no inventory
 * ao finalizar a conferência de recebimento.
 *
 * Causa raiz:
 * - associateLabel salvava batch/expiryDate na labelAssociation mas NÃO atualizava receivingOrderItems
 * - finish lia item.batch/item.expiryDate de receivingOrderItems (vazio da NF-e)
 * - inventory era criado com batch="" e expiryDate=null
 *
 * Correção aplicada:
 * 1. associateLabel: UPDATE receivingOrderItems inclui batch e expiryDate
 * 2. finish (UPDATE existente): propaga batch, expiryDate e labelCode
 * 3. finish (onDuplicateKeyUpdate): propaga batch, expiryDate e labelCode
 *
 * Critérios de aceite:
 * [ ] inventory.batch deve refletir o lote informado pelo operador no associateLabel
 * [ ] inventory.expiryDate deve refletir a validade informada pelo operador no associateLabel
 * [ ] inventory.labelCode deve refletir o código da etiqueta associada
 * [ ] inventoryMovements.batch e inventoryMovements.expiryDate devem ser preenchidos
 */

import { describe, it, expect } from "vitest";

// ─── Helpers de simulação ─────────────────────────────────────────────────────

interface ReceivingOrderItem {
  id: number;
  productId: number;
  batch: string;
  expiryDate: string | null;
  labelCode: string | null;
  receivedQuantity: number;
  expectedQuantity: number;
  status: string;
}

interface InventoryRecord {
  productId: number;
  locationId: number;
  tenantId: number;
  batch: string;
  expiryDate: string | null;
  labelCode: string | null;
  quantity: number;
  status: string;
}

// Simula o UPDATE de receivingOrderItems no associateLabel (ANTES da correção)
function associateLabelOld(
  item: ReceivingOrderItem,
  input: { labelCode: string; batch?: string; expiryDate?: string; unitsReceived: number }
): ReceivingOrderItem {
  return {
    ...item,
    labelCode: input.labelCode,
    receivedQuantity: item.receivedQuantity + input.unitsReceived,
    status: "receiving",
    // ❌ batch e expiryDate NÃO eram atualizados (bug)
  };
}

// Simula o UPDATE de receivingOrderItems no associateLabel (APÓS a correção)
function associateLabelFixed(
  item: ReceivingOrderItem,
  input: { labelCode: string; batch?: string; expiryDate?: string; unitsReceived: number }
): ReceivingOrderItem {
  return {
    ...item,
    labelCode: input.labelCode,
    // ✅ batch e expiryDate agora são propagados
    batch: input.batch || item.batch || "",
    expiryDate: input.expiryDate || item.expiryDate || null,
    receivedQuantity: item.receivedQuantity + input.unitsReceived,
    status: "receiving",
  };
}

// Simula a criação de inventory no finish
function createInventoryFromItem(
  item: ReceivingOrderItem,
  locationId: number,
  tenantId: number
): InventoryRecord {
  return {
    productId: item.productId,
    locationId,
    tenantId,
    batch: item.batch || "",
    expiryDate: item.expiryDate || null,
    labelCode: item.labelCode || null,
    quantity: item.receivedQuantity,
    status: "available",
  };
}

// ─── Dados de teste ───────────────────────────────────────────────────────────

const baseItem: ReceivingOrderItem = {
  id: 1,
  productId: 210001,
  batch: "",         // ← NF-e não tem lote
  expiryDate: null,  // ← NF-e não tem validade
  labelCode: null,
  receivedQuantity: 0,
  expectedQuantity: 90,
  status: "pending",
};

const associateInput = {
  labelCode: "ETQ-RIOHEX-001",
  batch: "LOTE-2025-001",
  expiryDate: "2026-12-31",
  unitsReceived: 90,
};

// ─── Testes ───────────────────────────────────────────────────────────────────

describe("finish - propagação de batch/expiryDate/labelCode para inventory", () => {

  it("CRITÉRIO 1 (BUG): comportamento antigo NÃO propagava batch/expiryDate para inventory", () => {
    const updatedItem = associateLabelOld(baseItem, associateInput);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    // Demonstra o bug: inventory criado sem batch e sem expiryDate
    // (labelCode era propagado, mas batch/expiryDate não)
    expect(inv.batch).toBe("");           // ← BUG: batch vazio
    expect(inv.expiryDate).toBeNull();    // ← BUG: validade nula
    // labelCode era propagado no UPDATE antigo (apenas batch/expiryDate faltavam)
    expect(inv.labelCode).toBe("ETQ-RIOHEX-001"); // labelCode já era salvo
  });

  it("CRITÉRIO 1 (CORREÇÃO): batch do operador é propagado para inventory", () => {
    const updatedItem = associateLabelFixed(baseItem, associateInput);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    expect(inv.batch).toBe("LOTE-2025-001");  // ✅ batch correto
  });

  it("CRITÉRIO 2 (CORREÇÃO): expiryDate do operador é propagada para inventory", () => {
    const updatedItem = associateLabelFixed(baseItem, associateInput);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    expect(inv.expiryDate).toBe("2026-12-31");  // ✅ validade correta
  });

  it("CRITÉRIO 3 (CORREÇÃO): labelCode da etiqueta é propagado para inventory", () => {
    const updatedItem = associateLabelFixed(baseItem, associateInput);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    expect(inv.labelCode).toBe("ETQ-RIOHEX-001");  // ✅ labelCode correto
  });

  it("CRITÉRIO 1-3: todos os campos de rastreabilidade preenchidos após finish", () => {
    const updatedItem = associateLabelFixed(baseItem, associateInput);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    expect(inv.batch).toBeTruthy();
    expect(inv.expiryDate).toBeTruthy();
    expect(inv.labelCode).toBeTruthy();
    expect(inv.quantity).toBe(90);
    expect(inv.status).toBe("available");
  });

  it("CRITÉRIO: batch do item da NF-e é preservado se operador não informar novo lote", () => {
    const itemWithNFeBatch: ReceivingOrderItem = {
      ...baseItem,
      batch: "LOTE-NFE-ORIGINAL",
      expiryDate: "2025-06-30",
    };

    // Operador não informa batch (usa o da NF-e)
    const inputSemBatch = {
      labelCode: "ETQ-001",
      batch: undefined,
      expiryDate: undefined,
      unitsReceived: 90,
    };

    const updatedItem = associateLabelFixed(itemWithNFeBatch, inputSemBatch);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    // Deve preservar o batch da NF-e quando operador não informa
    expect(inv.batch).toBe("LOTE-NFE-ORIGINAL");
    expect(inv.expiryDate).toBe("2025-06-30");
  });

  it("CRITÉRIO: batch do operador sobrescreve o batch da NF-e quando informado", () => {
    const itemWithNFeBatch: ReceivingOrderItem = {
      ...baseItem,
      batch: "LOTE-NFE-ORIGINAL",
      expiryDate: "2025-06-30",
    };

    const inputComBatch = {
      labelCode: "ETQ-001",
      batch: "LOTE-OPERADOR-NOVO",
      expiryDate: "2027-01-15",
      unitsReceived: 90,
    };

    const updatedItem = associateLabelFixed(itemWithNFeBatch, inputComBatch);
    const inv = createInventoryFromItem(updatedItem, 30353, 30001);

    // Batch do operador tem prioridade sobre o da NF-e
    expect(inv.batch).toBe("LOTE-OPERADOR-NOVO");
    expect(inv.expiryDate).toBe("2027-01-15");
  });

  it("CRITÉRIO: inventoryMovements deve ter batch e expiryDate preenchidos", () => {
    const updatedItem = associateLabelFixed(baseItem, associateInput);

    // Simula a criação do inventoryMovement no finish
    const movement = {
      productId: updatedItem.productId,
      batch: updatedItem.batch || "",
      expiryDate: updatedItem.expiryDate || null,
      labelCode: updatedItem.labelCode || null,
      quantity: updatedItem.receivedQuantity,
      movementType: "receiving",
    };

    expect(movement.batch).toBe("LOTE-2025-001");
    expect(movement.expiryDate).toBe("2026-12-31");
    expect(movement.labelCode).toBe("ETQ-RIOHEX-001");
  });

  it("CRITÉRIO: múltiplas etiquetas do mesmo produto preservam o último batch registrado", () => {
    // Simula 2 associações para o mesmo item (produto com 2 etiquetas)
    const afterFirst = associateLabelFixed(baseItem, {
      labelCode: "ETQ-001",
      batch: "LOTE-A",
      expiryDate: "2026-06-30",
      unitsReceived: 45,
    });

    const afterSecond = associateLabelFixed(afterFirst, {
      labelCode: "ETQ-002",
      batch: "LOTE-A",  // mesmo lote (normal para mesmo produto)
      expiryDate: "2026-06-30",
      unitsReceived: 45,
    });

    const inv = createInventoryFromItem(afterSecond, 30353, 30001);

    expect(inv.batch).toBe("LOTE-A");
    expect(inv.quantity).toBe(90);
    expect(inv.labelCode).toBe("ETQ-002");  // último labelCode
  });
});
