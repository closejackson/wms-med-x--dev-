/**
 * portalExportRouter.ts
 *
 * Procedures de exportação (PDF e XLSX) para o Portal do Cliente.
 * Cada procedure:
 *  1. Valida a sessão do portal (getPortalSession)
 *  2. Busca os dados do tenant (isolamento multi-tenant)
 *  3. Gera o arquivo em memória
 *  4. Retorna base64 para download no frontend
 *
 * Módulos cobertos:
 *  - exportStock       → Estoque (/portal/estoque)
 *  - exportOrders      → Pedidos (/portal/pedidos)
 *  - exportReceivings  → Recebimentos (/portal/recebimentos)
 *  - exportMovements   → Movimentações (/portal/movimentacoes)
 *  - exportIntraHosp   → Performance Intra-Hospitalar (/portal/intra-hospitalar)
 */

import { router, publicProcedure, TRPCError } from "./_core/trpc";
import { z } from "zod";
import { getDb } from "./db";
import {
  systemUsers,
  tenants,
  clientPortalSessions,
  inventory,
  products,
  warehouseLocations,
  warehouseZones,
  pickingOrders,
  receivingOrders,
  inventoryMovements,
} from "../drizzle/schema";
import { eq, and, desc, gte, lte, sql, gt, like, or } from "drizzle-orm";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { toMySQLDate } from "../shared/utils";

// ─── Helpers de sessão ────────────────────────────────────────────────────────
const PORTAL_SESSION_COOKIE = "client_portal_session";

async function getPortalSession(req: any) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

  const cookieHeader = req.headers?.cookie ?? "";
  const cookieToken = cookieHeader
    .split(";")
    .map((c: string) => c.trim())
    .find((c: string) => c.startsWith(`${PORTAL_SESSION_COOKIE}=`))
    ?.split("=")[1];
  const authHeader = req.headers?.authorization ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token = cookieToken || bearerToken;

  if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sessão do portal inválida ou expirada." });

  const sessions = await db
    .select({ id: clientPortalSessions.id, tenantId: clientPortalSessions.tenantId, systemUserId: clientPortalSessions.systemUserId, expiresAt: clientPortalSessions.expiresAt })
    .from(clientPortalSessions)
    .where(eq(clientPortalSessions.token, token))
    .limit(1);
  const session = sessions[0];
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sessão não encontrada." });
  if (session.expiresAt < new Date()) {
    await db.delete(clientPortalSessions).where(eq(clientPortalSessions.id, session.id));
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sessão expirada." });
  }
  return { systemUserId: session.systemUserId, tenantId: session.tenantId };
}

async function getTenantInfo(tenantId: number): Promise<{ name: string; logoUrl: string | null }> {
  const db = await getDb();
  if (!db) return { name: "Cliente", logoUrl: null };
  const rows = await db.select({ name: tenants.name, tradeName: tenants.tradeName, logoUrl: tenants.logoUrl }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const t = rows[0];
  return { name: t ? (t.tradeName ?? t.name) : "Cliente", logoUrl: t?.logoUrl ?? null };
}
async function getTenantName(tenantId: number): Promise<string> {
  return (await getTenantInfo(tenantId)).name;
}

// ─── Helpers de geração ───────────────────────────────────────────────────────

/** Gera cabeçalho padrão do PDF (com logo opcional do cliente) */
async function buildPdfHeader(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
  tenantName: string,
  subtitle?: string,
  logoUrl?: string | null
) {
  // Faixa azul no topo
  doc.rect(0, 0, doc.page.width, 60).fill("#1e40af");
  doc.fillColor("white").fontSize(16).font("Helvetica-Bold").text("Med@x WMS", 40, 14);
  doc.fontSize(10).font("Helvetica").text("Portal do Cliente", 40, 34);
  // Logo do cliente (canto direito do cabeçalho)
  if (logoUrl) {
    try {
      const response = await fetch(logoUrl);
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        // pdfkit não suporta SVG
        if (!contentType.includes("svg")) {
          const logoBuffer = Buffer.from(await response.arrayBuffer());
          doc.image(logoBuffer, doc.page.width - 100, 8, { fit: [80, 44], align: "right" });
        }
      }
    } catch {
      // Ignorar erro de logo — não bloquear geração do PDF
    }
  }
  // Título do relatório
  doc.fillColor("#1e293b").fontSize(14).font("Helvetica-Bold").text(title, 40, 80);
  doc.fontSize(9).font("Helvetica").fillColor("#64748b").text(tenantName, 40, 100);
  if (subtitle) doc.text(subtitle, 40, 114);
  doc.moveDown(2);
  // Linha separadora
  doc.moveTo(40, 130).lineTo(doc.page.width - 40, 130).strokeColor("#e2e8f0").lineWidth(1).stroke();
  doc.y = 145;
}

/** Adiciona rodapé com data de geração */
function buildPdfFooter(doc: InstanceType<typeof PDFDocument>) {
  const pageCount = (doc as any).bufferedPageRange?.()?.count ?? 1;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor("#94a3b8").font("Helvetica")
      .text(
        `Gerado em ${new Date().toLocaleString("pt-BR")} · Med@x WMS`,
        40,
        doc.page.height - 30,
        { align: "center", width: doc.page.width - 80 }
      );
  }
}

/** Converte buffer do PDF para base64 */
async function pdfToBase64(doc: InstanceType<typeof PDFDocument>): Promise<string> {
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  doc.end();
  return new Promise((resolve) => {
    doc.on("end", () => resolve(`data:application/pdf;base64,${Buffer.concat(chunks).toString("base64")}`));
  });
}

/** Converte workbook ExcelJS para base64 */
async function xlsxToBase64(wb: ExcelJS.Workbook): Promise<string> {
  const buffer = await wb.xlsx.writeBuffer();
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from(buffer).toString("base64")}`;
}

/** Estilo padrão de cabeçalho de coluna no Excel */
function styleHeader(ws: ExcelJS.Worksheet, row: number, cols: number) {
  const headerRow = ws.getRow(row);
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber <= cols) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
    }
  });
  headerRow.height = 22;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const portalExportRouter = router({

  // ══════════════════════════════════════════════════════════════════════════
  // ESTOQUE
  // ══════════════════════════════════════════════════════════════════════════
  exportStock: publicProcedure
    .input(z.object({
      format: z.enum(["pdf", "xlsx"]),
      search: z.string().optional(),
      status: z.enum(["available", "quarantine", "blocked", "expired"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = await getPortalSession(ctx.req);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { name: tenantName, logoUrl: tenantLogoUrl } = await getTenantInfo(tenantId);
      const conditions: any[] = [eq(inventory.tenantId, tenantId), gt(inventory.quantity, 0)];
      if (input.status) conditions.push(eq(inventory.status, input.status));
      if (input.search) conditions.push(or(like(products.sku, `%${input.search}%`), like(products.description, `%${input.search}%`))!);

      const rows = await db
        .select({
          sku: products.sku,
          description: products.description,
          batch: inventory.batch,
          expiryDate: inventory.expiryDate,
          quantity: inventory.quantity,
          reservedQuantity: inventory.reservedQuantity,
          status: inventory.status,
          locationCode: warehouseLocations.code,
          zoneName: warehouseZones.name,
          unitOfMeasure: products.unitOfMeasure,
        })
        .from(inventory)
        .innerJoin(products, eq(inventory.productId, products.id))
        .innerJoin(warehouseLocations, eq(inventory.locationId, warehouseLocations.id))
        .innerJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id))
        .where(and(...conditions))
        .orderBy(products.description)
        .limit(5000);

      const statusLabel: Record<string, string> = {
        available: "Disponível", quarantine: "Quarentena", blocked: "Bloqueado", expired: "Vencido",
      };

      if (input.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "Med@x WMS";
        const ws = wb.addWorksheet("Estoque");
        ws.columns = [
          { header: "SKU", key: "sku", width: 18 },
          { header: "Descrição", key: "description", width: 40 },
          { header: "Lote", key: "batch", width: 18 },
          { header: "Validade", key: "expiryDate", width: 14 },
          { header: "Qtd. Total", key: "quantity", width: 12 },
          { header: "Qtd. Reservada", key: "reserved", width: 16 },
          { header: "Qtd. Disponível", key: "available", width: 16 },
          { header: "Status", key: "status", width: 14 },
          { header: "Endereço", key: "location", width: 16 },
          { header: "Zona", key: "zone", width: 16 },
          { header: "UN", key: "unit", width: 8 },
        ];
        styleHeader(ws, 1, ws.columns.length);
        rows.forEach((r) => {
          ws.addRow({
            sku: r.sku,
            description: r.description,
            batch: r.batch ?? "",
            expiryDate: r.expiryDate ? toMySQLDate(r.expiryDate as any) : "",
            quantity: r.quantity,
            reserved: r.reservedQuantity ?? 0,
            available: r.quantity - (r.reservedQuantity ?? 0),
            status: statusLabel[r.status ?? ""] ?? r.status,
            location: r.locationCode,
            zone: r.zoneName,
            unit: r.unitOfMeasure ?? "",
          });
        });
        ws.autoFilter = { from: "A1", to: `K1` };
        return { base64: await xlsxToBase64(wb), filename: `estoque-${tenantName}-${Date.now()}.xlsx` };
      }

      // PDF
      const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true });
      await buildPdfHeader(doc, "Relatório de Estoque", tenantName, `Total de itens: ${rows.length}`, tenantLogoUrl);

      // Tabela
      const colWidths = [70, 160, 70, 60, 50, 55, 55];
      const headers = ["SKU", "Descrição", "Lote", "Validade", "Qtd.", "Reservado", "Status"];
      const startX = 40;
      let y = doc.y;

      // Cabeçalho da tabela
      doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
      doc.rect(startX, y, doc.page.width - 80, 18).fill("#1e40af");
      let x = startX + 4;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 5, { width: colWidths[i] - 4, align: "left" });
        x += colWidths[i];
      });
      y += 18;

      doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
      rows.forEach((r, idx) => {
        if (y > doc.page.height - 60) {
          doc.addPage();
          y = 40;
        }
        const rowBg = idx % 2 === 0 ? "#f8fafc" : "#ffffff";
        doc.rect(startX, y, doc.page.width - 80, 16).fill(rowBg);
        doc.fillColor("#1e293b");
        x = startX + 4;
        const cells = [
          r.sku,
          r.description.length > 28 ? r.description.slice(0, 26) + "…" : r.description,
          r.batch ?? "—",
          r.expiryDate ? toMySQLDate(r.expiryDate as any) ?? "—" : "—",
          String(r.quantity),
          String(r.reservedQuantity ?? 0),
          statusLabel[r.status ?? ""] ?? (r.status ?? "—"),
        ];
        cells.forEach((cell, i) => {
          doc.text(cell, x, y + 4, { width: colWidths[i] - 4, align: "left" });
          x += colWidths[i];
        });
        y += 16;
      });

      buildPdfFooter(doc);
      return { base64: await pdfToBase64(doc), filename: `estoque-${tenantName}-${Date.now()}.pdf` };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // PEDIDOS
  // ══════════════════════════════════════════════════════════════════════════
  exportOrders: publicProcedure
    .input(z.object({
      format: z.enum(["pdf", "xlsx"]),
      status: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = await getPortalSession(ctx.req);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { name: tenantName, logoUrl: tenantLogoUrl } = await getTenantInfo(tenantId);
      const conditions2: any[] = [eq(pickingOrders.tenantId, tenantId)];
      if (input.status) conditions2.push(eq(pickingOrders.status, input.status as any));
      if (input.dateFrom) conditions2.push(gte(pickingOrders.createdAt, new Date(input.dateFrom)));
      if (input.dateTo) conditions2.push(lte(pickingOrders.createdAt, new Date(input.dateTo)));

      const orders = await db
        .select({
          orderNumber: pickingOrders.orderNumber,
          customerOrderNumber: pickingOrders.customerOrderNumber,
          status: pickingOrders.status,
          priority: pickingOrders.priority,
          totalItems: pickingOrders.totalItems,
          totalQuantity: pickingOrders.totalQuantity,
          scheduledDate: pickingOrders.scheduledDate,
          shippedAt: pickingOrders.shippedAt,
          nfeNumber: pickingOrders.nfeNumber,
          createdAt: pickingOrders.createdAt,
        })
        .from(pickingOrders)
        .where(and(...conditions2))
        .orderBy(desc(pickingOrders.createdAt))
        .limit(5000);

      const statusLabel: Record<string, string> = {
        pending: "Pendente", validated: "Validado", in_wave: "Em Onda", picking: "Separando",
        picked: "Separado", checking: "Conferindo", packed: "Embalado", staged: "Em Stage",
        invoiced: "Faturado", shipped: "Expedido", cancelled: "Cancelado",
      };

      const fmt = (d: Date | null | undefined) => d ? new Date(d).toLocaleDateString("pt-BR") : "—";

      if (input.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "Med@x WMS";
        const ws = wb.addWorksheet("Pedidos");
        ws.columns = [
          { header: "Nº Pedido", key: "orderNumber", width: 16 },
          { header: "Nº Cliente", key: "customerOrderNumber", width: 18 },
          { header: "Status", key: "status", width: 14 },
          { header: "Prioridade", key: "priority", width: 12 },
          { header: "Itens", key: "totalItems", width: 8 },
          { header: "Qtd. Total", key: "totalQuantity", width: 12 },
          { header: "Data Agendada", key: "scheduledDate", width: 16 },
          { header: "Data Expedição", key: "shippedAt", width: 16 },
          { header: "NF-e", key: "nfeNumber", width: 16 },
          { header: "Criado em", key: "createdAt", width: 16 },
        ];
        styleHeader(ws, 1, ws.columns.length);
        orders.forEach((o) => {
          ws.addRow({
            orderNumber: o.orderNumber,
            customerOrderNumber: o.customerOrderNumber ?? "",
            status: statusLabel[o.status ?? ""] ?? o.status,
            priority: o.priority ?? "",
            totalItems: o.totalItems ?? 0,
            totalQuantity: o.totalQuantity ?? 0,
            scheduledDate: fmt(o.scheduledDate),
            shippedAt: fmt(o.shippedAt),
            nfeNumber: o.nfeNumber ?? "",
            createdAt: fmt(o.createdAt),
          });
        });
        ws.autoFilter = { from: "A1", to: "J1" };
        return { base64: await xlsxToBase64(wb), filename: `pedidos-${tenantName}-${Date.now()}.xlsx` };
      }

      // PDF
      const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true });
      const subtitle = input.dateFrom && input.dateTo
        ? `Período: ${fmt(new Date(input.dateFrom))} a ${fmt(new Date(input.dateTo))} · Total: ${orders.length} pedidos`
        : `Total: ${orders.length} pedidos`;
      await buildPdfHeader(doc, "Relatório de Pedidos", tenantName, subtitle, tenantLogoUrl);

      const colWidths = [70, 80, 65, 55, 55, 55, 65, 65];
      const headers = ["Nº Pedido", "Nº Cliente", "Status", "Prioridade", "Itens", "Qtd.", "Agendado", "Expedido"];
      const startX = 40;
      let y = doc.y;

      doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
      doc.rect(startX, y, doc.page.width - 80, 18).fill("#1e40af");
      let x = startX + 4;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 5, { width: colWidths[i] - 4 });
        x += colWidths[i];
      });
      y += 18;

      doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
      orders.forEach((o, idx) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        doc.rect(startX, y, doc.page.width - 80, 16).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
        doc.fillColor("#1e293b");
        x = startX + 4;
        [
          o.orderNumber ?? "—",
          o.customerOrderNumber ?? "—",
          statusLabel[o.status ?? ""] ?? (o.status ?? "—"),
          o.priority ?? "—",
          String(o.totalItems ?? 0),
          String(o.totalQuantity ?? 0),
          fmt(o.scheduledDate),
          fmt(o.shippedAt),
        ].forEach((cell, i) => {
          doc.text(cell, x, y + 4, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += 16;
      });

      buildPdfFooter(doc);
      return { base64: await pdfToBase64(doc), filename: `pedidos-${tenantName}-${Date.now()}.pdf` };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // RECEBIMENTOS
  // ══════════════════════════════════════════════════════════════════════════
  exportReceivings: publicProcedure
    .input(z.object({
      format: z.enum(["pdf", "xlsx"]),
      status: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = await getPortalSession(ctx.req);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { name: tenantName, logoUrl: tenantLogoUrl } = await getTenantInfo(tenantId);
      const conditions3: any[] = [eq(receivingOrders.tenantId, tenantId)];
      if (input.status) conditions3.push(eq(receivingOrders.status, input.status as any));
      if (input.dateFrom) conditions3.push(gte(receivingOrders.createdAt, new Date(input.dateFrom)));
      if (input.dateTo) conditions3.push(lte(receivingOrders.createdAt, new Date(input.dateTo)));

      const rows = await db
        .select({
          orderNumber: receivingOrders.orderNumber,
          nfeNumber: receivingOrders.nfeNumber,
          supplierName: receivingOrders.supplierName,
          supplierCnpj: receivingOrders.supplierCnpj,
          status: receivingOrders.status,
          scheduledDate: receivingOrders.scheduledDate,
          receivedDate: receivingOrders.receivedDate,
          createdAt: receivingOrders.createdAt,
        })
        .from(receivingOrders)
        .where(and(...conditions3))
        .orderBy(desc(receivingOrders.createdAt))
        .limit(5000);

      const statusLabel: Record<string, string> = {
        scheduled: "Agendado", in_progress: "Em Progresso", in_quarantine: "Quarentena",
        addressing: "Endereçando", completed: "Concluído", cancelled: "Cancelado",
      };
      const fmt = (d: Date | null | undefined) => d ? new Date(d).toLocaleDateString("pt-BR") : "—";

      if (input.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "Med@x WMS";
        const ws = wb.addWorksheet("Recebimentos");
        ws.columns = [
          { header: "Nº Recebimento", key: "orderNumber", width: 18 },
          { header: "NF-e", key: "nfeNumber", width: 18 },
          { header: "Fornecedor", key: "supplierName", width: 35 },
          { header: "CNPJ Fornecedor", key: "supplierCnpj", width: 20 },
          { header: "Status", key: "status", width: 16 },
          { header: "Data Agendada", key: "scheduledDate", width: 16 },
          { header: "Data Recebimento", key: "receivedDate", width: 18 },
          { header: "Criado em", key: "createdAt", width: 16 },
        ];
        styleHeader(ws, 1, ws.columns.length);
        rows.forEach((r) => {
          ws.addRow({
            orderNumber: r.orderNumber,
            nfeNumber: r.nfeNumber ?? "",
            supplierName: r.supplierName ?? "",
            supplierCnpj: r.supplierCnpj ?? "",
            status: statusLabel[r.status ?? ""] ?? r.status,
            scheduledDate: fmt(r.scheduledDate),
            receivedDate: fmt(r.receivedDate),
            createdAt: fmt(r.createdAt),
          });
        });
        ws.autoFilter = { from: "A1", to: "H1" };
        return { base64: await xlsxToBase64(wb), filename: `recebimentos-${tenantName}-${Date.now()}.xlsx` };
      }

      // PDF
      const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true });
      await buildPdfHeader(doc, "Relatório de Recebimentos", tenantName, `Total: ${rows.length} recebimentos`, tenantLogoUrl);

      const colWidths = [90, 80, 130, 70, 80, 80];
      const headers = ["Nº Recebimento", "NF-e", "Fornecedor", "Status", "Agendado", "Recebido"];
      const startX = 40;
      let y = doc.y;

      doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
      doc.rect(startX, y, doc.page.width - 80, 18).fill("#1e40af");
      let x = startX + 4;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 5, { width: colWidths[i] - 4 });
        x += colWidths[i];
      });
      y += 18;

      doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
      rows.forEach((r, idx) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        doc.rect(startX, y, doc.page.width - 80, 16).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
        doc.fillColor("#1e293b");
        x = startX + 4;
        [
          r.orderNumber ?? "—",
          r.nfeNumber ?? "—",
          (r.supplierName ?? "—").length > 22 ? (r.supplierName ?? "").slice(0, 20) + "…" : (r.supplierName ?? "—"),
          statusLabel[r.status ?? ""] ?? (r.status ?? "—"),
          fmt(r.scheduledDate),
          fmt(r.receivedDate),
        ].forEach((cell, i) => {
          doc.text(cell, x, y + 4, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += 16;
      });

      buildPdfFooter(doc);
      return { base64: await pdfToBase64(doc), filename: `recebimentos-${tenantName}-${Date.now()}.pdf` };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // MOVIMENTAÇÕES
  // ══════════════════════════════════════════════════════════════════════════
  exportMovements: publicProcedure
    .input(z.object({
      format: z.enum(["pdf", "xlsx"]),
      movementType: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = await getPortalSession(ctx.req);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { name: tenantName, logoUrl: tenantLogoUrl } = await getTenantInfo(tenantId);
      const conditions4: any[] = [eq(inventoryMovements.tenantId, tenantId)];
      if (input.movementType) conditions4.push(eq(inventoryMovements.movementType, input.movementType as any));
      if (input.dateFrom) conditions4.push(gte(inventoryMovements.createdAt, new Date(input.dateFrom)));
      if (input.dateTo) conditions4.push(lte(inventoryMovements.createdAt, new Date(input.dateTo)));

      const rows = await db
        .select({
          sku: products.sku,
          description: products.description,
          batch: inventoryMovements.batch,
          expiryDate: inventoryMovements.expiryDate,
          movementType: inventoryMovements.movementType,
          quantity: inventoryMovements.quantity,
          referenceType: inventoryMovements.referenceType,
          referenceId: inventoryMovements.referenceId,
          notes: inventoryMovements.notes,
          createdAt: inventoryMovements.createdAt,
        })
        .from(inventoryMovements)
        .innerJoin(products, eq(inventoryMovements.productId, products.id))
        .where(and(...conditions4))
        .orderBy(desc(inventoryMovements.createdAt))
        .limit(5000);

      const typeLabel: Record<string, string> = {
        receiving: "Recebimento", put_away: "Endereçamento", picking: "Picking",
        transfer: "Transferência", adjustment: "Ajuste", return: "Devolução",
        disposal: "Descarte", quality: "Qualidade",
      };
      const fmt = (d: Date | null | undefined) => d ? new Date(d).toLocaleDateString("pt-BR") : "—";
      const fmtDt = (d: Date | null | undefined) => d ? new Date(d).toLocaleString("pt-BR") : "—";

      if (input.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "Med@x WMS";
        const ws = wb.addWorksheet("Movimentações");
        ws.columns = [
          { header: "SKU", key: "sku", width: 18 },
          { header: "Descrição", key: "description", width: 40 },
          { header: "Lote", key: "batch", width: 16 },
          { header: "Validade", key: "expiryDate", width: 14 },
          { header: "Tipo", key: "movementType", width: 16 },
          { header: "Quantidade", key: "quantity", width: 12 },
          { header: "Ref. Tipo", key: "referenceType", width: 14 },
          { header: "Ref. ID", key: "referenceId", width: 10 },
          { header: "Observações", key: "notes", width: 30 },
          { header: "Data/Hora", key: "createdAt", width: 20 },
        ];
        styleHeader(ws, 1, ws.columns.length);
        rows.forEach((r) => {
          ws.addRow({
            sku: r.sku,
            description: r.description,
            batch: r.batch ?? "",
            expiryDate: r.expiryDate ? toMySQLDate(r.expiryDate as any) ?? "" : "",
            movementType: typeLabel[r.movementType ?? ""] ?? r.movementType,
            quantity: r.quantity,
            referenceType: r.referenceType ?? "",
            referenceId: r.referenceId ?? "",
            notes: r.notes ?? "",
            createdAt: fmtDt(r.createdAt),
          });
        });
        ws.autoFilter = { from: "A1", to: "J1" };
        return { base64: await xlsxToBase64(wb), filename: `movimentacoes-${tenantName}-${Date.now()}.xlsx` };
      }

      // PDF
      const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true });
      await buildPdfHeader(doc, "Relatório de Movimentações", tenantName, `Total: ${rows.length} movimentações`, tenantLogoUrl);

      const colWidths = [65, 155, 65, 60, 55, 55, 60];
      const headers = ["SKU", "Descrição", "Lote", "Tipo", "Qtd.", "Validade", "Data"];
      const startX = 40;
      let y = doc.y;

      doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
      doc.rect(startX, y, doc.page.width - 80, 18).fill("#1e40af");
      let x = startX + 4;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 5, { width: colWidths[i] - 4 });
        x += colWidths[i];
      });
      y += 18;

      doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
      rows.forEach((r, idx) => {
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
        doc.rect(startX, y, doc.page.width - 80, 16).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
        doc.fillColor("#1e293b");
        x = startX + 4;
        [
          r.sku,
          r.description.length > 26 ? r.description.slice(0, 24) + "…" : r.description,
          r.batch ?? "—",
          typeLabel[r.movementType ?? ""] ?? (r.movementType ?? "—"),
          String(r.quantity),
          r.expiryDate ? toMySQLDate(r.expiryDate as any) ?? "—" : "—",
          fmt(r.createdAt),
        ].forEach((cell, i) => {
          doc.text(cell, x, y + 4, { width: colWidths[i] - 4 });
          x += colWidths[i];
        });
        y += 16;
      });

      buildPdfFooter(doc);
      return { base64: await pdfToBase64(doc), filename: `movimentacoes-${tenantName}-${Date.now()}.pdf` };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // PERFORMANCE INTRA-HOSPITALAR
  // ══════════════════════════════════════════════════════════════════════════
  exportIntraHosp: publicProcedure
    .input(z.object({
      format: z.enum(["pdf", "xlsx"]),
      slaMinutes: z.number().min(1).max(1440).default(120),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = await getPortalSession(ctx.req);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verificar permissão intra-hospitalar
      const tenantRows = await db
        .select({ intraHospitalEnabled: tenants.intraHospitalEnabled, name: tenants.name, tradeName: tenants.tradeName, logoUrl: tenants.logoUrl })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const isGlobalAdmin = tenantId === 1;
      if (!isGlobalAdmin && !tenantRows[0]?.intraHospitalEnabled) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Módulo Intra-Hospitalar não habilitado para este cliente." });
      }
      const tenantName = tenantRows[0] ? (tenantRows[0].tradeName ?? tenantRows[0].name) : "Cliente";
      const tenantLogoUrl = tenantRows[0]?.logoUrl ?? null;

      // Buscar dados de analytics
      const [globalRows] = await (db as any).execute(sql.raw(`
        SELECT COUNT(*) AS total_pedidos, ROUND(AVG(tempo_permanencia_doca), 1) AS avg_doca,
          ROUND(AVG(tempo_transito_interno), 1) AS avg_transito,
          ROUND(AVG(tempo_conferencia_unidade), 1) AS avg_conferencia,
          ROUND(AVG(tempo_total_interno), 1) AS avg_total,
          SUM(is_complete) AS total_concluidos
        FROM v_delivery_analytics WHERE tenantId = ${tenantId}
      `));
      const [byPharmacyRows] = await (db as any).execute(sql.raw(`
        SELECT va.delivery_point_id, dp.name AS point_name,
          COUNT(*) AS total_pedidos,
          ROUND(AVG(va.tempo_conferencia_unidade), 1) AS avg_conferencia,
          ROUND(AVG(va.tempo_total_interno), 1) AS avg_total,
          SUM(va.is_complete) AS total_concluidos
        FROM v_delivery_analytics va
        LEFT JOIN deliveryPoints dp ON dp.id = va.delivery_point_id
        WHERE va.tenantId = ${tenantId} AND va.delivery_point_id IS NOT NULL
        GROUP BY va.delivery_point_id, dp.name ORDER BY avg_total DESC
      `));
      const sla = input.slaMinutes;
      const [alertRows] = await (db as any).execute(sql.raw(`
        SELECT va.orderId, po.customerOrderNumber, va.current_status, dp.name AS point_name,
          GREATEST(COALESCE(va.tempo_permanencia_doca,0), COALESCE(va.tempo_transito_interno,0), COALESCE(va.tempo_conferencia_unidade,0)) AS max_fase,
          TIMESTAMPDIFF(MINUTE, va.last_timestamp, NOW()) AS tempo_em_aberto
        FROM v_delivery_analytics va
        LEFT JOIN deliveryPoints dp ON dp.id = va.delivery_point_id
        LEFT JOIN pickingOrders po ON po.id = va.orderId
        WHERE va.tenantId = ${tenantId} AND va.is_complete = 0
          AND (va.tempo_permanencia_doca > ${sla} OR va.tempo_transito_interno > ${sla}
            OR va.tempo_conferencia_unidade > ${sla}
            OR TIMESTAMPDIFF(MINUTE, va.last_timestamp, NOW()) > ${sla})
        ORDER BY max_fase DESC LIMIT 100
      `));

      const g = Array.isArray(globalRows) ? globalRows[0] : globalRows;
      const pharmacies = Array.isArray(byPharmacyRows) ? byPharmacyRows : [];
      const alerts = Array.isArray(alertRows) ? alertRows : [];

      function fmt(m: number | null): string {
        if (!m) return "—";
        if (m < 60) return `${m}min`;
        const h = Math.floor(m / 60); const mn = m % 60;
        return mn > 0 ? `${h}h ${mn}min` : `${h}h`;
      }

      if (input.format === "xlsx") {
        const wb = new ExcelJS.Workbook();
        wb.creator = "Med@x WMS";

        // Aba KPIs Globais
        const wsKpi = wb.addWorksheet("KPIs Globais");
        wsKpi.columns = [
          { header: "Indicador", key: "kpi", width: 30 },
          { header: "Valor", key: "value", width: 20 },
        ];
        styleHeader(wsKpi, 1, 2);
        [
          ["Total de Pedidos", Number(g?.total_pedidos ?? 0)],
          ["Pedidos Concluídos", Number(g?.total_concluidos ?? 0)],
          ["Tempo Médio na Doca", fmt(Number(g?.avg_doca) || null)],
          ["Tempo Médio em Trânsito", fmt(Number(g?.avg_transito) || null)],
          ["Tempo Médio de Conferência", fmt(Number(g?.avg_conferencia) || null)],
          ["Tempo Médio Total", fmt(Number(g?.avg_total) || null)],
          ["SLA Configurado", `${sla}min`],
          ["Pedidos com SLA Excedido", alerts.length],
        ].forEach(([kpi, value]) => wsKpi.addRow({ kpi, value }));

        // Aba Por Farmácia
        const wsFarm = wb.addWorksheet("Por Farmácia");
        wsFarm.columns = [
          { header: "Farmácia", key: "name", width: 35 },
          { header: "Total Pedidos", key: "total", width: 14 },
          { header: "Concluídos", key: "concluidos", width: 14 },
          { header: "Tempo Médio Conferência", key: "avgConferencia", width: 24 },
          { header: "Tempo Médio Total", key: "avgTotal", width: 20 },
          { header: "SLA Excedido?", key: "slaExceeded", width: 14 },
        ];
        styleHeader(wsFarm, 1, 6);
        pharmacies.forEach((p: any) => {
          const avgTotal = Number(p.avg_total) || 0;
          wsFarm.addRow({
            name: p.point_name ?? `Ponto ${p.delivery_point_id}`,
            total: Number(p.total_pedidos),
            concluidos: Number(p.total_concluidos),
            avgConferencia: fmt(Number(p.avg_conferencia) || null),
            avgTotal: fmt(avgTotal || null),
            slaExceeded: avgTotal > sla ? "Sim" : "Não",
          });
        });

        // Aba Alertas SLA
        const wsAlert = wb.addWorksheet("Alertas SLA");
        wsAlert.columns = [
          { header: "Pedido", key: "order", width: 18 },
          { header: "Status", key: "status", width: 20 },
          { header: "Farmácia", key: "pharmacy", width: 30 },
          { header: "Tempo Máx. Fase (min)", key: "maxFase", width: 22 },
          { header: "Tempo em Aberto (min)", key: "emAberto", width: 22 },
          { header: "Excede SLA em (min)", key: "exceeds", width: 20 },
        ];
        styleHeader(wsAlert, 1, 6);
        alerts.forEach((a: any) => {
          const maxFase = Number(a.max_fase) || 0;
          wsAlert.addRow({
            order: a.customerOrderNumber ?? `#${a.orderId}`,
            status: a.current_status,
            pharmacy: a.point_name ?? "—",
            maxFase,
            emAberto: Number(a.tempo_em_aberto) || 0,
            exceeds: Math.max(0, maxFase - sla),
          });
        });

        return { base64: await xlsxToBase64(wb), filename: `intra-hospitalar-${tenantName}-${Date.now()}.xlsx` };
      }

      // PDF
      const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true });
      await buildPdfHeader(doc, "Performance Intra-Hospitalar", tenantName,
        `SLA configurado: ${sla}min · Gerado em ${new Date().toLocaleDateString("pt-BR")}`, tenantLogoUrl);

      let y = doc.y;
      const startX = 40;
      const pageW = doc.page.width - 80;

      // Seção KPIs
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e40af").text("KPIs Globais", startX, y);
      y += 16;
      const kpis = [
        ["Total de Pedidos", String(Number(g?.total_pedidos ?? 0))],
        ["Concluídos", String(Number(g?.total_concluidos ?? 0))],
        ["Tempo Médio Total", fmt(Number(g?.avg_total) || null)],
        ["Tempo na Doca", fmt(Number(g?.avg_doca) || null)],
        ["Tempo em Trânsito", fmt(Number(g?.avg_transito) || null)],
        ["Tempo de Conferência", fmt(Number(g?.avg_conferencia) || null)],
        ["Alertas de SLA", String(alerts.length)],
      ];
      kpis.forEach(([label, value], i) => {
        const col = i % 2;
        const kpiX = startX + col * (pageW / 2);
        const kpiY = y + Math.floor(i / 2) * 22;
        doc.rect(kpiX, kpiY, pageW / 2 - 8, 20).fill(i % 4 < 2 ? "#f0f9ff" : "#f8fafc");
        doc.fontSize(7).font("Helvetica").fillColor("#64748b").text(label, kpiX + 6, kpiY + 3, { width: pageW / 2 - 20 });
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e293b").text(value, kpiX + 6, kpiY + 11, { width: pageW / 2 - 20 });
      });
      y += Math.ceil(kpis.length / 2) * 22 + 16;

      // Seção Por Farmácia
      if (pharmacies.length > 0) {
        if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#1e40af").text("Desempenho por Farmácia", startX, y);
        y += 14;
        const farmCols = [160, 70, 70, 90, 90, 35];
        const farmHeaders = ["Farmácia", "Total", "Concluídos", "T. Conferência", "T. Total", "SLA"];
        doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
        doc.rect(startX, y, pageW, 18).fill("#1e40af");
        let fx = startX + 4;
        farmHeaders.forEach((h, i) => {
          doc.text(h, fx, y + 5, { width: farmCols[i] - 4 });
          fx += farmCols[i];
        });
        y += 18;
        doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
        pharmacies.forEach((p: any, idx: number) => {
          if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
          const avgTotal = Number(p.avg_total) || 0;
          const exceedsSla = avgTotal > sla;
          doc.rect(startX, y, pageW, 16).fill(idx % 2 === 0 ? "#f8fafc" : "#ffffff");
          if (exceedsSla) doc.rect(startX, y, 4, 16).fill("#ef4444");
          doc.fillColor("#1e293b");
          fx = startX + 4;
          [
            (p.point_name ?? `Ponto ${p.delivery_point_id}`).slice(0, 26),
            String(Number(p.total_pedidos)),
            String(Number(p.total_concluidos)),
            fmt(Number(p.avg_conferencia) || null),
            fmt(avgTotal || null),
            exceedsSla ? "SIM" : "OK",
          ].forEach((cell, i) => {
            if (i === 5) doc.fillColor(exceedsSla ? "#ef4444" : "#16a34a").font("Helvetica-Bold");
            doc.text(cell, fx, y + 4, { width: farmCols[i] - 4 });
            doc.fillColor("#1e293b").font("Helvetica");
            fx += farmCols[i];
          });
          y += 16;
        });
        y += 12;
      }

      // Seção Alertas
      if (alerts.length > 0) {
        if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#dc2626").text(`Pedidos com SLA Excedido (${alerts.length})`, startX, y);
        y += 14;
        const alertCols = [100, 90, 130, 80, 80, 35];
        const alertHeaders = ["Pedido", "Status", "Farmácia", "T. Máx. Fase", "Em Aberto", "Excede"];
        doc.fontSize(8).font("Helvetica-Bold").fillColor("white");
        doc.rect(startX, y, pageW, 18).fill("#dc2626");
        let ax = startX + 4;
        alertHeaders.forEach((h, i) => {
          doc.text(h, ax, y + 5, { width: alertCols[i] - 4 });
          ax += alertCols[i];
        });
        y += 18;
        doc.fontSize(7).font("Helvetica").fillColor("#1e293b");
        alerts.slice(0, 50).forEach((a: any, idx: number) => {
          if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
          doc.rect(startX, y, pageW, 16).fill(idx % 2 === 0 ? "#fff5f5" : "#ffffff");
          doc.fillColor("#1e293b");
          ax = startX + 4;
          const maxFase = Number(a.max_fase) || 0;
          [
            a.customerOrderNumber ?? `#${a.orderId}`,
            a.current_status ?? "—",
            (a.point_name ?? "—").slice(0, 20),
            fmt(maxFase || null),
            fmt(Number(a.tempo_em_aberto) || null),
            `+${Math.max(0, maxFase - sla)}min`,
          ].forEach((cell, i) => {
            doc.text(cell, ax, y + 4, { width: alertCols[i] - 4 });
            ax += alertCols[i];
          });
          y += 16;
        });
      }

      buildPdfFooter(doc);
      return { base64: await pdfToBase64(doc), filename: `intra-hospitalar-${tenantName}-${Date.now()}.pdf` };
    }),
});
