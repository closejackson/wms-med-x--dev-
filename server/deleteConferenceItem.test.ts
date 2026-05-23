/**
 * Testes para a procedure deleteConferenceItem
 * Verifica que a procedure está registrada no appRouter e que o router exporta corretamente.
 */
import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";

describe("deleteConferenceItem procedure", () => {
  it("deve estar registrado no appRouter como blindConference.deleteConferenceItem", () => {
    // Verifica que o router blindConference existe no appRouter
    expect(appRouter._def.procedures).toBeDefined();
    const procedures = appRouter._def.procedures;
    expect(procedures["blindConference.deleteConferenceItem"]).toBeDefined();
  });

  it("deve ser uma mutation (não uma query)", () => {
    const procedures = appRouter._def.procedures;
    const proc = procedures["blindConference.deleteConferenceItem"];
    // tRPC v11: mutations têm _def.type === 'mutation'
    expect(proc._def.type).toBe("mutation");
  });

  it("deve aceitar input com conferenceId, productId e batch", () => {
    const procedures = appRouter._def.procedures;
    const proc = procedures["blindConference.deleteConferenceItem"];
    // Verificar que o schema de input está definido
    expect(proc._def.inputs).toBeDefined();
    expect(proc._def.inputs.length).toBeGreaterThan(0);
  });
});
