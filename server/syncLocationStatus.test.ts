/**
 * Testes para syncLocationStatus e getLocationStatusSummary
 * Verifica que as procedures estão exportadas e registradas corretamente.
 */

import { describe, it, expect } from "vitest";

describe("maintenanceRouter - syncLocationStatus", () => {
  it("deve exportar o maintenanceRouter corretamente", async () => {
    const { maintenanceRouter } = await import("./maintenanceRouter");
    expect(maintenanceRouter).toBeDefined();
    expect(typeof maintenanceRouter).toBe("object");
  });

  it("deve ter a procedure syncLocationStatus registrada", async () => {
    const { maintenanceRouter } = await import("./maintenanceRouter");
    // Verifica que o router tem a procedure definida
    const routerDef = maintenanceRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    expect(routerDef._def).toBeDefined();
    expect(routerDef._def.procedures).toBeDefined();
    expect(routerDef._def.procedures["syncLocationStatus"]).toBeDefined();
  });

  it("deve ter a procedure getLocationStatusSummary registrada", async () => {
    const { maintenanceRouter } = await import("./maintenanceRouter");
    const routerDef = maintenanceRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    expect(routerDef._def.procedures["getLocationStatusSummary"]).toBeDefined();
  });

  it("deve estar registrado no appRouter como maintenance", async () => {
    const { appRouter } = await import("./routers");
    const routerDef = appRouter as unknown as { _def: { procedures: Record<string, unknown> } };
    const maintenanceKeys = Object.keys(routerDef._def.procedures).filter(k => k.startsWith("maintenance."));
    expect(maintenanceKeys).toContain("maintenance.syncLocationStatus");
    expect(maintenanceKeys).toContain("maintenance.getLocationStatusSummary");
  });
});
