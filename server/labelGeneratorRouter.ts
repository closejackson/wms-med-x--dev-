/**
 * labelGeneratorRouter.ts
 *
 * Módulo Gerador de Etiquetas — WMS Med@x
 *
 * Fluxo de negócio (conforme especificação):
 * 1. Enriquecimento de Produto: busca por sku (Cód. Externo) no tenant,
 *    atualiza unitsPerBox se nulo/zero.
 * 2. Get-or-Create de Etiqueta: verifica labelAssociations por uniqueCode (codExterno+lote).
 *    Se existir, reutiliza o labelCode. Se não, gera novo e salva em labelAssociations + productLabels.
 * 3. Sincronização Condicional de Inventário: atualiza inventory.labelCode SOMENTE se o
 *    registro existir E quantity > 0.
 * 4. Geração de saída: ZPL (impressoras térmicas) ou PDF (visualização).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, or, sql } from "drizzle-orm";
import { router } from "./_core/trpc";
import { getDb } from "./db";
import {
  products,
  productTenantMappings,
  labelAssociations,
  productLabels,
  inventory,
} from "../drizzle/schema";
import { toMySQLDate } from "../shared/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Formata data YYYY-MM-DD → DD/MM/AAAA */
function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = String(d).substring(0, 10);
  const [y, m, day] = s.split("-");
  if (y && m && day) return `${day}/${m}/${y}`;
  return s;
}

/**
 * Gera o labelCode no padrão: CódExterno|Lote|Validade
 * Ex: "401460|P22D08|2026-12-31"
 */
function buildLabelCode(codExterno: string, lote: string, validade: string | null): string {
  const parts = [codExterno.trim().toUpperCase(), lote.trim().toUpperCase()];
  if (validade) parts.push(validade.substring(0, 10));
  return parts.join("|");
}

/**
 * Gera o uniqueCode no padrão: CódExterno+Lote (sem separador, uppercase)
 * Compatível com o padrão usado no Recebimento.
 */
function buildUniqueCode(codExterno: string, lote: string): string {
  return `${codExterno.trim().toUpperCase()}${lote.trim().toUpperCase()}`;
}

// ── Geração ZPL ──────────────────────────────────────────────────────────────

interface LabelData {
  labelCode: string;
  sku: string;
  description: string;
  batch: string;
  expiryDate: string | null;
  unitsPerBox: number;
  copies: number;
  labelSize?: "100x50" | "100x100";
}

function buildZPL(label: LabelData): string {
  const isLarge = label.labelSize === "100x100";
  const labelHeight = isLarge ? 800 : 400;
  const yOffset = isLarge ? 200 : 0;
  const desc = (label.description || "").substring(0, 40);
  const valStr = fmtDate(label.expiryDate);

  const block = [
    `^XA`,
    `^PW800`,
    `^LL${labelHeight}`,
    `^FO20,${20 + yOffset}^A0N,26,26^FD${desc}^FS`,
    `^FO20,${55 + yOffset}^A0N,22,22^FDCod: ${label.sku}  Lote: ${label.batch}^FS`,
    valStr ? `^FO20,${82 + yOffset}^A0N,22,22^FDValidade: ${valStr}^FS` : null,
    label.unitsPerBox > 0
      ? `^FO20,${108 + yOffset}^A0N,22,22^FDCONTEUDO: ${label.unitsPerBox} UN^FS`
      : null,
    `^FO20,${140 + yOffset}^BY2^BCN,80,Y,N,N^FD${label.labelCode}^FS`,
    `^XZ`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return Array.from({ length: label.copies }, () => block).join("\n");
}

// ── Geração PDF ──────────────────────────────────────────────────────────────

async function buildLabelPdf(label: LabelData): Promise<string> {
  const PDFDocument = (await import("pdfkit")).default;
  const bwipjs = await import("bwip-js");
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const logoPath = path.join(__dirname, "assets", "medax-logo.png");

  const isLarge = label.labelSize === "100x100";
  const labelH = isLarge ? 283 : 142; // 100x100mm ou 100x50mm em pontos
  const valStr = fmtDate(label.expiryDate);

  const barcodeBuffer = await (bwipjs as any).default.toBuffer({
    bcid: "code128",
    text: label.labelCode,
    scale: 2,
    height: isLarge ? 16 : 10,
    includetext: true,
    textxalign: "center",
    textsize: 6,
  });

  const doc = new PDFDocument({
    size: [283, labelH],
    margins: { top: 4, bottom: 4, left: 6, right: 6 },
    autoFirstPage: false,
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  for (let i = 0; i < label.copies; i++) {
    doc.addPage();

    // Logo (topo direito)
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 200, 4, { width: 77 });
    }

    // Descrição
    const descTrunc =
      label.description.length > 38
        ? label.description.substring(0, 37) + "…"
        : label.description;
    doc.fontSize(8.5).font("Helvetica-Bold").text(descTrunc, 6, 6, { width: 190, lineBreak: false });

    const afterDesc = Math.max(doc.y + 4, 18);

    // SKU
    doc.fontSize(7.5).font("Helvetica").text(`Cod: ${label.sku}`, 6, afterDesc, { width: 190 });
    // Lote
    doc.fontSize(7.5).font("Helvetica").text(`Lote: ${label.batch}`, 6, afterDesc + 10, { width: 190 });
    // Validade
    if (valStr) {
      doc.fontSize(7.5).font("Helvetica").text(`Val: ${valStr}`, 6, afterDesc + 20, { width: 190 });
    }
    // Conteúdo
    if (label.unitsPerBox > 0) {
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .text(
          `CONTEUDO: ${label.unitsPerBox} UN`,
          6,
          valStr ? afterDesc + 30 : afterDesc + 20,
          { width: 271 }
        );
    }

    // Código de barras
    const barcodeY = isLarge ? 120 : 65;
    const barcodeH = isLarge ? 120 : 60;
    doc.image(barcodeBuffer, 6, barcodeY, { width: 271, height: barcodeH });
  }

  doc.end();

  const pdfBuffer = await new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  return `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;
}

// ── Importar tenantProcedure ──────────────────────────────────────────────────

import { protectedProcedure } from "./_core/trpc";

// tenantProcedure inline (mesmo padrão do labelReprintRouter)
const tenantProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

  const isGlobalAdmin =
    ctx.user.role === "admin" &&
    (ctx.user as any).isGlobalAdmin === true;

  const effectiveTenantId: number =
    (ctx as any).selectedTenantId ??
    ctx.user.tenantId ??
    0;

  return next({
    ctx: {
      ...ctx,
      db,
      isGlobalAdmin,
      effectiveTenantId,
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════════════════════

export const labelGeneratorRouter = router({
  /**
   * Gera (ou recupera) uma etiqueta para um item/lote.
   *
   * Regras:
   * 1. Busca produto por sku (Cód. Externo) no tenant.
   * 2. Se unitsPerBox for nulo/zero, atualiza com o valor do formulário.
   * 3. Verifica labelAssociations por uniqueCode (codExterno+lote).
   *    - Se existir: reutiliza o labelCode.
   *    - Se não existir: gera novo labelCode e salva em labelAssociations + productLabels.
   * 4. Sincronização condicional: atualiza inventory.labelCode SOMENTE se quantity > 0.
   * 5. Retorna ZPL ou PDF conforme formato solicitado.
   */
  generate: protectedProcedure
    .input(
      z.object({
        tenantId: z.number(),
        codExterno: z.string().min(1, "Cód. Externo obrigatório"),
        lote: z.string().min(1, "Lote obrigatório"),
        validade: z.string().nullable().optional(), // YYYY-MM-DD
        unitsPerBox: z.number().int().min(1, "Unidades por caixa deve ser ≥ 1"),
        copies: z.number().int().min(1).max(100).default(1),
        format: z.enum(["pdf", "zpl"]).default("pdf"),
        labelSize: z.enum(["100x50", "100x100"]).default("100x50"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Normalizar strings
      const codExterno = input.codExterno.trim().toUpperCase();
      const lote = input.lote.trim().toUpperCase();
      const validade = input.validade?.trim() || null;
      const tenantId = input.tenantId;

      // ── PASSO 1: Enriquecimento de Produto ───────────────────────────────
      // Busca por sku no mapeamento do tenant, depois fallback para sku global
      const [mapping] = await db
        .select({
          productId: productTenantMappings.productId,
          internalCode: productTenantMappings.internalCode,
        })
        .from(productTenantMappings)
        .where(
          and(
            eq(productTenantMappings.tenantId, tenantId),
            or(
              eq(products.sku, codExterno),
              eq(productTenantMappings.internalCode, codExterno)
            )
          )
        )
        .limit(1);

      let productId: number;
      let productInternalCode: string;
      let productDescription: string;

      if (mapping) {
        // Produto encontrado via mapeamento do tenant
        const [prod] = await db
          .select({
            id: products.id,
            sku: products.sku,
            description: products.description,
            unitsPerBox: products.unitsPerBox,
          })
          .from(products)
          .where(eq(products.id, mapping.productId))
          .limit(1);

        if (!prod)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Produto não encontrado para Cód. Externo: ${codExterno}`,
          });

        productId = prod.id;
        productInternalCode = mapping.internalCode || prod.sku || codExterno;
        productDescription = prod.description;

        // Enriquecer unitsPerBox se ausente
        if (!prod.unitsPerBox || prod.unitsPerBox === 0) {
          await db
            .update(products)
            .set({ unitsPerBox: input.unitsPerBox })
            .where(eq(products.id, prod.id));
        }
      } else {
        // Fallback: busca direta por sku global
        const [prod] = await db
          .select({
            id: products.id,
            sku: products.sku,
            description: products.description,
            unitsPerBox: products.unitsPerBox,
          })
          .from(products)
          .where(eq(products.sku, codExterno))
          .limit(1);

        if (!prod)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Produto com Cód. Externo "${codExterno}" não encontrado. Verifique o cadastro do produto.`,
          });

        productId = prod.id;
        productInternalCode = prod.sku || codExterno;
        productDescription = prod.description;

        if (!prod.unitsPerBox || prod.unitsPerBox === 0) {
          await db
            .update(products)
            .set({ unitsPerBox: input.unitsPerBox })
            .where(eq(products.id, prod.id));
        }
      }

      // ── PASSO 2: Get-or-Create de Etiqueta ──────────────────────────────
      const uniqueCode = buildUniqueCode(codExterno, lote);
      let labelCode: string;
      let isNew = false;

      const [existingAssoc] = await db
        .select({ labelCode: labelAssociations.labelCode })
        .from(labelAssociations)
        .where(
          and(
            eq(labelAssociations.tenantId, tenantId),
            eq(labelAssociations.uniqueCode, uniqueCode)
          )
        )
        .limit(1);

      if (existingAssoc) {
        // Reutiliza o labelCode existente
        labelCode = existingAssoc.labelCode;
      } else {
        // Gera novo labelCode
        labelCode = buildLabelCode(codExterno, lote, validade);
        isNew = true;

        const expiryDateMysql = toMySQLDate(validade ? new Date(validade) : null) as any;

        // Salvar em labelAssociations
        await db.insert(labelAssociations).values({
          tenantId,
          labelCode,
          uniqueCode,
          productId,
          batch: lote,
          expiryDate: expiryDateMysql,
          unitsPerBox: input.unitsPerBox,
          associatedBy: ctx.user.id,
          associatedAt: new Date(),
          status: "AVAILABLE",
        });

        // Salvar em productLabels (fallback para Stage)
        await db
          .insert(productLabels)
          .values({
            labelCode,
            productId,
            productSku: codExterno,
            batch: lote,
            expiryDate: expiryDateMysql,
            createdBy: ctx.user.id,
          })
          .onDuplicateKeyUpdate({
            set: {
              productId,
              expiryDate: expiryDateMysql,
            },
          });
      }

      // ── PASSO 3: Sincronização Condicional de Inventário ─────────────────
      // Atualiza inventory.labelCode SOMENTE se o registro existir E quantity > 0
      const inventoryUpdated = await db
        .update(inventory)
        .set({ labelCode })
        .where(
          and(
            eq(inventory.tenantId, tenantId),
            eq(inventory.uniqueCode, uniqueCode),
            sql`${inventory.quantity} > 0`
          )
        );

      const rowsAffected = (inventoryUpdated as any)?.rowsAffected ?? 0;

      // ── PASSO 4: Geração de Saída ────────────────────────────────────────
      const labelData: LabelData = {
        labelCode,
        sku: productInternalCode,
        description: productDescription,
        batch: lote,
        expiryDate: validade,
        unitsPerBox: input.unitsPerBox,
        copies: input.copies,
        labelSize: input.labelSize,
      };

      let output: string;
      if (input.format === "zpl") {
        const zplContent = buildZPL(labelData);
        output = `data:text/plain;base64,${Buffer.from(zplContent).toString("base64")}`;
      } else {
        output = await buildLabelPdf(labelData);
      }

      return {
        success: true,
        labelCode,
        uniqueCode,
        productId,
        productInternalCode,
        isNew,
        inventoryUpdated: rowsAffected > 0,
        format: input.format,
        output,
        message: isNew
          ? `Etiqueta criada: ${labelCode}`
          : `Etiqueta existente reutilizada: ${labelCode}`,
      };
    }),

  /**
   * Busca produto por Cód. Externo para pré-preencher o formulário.
   * Retorna descrição, unitsPerBox e se o produto existe.
   */
  lookupProduct: protectedProcedure
    .input(
      z.object({
        tenantId: z.number(),
        codExterno: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const codExterno = input.codExterno.trim().toUpperCase();

      // Busca via mapeamento do tenant
      const [mapping] = await db
        .select({
          productId: productTenantMappings.productId,
          internalCode: productTenantMappings.internalCode,
        })
        .from(productTenantMappings)
        .where(
          and(
            eq(productTenantMappings.tenantId, input.tenantId),
            or(
              eq(products.sku, codExterno),
              eq(productTenantMappings.internalCode, codExterno)
            )
          )
        )
        .limit(1);

      const productIdToSearch = mapping?.productId;

      if (!productIdToSearch) {
        // Fallback: busca por sku global
        const [prod] = await db
          .select({
            id: products.id,
            sku: products.sku,
            description: products.description,
            unitsPerBox: products.unitsPerBox,
          })
          .from(products)
          .where(eq(products.sku, codExterno))
          .limit(1);

        if (!prod) return null;

        return {
          found: true,
          productId: prod.id,
          sku: prod.sku || codExterno,
          description: prod.description,
          unitsPerBox: prod.unitsPerBox,
        };
      }

      const [prod] = await db
        .select({
          id: products.id,
          sku: products.sku,
          description: products.description,
          unitsPerBox: products.unitsPerBox,
        })
        .from(products)
        .where(eq(products.id, productIdToSearch))
        .limit(1);

      if (!prod) return null;

      return {
        found: true,
        productId: prod.id,
        sku: mapping?.internalCode || prod.sku || codExterno,
        description: prod.description,
        unitsPerBox: prod.unitsPerBox,
      };
    }),
});
