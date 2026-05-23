/**
 * Router de Importação Massiva de Saldos de Inventário via Excel
 *
 * Regras de negócio:
 * - Acesso restrito a tenantId === 1 (Global Admin / Operador Med@x)
 * - O mesmo labelCode pode existir em múltiplos registros de inventory (sem restrição UNIQUE)
 * - Status derivado automaticamente pela zona do endereço (STORAGE/REC → available; NCG → quarantine)
 * - uniqueCode gerado estritamente como SKU-Lote (sem prefixos ou sufixos)
 * - Transação atômica: erro em qualquer linha cancela toda a importação (rollback)
 * - tenantName (nome do cliente) é resolvido para tenantId internamente — o usuário não precisa saber o ID
 * - A coluna "SKU" do template corresponde ao campo "Cód. Interno" (internalCode) no cadastro de produtos
 *   O lookup é feito por products.internalCode (não por products.sku)
 */

import { router, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "./db";
import {
  inventory,
  products,
  productTenantMappings,
  tenants,
  warehouseLocations,
  warehouseZones,
} from "../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";
import { toMySQLDate } from "../shared/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gera uniqueCode como {SKU (Cód. Externo)}-{Lote}.
 * O SKU aqui é sempre products.sku (código do fornecedor/Med@x), não o internalCode.
 * Se não houver lote, retorna apenas o SKU.
 */
function buildUniqueCode(sku: string | null | undefined, batch: string | null | undefined): string {
  const safeSku = (sku ?? "").trim();
  // Se não há SKU (Cód. Externo), não gerar uniqueCode
  if (!safeSku) return "";
  if (!batch || batch.trim() === "") return safeSku;
  return `${safeSku}-${batch.trim()}`;
}

/**
 * Deriva o status do registro de inventário com base no código da zona do endereço.
 * Zona NCG → quarantine; qualquer outra zona (STORAGE, REC, EXP, etc.) → available
 */
function deriveStatusFromZone(zoneCode: string | null | undefined): "available" | "quarantine" {
  if (!zoneCode) return "available";
  const zone = zoneCode.toUpperCase().trim();
  if (zone === "NCG") return "quarantine";
  return "available";
}

/**
 * Normaliza um Date para meia-noite no horário LOCAL (startOfDay).
 */
function startOfDayLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Converte um valor de data do Excel para objeto Date normalizado para
 * meia-noite local (startOfDay). Aceita:
 *   - string "DD/MM/YYYY"
 *   - string "YYYY-MM-DD"
 *   - string "YYYY-MM-DD HH:MM:SS" (exportação MySQL)
 *   - número serial do Excel (dias desde 1900-01-01, com bug de 1900-02-29)
 *   - objeto Date
 *
 * Retorna null se o valor for inválido ou vazio.
 */
function parseExcelDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    if (value < 1) return null;
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const ms = Math.round(value) * 24 * 60 * 60 * 1000;
    const rawDate = new Date(excelEpoch.getTime() + ms);
    return startOfDayLocal(rawDate);
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;

    const ddmmyyyy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (ddmmyyyy) {
      return new Date(
        parseInt(ddmmyyyy[3]),
        parseInt(ddmmyyyy[2]) - 1,
        parseInt(ddmmyyyy[1])
      );
    }

    const yyyymmdd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (yyyymmdd) {
      return new Date(
        parseInt(yyyymmdd[1]),
        parseInt(yyyymmdd[2]) - 1,
        parseInt(yyyymmdd[3])
      );
    }

    const yyyymmddHHMMSS = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T]/);
    if (yyyymmddHHMMSS) {
      return new Date(
        parseInt(yyyymmddHHMMSS[1]),
        parseInt(yyyymmddHHMMSS[2]) - 1,
        parseInt(yyyymmddHHMMSS[3])
      );
    }

    const d = new Date(s);
    if (!isNaN(d.getTime())) return startOfDayLocal(d);
  }

  if (value instanceof Date) return startOfDayLocal(value);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema de validação de cada linha do Excel
// ─────────────────────────────────────────────────────────────────────────────

const InventoryRowSchema = z.object({
  /** Cód. Interno do produto (campo internalCode no cadastro) */
  sku: z.string().min(1, "Cód. Interno é obrigatório"),
  /** Cód. Externo do produto (sku/supplierCode) — obrigatório para geração de uniqueCode */
  externalCode: z.string().optional().nullable(),
  /** Descrição do produto (opcional) — usada ao auto-criar produto */
  description: z.string().optional().nullable(),
  /** Unidades por caixa (opcional) — preenchido ao auto-criar produto */
  unitsPerBox: z.number().int().positive().optional().nullable(),
  /** Lote (opcional) */
  batch: z.string().optional().nullable(),
  /** Código da etiqueta física (LPN) — pode ser compartilhado entre zonas */
  labelCode: z.string().optional().nullable(),
  /** Código do endereço de destino (obrigatório) */
  locationCode: z.string().min(1, "Endereço é obrigatório"),
  /** Quantidade (obrigatório, > 0) */
  quantity: z.number().int().positive("Quantidade deve ser maior que zero"),
  /** Data de validade (opcional) — aceita string ou número serial */
  expiryDate: z.union([z.string(), z.number(), z.date()]).optional().nullable(),
  /** Nome do cliente dono do estoque (obrigatório) — resolvido para tenantId internamente */
  tenantName: z.string().min(1, "Nome do cliente é obrigatório"),
});

// Schema interno com tenantId já resolvido (usado após lookup)
const InventoryRowResolvedSchema = InventoryRowSchema.extend({
  tenantId: z.number().int().positive(),
});

type InventoryRowResolved = z.infer<typeof InventoryRowResolvedSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const inventoryImportRouter = router({
  /**
   * Importar saldos de inventário em lote via Excel.
   *
   * O cliente envia as linhas já parseadas do Excel como array de objetos.
   * A procedure:
   *   1. Valida que o usuário é do tenantId === 1 (Global Admin)
   *   2. Resolve tenantName → tenantId via lookup na tabela tenants
   *   3. Para cada linha, resolve produto e endereço
   *   4. Deriva status pela zona do endereço
   *   5. Gera uniqueCode como SKU-Lote
   *   6. Insere ou atualiza (upsert) o registro de inventory
   *   7. Tudo dentro de uma transação — erro = rollback total
   */
  importBatch: protectedProcedure
    .input(
      z.object({
        rows: z.array(
          z.object({
            sku: z.string(),
            externalCode: z.string().optional().nullable(),
            description: z.string().optional().nullable(),
            unitsPerBox: z.number().optional().nullable(),
            batch: z.string().optional().nullable(),
            labelCode: z.string().optional().nullable(),
            locationCode: z.string(),
            quantity: z.number(),
            expiryDate: z.union([z.string(), z.number()]).optional().nullable(),
            tenantName: z.string(),
          })
        ).min(1, "Nenhuma linha fornecida"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // ── 1. Validar acesso: apenas Global Admin (tenantId === 1) ──────────
      if (ctx.user.tenantId !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Importação de inventário é exclusiva para o operador Med@x (tenantId: 1).",
        });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // ── 2. Resolver tenantName → tenantId ────────────────────────────────
      const uniqueTenantNames = Array.from(new Set(input.rows.map(r => r.tenantName.trim())));
      const allTenants = await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants);
      const tenantNameMap = new Map<string, number>();
      for (const t of allTenants) {
        tenantNameMap.set(t.name.trim().toLowerCase(), t.id);
      }

      // Validar que todos os nomes de tenant existem antes de iniciar a transação
      for (const name of uniqueTenantNames) {
        if (!tenantNameMap.has(name.toLowerCase())) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cliente "${name}" não encontrado no cadastro. Verifique o nome exato do cliente na planilha.`,
          });
        }
      }

      const results: {
        inserted: number;
        updated: number;
        productsCreated: number;
        errors: Array<{ linha: number; sku: string; locationCode: string; erro: string }>;
      } = { inserted: 0, updated: 0, productsCreated: 0, errors: [] };

      // ── 3. Pré-carregar produtos e endereços ─────────────────────────────
      const skus = Array.from(new Set(input.rows.map(r => (r.sku ?? "").trim()).filter(Boolean)));
      const externalCodes = Array.from(new Set(input.rows.map(r => (r.externalCode ?? "").trim()).filter(Boolean)));
      const locationCodes = Array.from(new Set(input.rows.map(r => r.locationCode.trim())));

      const [allLocations] = await Promise.all([
        db.select({
          id: warehouseLocations.id,
          code: warehouseLocations.code,
          zoneCode: warehouseLocations.zoneCode,
          zoneCodeFromZone: warehouseZones.code,
          tenantId: warehouseLocations.tenantId,
        })
          .from(warehouseLocations)
          .leftJoin(warehouseZones, eq(warehouseLocations.zoneId, warehouseZones.id)),
      ]);

      // Buscar todos os produtos (sem filtro de tenantId pois admin global gerencia todos)
      // Lookup por internalCode ("Cód. Interno" no cadastro) + tenantId
      const allProductsFull = await db
        .select({ id: products.id, sku: products.sku, internalCode: products.internalCode })
        .from(products);

      // Buscar mapeamentos existentes em productTenantMappings
      const allMappings = await db
        .select({ productId: productTenantMappings.productId, tenantId: productTenantMappings.tenantId, internalCode: productTenantMappings.internalCode, supplierCode: productTenantMappings.supplierCode })
        .from(productTenantMappings);

      // Produtos são buscados por internalCode+tenantId (mapeamento) ou internalCode global
      // Chave: "internalCode|tenantId" → { id, sku }
      const productMap = new Map<string, { id: number; sku: string | null }>();
      // Primeiro popular com mapeamentos por tenant (mais específico)
      for (const m of allMappings) {
        if (m.internalCode) {
          const key = `${m.internalCode.trim()}|${m.tenantId}`;
          // Buscar o produto correspondente
          const prod = allProductsFull.find(p => p.id === m.productId);
          if (prod) productMap.set(key, { id: prod.id, sku: prod.sku ?? null });
        }
        if (m.supplierCode) {
          const key = `ext:${m.supplierCode.trim()}|${m.tenantId}`;
          const prod = allProductsFull.find(p => p.id === m.productId);
          if (prod) productMap.set(key, { id: prod.id, sku: prod.sku ?? null });
        }
      }
      // Também popular com internalCode global (fallback)
      for (const p of allProductsFull) {
        if (p.internalCode) {
          const globalKey = `${p.internalCode.trim()}|global`;
          if (!productMap.has(globalKey)) {
            productMap.set(globalKey, { id: p.id, sku: p.sku ?? null });
          }
        }
      }

      const locationMap = new Map<string, { id: number; code: string; zoneCode: string | null; tenantId: number }>();
      for (const loc of allLocations) {
        const resolvedZoneCode = loc.zoneCode ?? loc.zoneCodeFromZone ?? null;
        locationMap.set(loc.code.trim(), { ...loc, zoneCode: resolvedZoneCode });
      }

      // ── 4. Processar dentro de transação atômica ─────────────────────────
      await db.transaction(async (tx) => {
        for (let i = 0; i < input.rows.length; i++) {
          const rawRow = input.rows[i];
          const lineNum = i + 1;

          // Resolver tenantId pelo nome
          const resolvedTenantId = tenantNameMap.get(rawRow.tenantName.trim().toLowerCase())!;

          // Validar linha com Zod (schema com tenantName)
          const parseResult = InventoryRowSchema.safeParse({
            ...rawRow,
            sku: rawRow.sku?.trim(),
            locationCode: rawRow.locationCode?.trim(),
          });

          if (!parseResult.success) {
            const msg = parseResult.error.issues.map((e: { message: string }) => e.message).join("; ");
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Linha ${lineNum} (SKU: ${rawRow.sku}, Endereço: ${rawRow.locationCode}): ${msg}`,
            });
          }

          const row = { ...parseResult.data, tenantId: resolvedTenantId };

          // Resolver produto pelo Cód. Interno (internalCode) + tenantId
          // Prioridade: mapeamento por tenant > mapeamento global
          const internalCodeKey = `${row.sku.trim()}|${row.tenantId}`;
          const globalKey = `${row.sku.trim()}|global`;
          const externalCodeKey = row.externalCode ? `ext:${row.externalCode.trim()}|${row.tenantId}` : null;

          let product = productMap.get(internalCodeKey)
            ?? (externalCodeKey ? productMap.get(externalCodeKey) : undefined)
            ?? productMap.get(globalKey);

          if (!product) {
            // Auto-criar produto com os dados da planilha
            const externalCode = (row as any).externalCode?.trim() ?? null;
            const unitsPerBoxVal = (row as any).unitsPerBox ?? null;

            const [inserted] = await tx
              .insert(products)
              .values({
                sku: externalCode ?? row.sku.trim(),           // Cód. Externo como sku global
                supplierCode: externalCode ?? null,            // Cód. Externo = supplierCode
                customerCode: row.sku.trim(),                  // Cód. Interno = customerCode
                internalCode: row.sku.trim(),                  // Cód. Interno
                description: row.description?.trim() || `Produto ${row.sku.trim()} (criado automaticamente via importação de saldos)`,
                unitsPerBox: unitsPerBoxVal ?? undefined,
                status: "active",
                tenantId: row.tenantId,
              } as any);
            const newProductId = inserted.insertId;
            product = { id: newProductId, sku: externalCode ?? row.sku.trim() };

            // Criar vínculo em productTenantMappings
            await tx
              .insert(productTenantMappings)
              .values({
                productId: newProductId,
                tenantId: row.tenantId,
                internalCode: row.sku.trim(),
                supplierCode: externalCode ?? null,
                customerCode: row.sku.trim(),
              } as any)
              .onDuplicateKeyUpdate({
                set: {
                  internalCode: row.sku.trim(),
                  supplierCode: externalCode ?? null,
                  customerCode: row.sku.trim(),
                },
              });

            // Adicionar ao mapa para linhas subsequentes
            productMap.set(internalCodeKey, product);
            if (externalCodeKey) productMap.set(externalCodeKey, product);
            results.productsCreated++;
          } else {
            // Produto já existe — garantir vínculo em productTenantMappings
            const externalCode = (row as any).externalCode?.trim() ?? null;
            await tx
              .insert(productTenantMappings)
              .values({
                productId: product.id,
                tenantId: row.tenantId,
                internalCode: row.sku.trim(),
                supplierCode: externalCode ?? null,
                customerCode: row.sku.trim(),
              } as any)
              .onDuplicateKeyUpdate({
                set: {
                  internalCode: row.sku.trim(),
                  supplierCode: externalCode ?? null,
                  customerCode: row.sku.trim(),
                },
              });
          }

          // Resolver endereço
          const location = locationMap.get(row.locationCode);
          if (!location) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Linha ${lineNum}: Endereço "${row.locationCode}" não encontrado no cadastro.`,
            });
          }

          // Derivar status pela zona
          const status = deriveStatusFromZone(location.zoneCode);

          // uniqueCode = {SKU (Cód. Externo = products.sku)}-{Lote}
          const uniqueCode = buildUniqueCode(product.sku, row.batch);

          // Converter e validar data de validade
          const expiryDateObj = parseExcelDate(row.expiryDate);
          if (!expiryDateObj) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Linha ${lineNum} (SKU: ${row.sku}, Endereço: ${row.locationCode}): Data de validade ausente ou inválida. Um item-lote sem validade é um erro grave de inventário. Verifique se a coluna Validade está preenchida e no formato correto (DD/MM/AAAA, AAAA-MM-DD ou número serial do Excel).`,
            });
          }
          const expiryDateStr = toMySQLDate(expiryDateObj);

          // Verificar se já existe registro para este produto+lote+endereço+tenant
          const [existing] = await tx
            .select({ id: inventory.id, quantity: inventory.quantity })
            .from(inventory)
            .where(
              and(
                eq(inventory.productId, product.id),
                eq(inventory.locationId, location.id),
                eq(inventory.tenantId, row.tenantId),
                row.batch
                  ? eq(inventory.batch, row.batch)
                  : isNull(inventory.batch)
              )
            )
            .limit(1);

          if (existing) {
            const accumulatedQuantity = existing.quantity + row.quantity;
            await tx
              .update(inventory)
              .set({
                quantity: accumulatedQuantity,
                labelCode: row.labelCode ?? null,
                uniqueCode,
                status,
                locationZone: location.zoneCode ?? null,
                expiryDate: expiryDateStr as any,
                updatedAt: new Date(),
              })
              .where(eq(inventory.id, existing.id));
            results.updated++;
          } else {
            await tx.insert(inventory).values({
              tenantId: row.tenantId,
              productId: product.id,
              locationId: location.id,
              batch: row.batch ?? null,
              expiryDate: expiryDateStr as any,
              uniqueCode,
              labelCode: row.labelCode ?? null,
              locationZone: location.zoneCode ?? null,
              quantity: row.quantity,
              reservedQuantity: 0,
              status,
            });
            results.inserted++;
          }
        }
      });

      return {
        success: true,
        inserted: results.inserted,
        updated: results.updated,
        productsCreated: results.productsCreated,
        total: input.rows.length,
        message: `Importação concluída: ${results.inserted} inseridos, ${results.updated} atualizados${
          results.productsCreated > 0 ? `, ${results.productsCreated} produto(s) cadastrado(s) automaticamente` : ""
        }.`,
      };
    }),

  /**
   * Validar linhas do Excel antes da importação (dry-run).
   * Retorna lista de erros por linha sem gravar nada no banco.
   */
  validateBatch: protectedProcedure
    .input(
      z.object({
        rows: z.array(
          z.object({
            sku: z.string(),
            externalCode: z.string().optional().nullable(),
            description: z.string().optional().nullable(),
            unitsPerBox: z.number().optional().nullable(),
            batch: z.string().optional().nullable(),
            labelCode: z.string().optional().nullable(),
            locationCode: z.string(),
            quantity: z.number(),
            expiryDate: z.union([z.string(), z.number()]).optional().nullable(),
            tenantName: z.string(),
          })
        ).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Apenas Global Admin pode validar
      if (ctx.user.tenantId !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Validação de importação é exclusiva para o operador Med@x (tenantId: 1).",
        });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Resolver tenantName → tenantId
      const allTenants = await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants);
      const tenantNameMap = new Map<string, number>();
      for (const t of allTenants) {
        tenantNameMap.set(t.name.trim().toLowerCase(), t.id);
      }

      // Pré-carregar produtos e endereços
      // Lookup por internalCode (cód. interno) — coluna "SKU" do template
      const [allProducts, allLocations] = await Promise.all([
        db.select({ id: products.id, sku: products.sku, internalCode: products.internalCode }).from(products),
        db.select({ id: warehouseLocations.id, code: warehouseLocations.code, zoneCode: warehouseLocations.zoneCode })
          .from(warehouseLocations),
      ]);

      // Mapa: internalCode → { sku (Cód. Externo) } para gerar uniqueCode correto na prévia
      const productByInternalCode = new Map<string, { sku: string }>();
      for (const p of allProducts) {
        if (p.internalCode) productByInternalCode.set(p.internalCode.trim(), { sku: p.sku });
      }
      const productSkus = new Set(allProducts.filter(p => p.internalCode).map(p => p.internalCode!.trim()));
      const locationCodes = new Set(allLocations.map(l => l.code.trim()));
      const locationZoneMap = new Map(allLocations.map(l => [l.code.trim(), l.zoneCode]));

      const validationErrors: Array<{
        linha: number;
        sku: string;
        locationCode: string;
        erro: string;
        statusDerivado?: string;
        uniqueCode?: string;
      }> = [];

      const validRows: Array<{
        linha: number;
        sku: string;
        batch: string | null;
        labelCode: string | null;
        locationCode: string;
        quantity: number;
        tenantName: string;
        statusDerivado: string;
        uniqueCode: string;
      }> = [];

      for (let i = 0; i < input.rows.length; i++) {
        const rawRow = input.rows[i];
        const lineNum = i + 1;
        const erros: string[] = [];

        if (!rawRow.sku?.trim()) erros.push("Cód. Interno é obrigatório");
        if (!rawRow.locationCode?.trim()) erros.push("Endereço é obrigatório");
        if (!rawRow.quantity || rawRow.quantity <= 0) erros.push("Quantidade deve ser maior que zero");
        if (!rawRow.tenantName?.trim()) {
          erros.push("Nome do cliente é obrigatório");
        } else if (!tenantNameMap.has(rawRow.tenantName.trim().toLowerCase())) {
          erros.push(`Cliente "${rawRow.tenantName}" não encontrado no cadastro`);
        }

        if (rawRow.locationCode?.trim() && !locationCodes.has(rawRow.locationCode.trim())) {
          erros.push(`Endereço "${rawRow.locationCode}" não encontrado no cadastro`);
        }

        if (erros.length > 0) {
          validationErrors.push({
            linha: lineNum,
            sku: rawRow.sku ?? "",
            locationCode: rawRow.locationCode ?? "",
            erro: erros.join("; "),
          });
        } else {
          const zoneCode = locationZoneMap.get(rawRow.locationCode.trim());
          const statusDerivado = deriveStatusFromZone(zoneCode);
          // uniqueCode: prioridade 1 = externalCode da planilha, 2 = sku do produto existente, 3 = internalCode
          const productEntry = productByInternalCode.get(rawRow.sku.trim());
          const skuForUniqueCode = rawRow.externalCode?.trim() || (productEntry ? productEntry.sku : null) || rawRow.sku.trim();
          const uniqueCode = buildUniqueCode(skuForUniqueCode, rawRow.batch);
          validRows.push({
            linha: lineNum,
            sku: rawRow.sku.trim(),
            batch: rawRow.batch ?? null,
            labelCode: rawRow.labelCode ?? null,
            locationCode: rawRow.locationCode.trim(),
            quantity: rawRow.quantity,
            tenantName: rawRow.tenantName.trim(),
            statusDerivado,
            uniqueCode,
          });
        }
      }

      return {
        valid: validationErrors.length === 0,
        totalRows: input.rows.length,
        validCount: validRows.length,
        errorCount: validationErrors.length,
        errors: validationErrors,
        preview: validRows.slice(0, 20),
      };
    }),

  /**
   * Retorna a lista de clientes (tenants) para popular o autocomplete no template de importação.
   * Exclui o tenant Global Admin (id=1, Med@x interno).
   */
  getTenantsForTemplate: protectedProcedure
    .query(async ({ ctx }) => {
      // Apenas Global Admin pode acessar
      if (ctx.user.tenantId !== 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Acesso restrito ao operador Med@x.",
        });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const allTenants = await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .orderBy(tenants.name);

      // Excluir o tenant Global Admin (id=1)
      return allTenants
        .filter(t => t.id !== 1)
        .map(t => ({ id: t.id, name: t.name }));
    }),
});
