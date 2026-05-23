/**
 * Página de Importação Massiva de Saldos de Inventário via Excel
 *
 * Acesso restrito: apenas usuários com tenantId === 1 (Global Admin Med@x)
 *
 * Fluxo:
 *   1. Upload do arquivo Excel
 *   2. Parse client-side com xlsx
 *   3. Validação via procedure validateBatch (dry-run)
 *   4. Confirmação e importação via procedure importBatch (transação atômica)
 */

import { useState, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Download,
  Info,
  ArrowLeft,
  Home,
} from "lucide-react";
import { useLocation } from "wouter";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

interface ExcelRow {
  sku: string;           // Cód. Interno
  externalCode?: string | null; // Cód. Externo
  description?: string | null;
  unitsPerBox?: number | null;  // Unidades por Caixa
  batch?: string | null;
  labelCode?: string | null;
  locationCode: string;
  quantity: number;
  expiryDate?: string | number | null;
  tenantName: string;
}

interface ValidationResult {
  valid: boolean;
  totalRows: number;
  validCount: number;
  errorCount: number;
  errors: Array<{ linha: number; sku: string; locationCode: string; erro: string }>;
  preview: Array<{
    linha: number;
    sku: string;
    batch: string | null;
    labelCode: string | null;
    locationCode: string;
    quantity: number;
    statusDerivado: string;
    uniqueCode: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento de colunas do Excel
// Aceita cabeçalhos em PT-BR e EN
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHeader(h: string): string {
  return h
    .split("\n")[0]           // pegar apenas a primeira linha (remove "\n(obrigatório)" etc.)
    .replace(/\s*\(.*\)/g, "") // remover texto entre parênteses
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remover acentos
    .replace(/\s+/g, "_");    // espaços -> underscore
}

function mapRow(raw: Record<string, unknown>): ExcelRow | null {
  const headers = Object.keys(raw).reduce((acc, k) => {
    acc[normalizeHeader(k)] = k;
    return acc;
  }, {} as Record<string, string>);

  const get = (keys: string[]): unknown => {
    for (const k of keys) {
      const col = headers[k];
      if (col !== undefined && raw[col] !== undefined && raw[col] !== "") return raw[col];
    }
    return undefined;
  };

  // Cód. Interno: coluna "Cód. Interno" (novo nome) ou "SKU" (retrocompatível)
  const sku = String(get(["cod._interno", "cod_interno", "codigo_interno", "sku", "codigo", "codigo_produto", "produto"]) ?? "").trim();
  // Cód. Externo: nova coluna
  const externalCodeRaw = get(["cod._externo", "cod_externo", "codigo_externo", "external_code", "externalcode", "supplier_code"]);
  const externalCode = externalCodeRaw !== undefined && externalCodeRaw !== "" ? String(externalCodeRaw).trim() || null : null;
  const description = String(get(["descricao", "descrição", "description", "desc", "nome", "produto_nome"]) ?? "").trim() || null;
  // Unidades por Caixa: nova coluna
  const unitsPerBoxRaw = get(["unidades_por_caixa", "unid._por_caixa", "unid_por_caixa", "un/cx", "un_cx", "units_per_box", "unitsperbox"]);
  const unitsPerBox = unitsPerBoxRaw !== undefined && unitsPerBoxRaw !== "" ? (typeof unitsPerBoxRaw === "number" ? unitsPerBoxRaw : parseInt(String(unitsPerBoxRaw))) || null : null;
  const locationCode = String(get(["endereco", "endereço", "location", "locationcode", "location_code", "codigo_endereco"]) ?? "").trim();
  const quantityRaw = get(["quantidade", "qtd", "qty", "quantity"]);
  const quantity = typeof quantityRaw === "number" ? quantityRaw : parseInt(String(quantityRaw ?? "0"));
  const tenantName = String(get(["cliente", "tenantname", "tenant_name", "tenantid", "tenant_id", "clienteid", "cliente_id"]) ?? "").trim();

  if (!sku || !locationCode || isNaN(quantity) || quantity <= 0 || !tenantName) {
    return null;
  }

  return {
    sku,
    externalCode,
    description,
    unitsPerBox: unitsPerBox && !isNaN(unitsPerBox) ? unitsPerBox : null,
    batch: String(get(["lote", "batch", "lot"]) ?? "").trim() || null,
    labelCode: String(get(["etiqueta", "etiqueta/lpn", "labelcode", "label_code", "label", "lpn"]) ?? "").trim() || null,
    locationCode,
    quantity,
    expiryDate: (get(["validade", "vencimento", "expiry", "expirydate", "expiry_date"]) as string | number | null) ?? null,
    tenantName,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

type Step = "upload" | "validating" | "preview" | "importing" | "done" | "error";

export default function InventoryImport() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string>("");
  const [rows, setRows] = useState<ExcelRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; productsCreated: number; total: number; message: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const validateMutation = trpc.inventoryImport.validateBatch.useMutation();
  const importMutation = trpc.inventoryImport.importBatch.useMutation();

  // Verificar acesso
  const isGlobalAdmin = user?.tenantId === 1;

  // Buscar lista de clientes para o template (só para Global Admin)
  const { data: tenantsData } = trpc.inventoryImport.getTenantsForTemplate.useQuery(
    undefined,
    { enabled: isGlobalAdmin }
  );

  // ── Parse do Excel ──────────────────────────────────────────────────────────
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setParseErrors([]);
    setValidation(null);
    setImportResult(null);
    setErrorMessage("");

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target!.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array", cellDates: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

        const parsed: ExcelRow[] = [];
        const errors: string[] = [];

        rawRows.forEach((raw, idx) => {
          const mapped = mapRow(raw);
          if (!mapped) {
            errors.push(`Linha ${idx + 2}: campos obrigatórios ausentes ou inválidos (SKU, Endereço, Quantidade, Cliente)`);
          } else {
            parsed.push(mapped);
          }
        });

        setRows(parsed);
        setParseErrors(errors);

        if (parsed.length > 0) {
          setStep("preview");
        }
      } catch (err) {
        setErrorMessage(`Erro ao ler o arquivo Excel: ${err instanceof Error ? err.message : String(err)}`);
        setStep("error");
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // ── Validação (dry-run) ─────────────────────────────────────────────────────
  const handleValidate = async () => {
    if (rows.length === 0) return;
    setStep("validating");
    try {
      const result = await validateMutation.mutateAsync({ rows });
      setValidation(result);
      setStep("preview");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  };

  // ── Importação ──────────────────────────────────────────────────────────────
  const handleImport = async () => {
    if (rows.length === 0) return;
    setStep("importing");
    try {
      const result = await importMutation.mutateAsync({ rows });
      setImportResult(result);
      setStep("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  };

  // ── Reset ───────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setStep("upload");
    setFileName("");
    setRows([]);
    setParseErrors([]);
    setValidation(null);
    setImportResult(null);
    setErrorMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Download template ───────────────────────────────────────────────────────
  const handleDownloadTemplate = () => {
    const clientNames = tenantsData?.map(t => t.name) ?? ["Santa Casa de Misericórdia"];
    const firstClient = clientNames[0] ?? "Santa Casa de Misericórdia";

    const template = [
      {
        "Cód. Externo": "37379",
        "Cód. Interno": "401460P",
        "Descrição": "AMOXICILINA 500MG CAPSULAS",
        "Unidades por Caixa": 80,
        "Lote": "13489",
        "Etiqueta": "L001",
        "Endereço": "A-01-01",
        "Quantidade": 100,
        "Validade": "31/12/2026",
        "Cliente": firstClient,
      },
      {
        "Cód. Externo": "37379",
        "Cód. Interno": "401460P",
        "Descrição": "AMOXICILINA 500MG CAPSULAS",
        "Unidades por Caixa": 80,
        "Lote": "13489",
        "Etiqueta": "L001",
        "Endereço": "NCG-01",
        "Quantidade": 10,
        "Validade": "31/12/2026",
        "Cliente": firstClient,
      },
    ];

    const ws = XLSX.utils.json_to_sheet(template);

    // Largura das colunas
    ws["!cols"] = [
      { wch: 14 }, // Cód. Externo
      { wch: 14 }, // Cód. Interno
      { wch: 35 }, // Descrição
      { wch: 18 }, // Unidades por Caixa
      { wch: 12 }, // Lote
      { wch: 12 }, // Etiqueta
      { wch: 14 }, // Endereço
      { wch: 12 }, // Quantidade
      { wch: 14 }, // Validade
      { wch: 40 }, // Cliente
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Saldos");

      // Aba oculta com lista de clientes para validação de lista no Excel
      if (clientNames.length > 0) {
        const clientsSheet = XLSX.utils.aoa_to_sheet(clientNames.map(n => [n]));
        XLSX.utils.book_append_sheet(wb, clientsSheet, "_Clientes");

        // Validação de lista na coluna J (Cliente) — linhas 2 a 1000 (agora é a 10ª coluna)
        if (!ws["!dataValidations"]) ws["!dataValidations"] = [];
        (ws["!dataValidations"] as unknown[]).push({
          sqref: "J2:J1000",
        type: "list",
        formula1: `_Clientes!$A$1:$A$${clientNames.length}`,
        showDropDown: false,
        showErrorMessage: true,
        errorTitle: "Cliente inválido",
        error: `Selecione um cliente da lista. Clientes disponíveis: ${clientNames.slice(0, 3).join(", ")}${clientNames.length > 3 ? "..." : ""}.`,
      });
    }

    XLSX.writeFile(wb, "template_importacao_saldos.xlsx");
  };

  // ── Download relatório de erros ───────────────────────────────────────────
  const handleDownloadErrorReport = () => {
    if (!validation || validation.errors.length === 0) return;

    const errorRows = validation.errors.map(e => {
      const originalRow = rows[e.linha - 2]; // linha Excel começa em 2 (linha 1 = cabeçalho)
      return {
        "Linha Excel": e.linha,
        "Cód. Externo": originalRow?.externalCode ?? "",
        "Cód. Interno": originalRow?.sku ?? e.sku ?? "",
        Descrição: originalRow?.description ?? "",
        "Unidades por Caixa": originalRow?.unitsPerBox ?? "",
        Lote: originalRow?.batch ?? "",
        Etiqueta: originalRow?.labelCode ?? "",
        Endereço: originalRow?.locationCode ?? e.locationCode ?? "",
        Quantidade: originalRow?.quantity ?? "",
        Validade: originalRow?.expiryDate ?? "",
        Cliente: originalRow?.tenantName ?? "",
        "Motivo do Erro": e.erro,
      };
    });

    const ws = XLSX.utils.json_to_sheet(errorRows);
    ws["!cols"] = [
      { wch: 10 }, // Linha Excel
      { wch: 14 }, // Cód. Externo
      { wch: 14 }, // Cód. Interno
      { wch: 35 }, // Descrição
      { wch: 18 }, // Unidades por Caixa
      { wch: 12 }, // Lote
      { wch: 12 }, // Etiqueta
      { wch: 14 }, // Endereço
      { wch: 12 }, // Quantidade
      { wch: 14 }, // Validade
      { wch: 35 }, // Cliente
      { wch: 55 }, // Motivo do Erro
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Erros");
    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `erros_importacao_${timestamp}.xlsx`);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (!isGlobalAdmin) {
    return (
      <div className="container py-8 max-w-2xl">
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Acesso Restrito</AlertTitle>
          <AlertDescription>
            Esta funcionalidade é exclusiva para o operador Med@x (tenantId: 1).
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container py-6 max-w-5xl space-y-6">
      {/* Botão Voltar */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/inventory")}
          className="gap-2 text-muted-foreground hover:text-foreground -ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Button>
      </div>
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Importação de Saldos de Inventário</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Importação massiva via Excel — exclusivo para operador Med@x
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={() => navigate("/home")}>
            <Home className="h-4 w-4 mr-2" />
            Início
          </Button>
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={handleDownloadTemplate}>
            <Download className="h-4 w-4 mr-2" />
            Baixar Template
          </Button>
        </div>
      </div>

      {/* Regras de negócio */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Regras de Importação</AlertTitle>
        <AlertDescription className="mt-2 space-y-1 text-sm">
          <p>• <strong>Status derivado automaticamente</strong> pela zona do endereço: STORAGE/REC → <Badge variant="outline" className="text-green-600">available</Badge> | NCG → <Badge variant="outline" className="text-yellow-600">quarantine</Badge></p>
          <p>• <strong>uniqueCode</strong> gerado como <code className="bg-muted px-1 rounded">Cód.Externo-Lote</code> (SKU do fornecedor + lote)</p>
          <p>• O mesmo <strong>labelCode</strong> pode aparecer em múltiplos registros (STORAGE + NCG)</p>
          <p>• <strong>Transação atômica</strong>: erro em qualquer linha cancela toda a importação</p>
        </AlertDescription>
      </Alert>

      {/* Etapa: Upload */}
      {(step === "upload" || step === "preview") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Selecionar Arquivo Excel
            </CardTitle>
            <CardDescription>
              Colunas obrigatórias: <strong>Cód. Interno</strong>, <strong>Endereço</strong>, <strong>Quantidade</strong>, <strong>Cliente</strong> (nome exato do cliente). Opcionais: Cód. Externo, Unidades por Caixa, Lote, Etiqueta, Validade, Descrição.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              {fileName ? (
                <div>
                  <p className="font-medium">{fileName}</p>
                  <p className="text-sm text-muted-foreground mt-1">{rows.length} linhas lidas</p>
                </div>
              ) : (
                <div>
                  <p className="font-medium">Clique para selecionar o arquivo</p>
                  <p className="text-sm text-muted-foreground mt-1">.xlsx ou .xls</p>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Erros de parse */}
            {parseErrors.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{parseErrors.length} linha(s) ignoradas no parse</AlertTitle>
                <AlertDescription>
                  <ScrollArea className="h-24 mt-2">
                    {parseErrors.map((e, i) => <p key={i} className="text-xs">{e}</p>)}
                  </ScrollArea>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Etapa: Preview e Validação */}
      {step === "preview" && rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
              Prévia dos Dados ({rows.length} linhas)
            </CardTitle>
            <CardDescription>
              Revise as primeiras linhas e execute a validação antes de importar.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Tabela de prévia */}
            <ScrollArea className="h-56 rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Cód. Externo</TableHead>
                    <TableHead>Cód. Interno</TableHead>
                    <TableHead>Un/Cx</TableHead>
                    <TableHead>Lote</TableHead>
                    <TableHead>Etiqueta</TableHead>
                    <TableHead>Endereço</TableHead>
                    <TableHead className="text-right">Qtd</TableHead>
                    <TableHead>Validade</TableHead>
                    <TableHead>Cliente</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                      <TableCell className="font-mono text-xs">{row.externalCode ?? "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{row.sku}</TableCell>
                      <TableCell className="text-right text-sm">{row.unitsPerBox ?? "—"}</TableCell>
                      <TableCell className="text-sm">{row.batch ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{row.labelCode ?? "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{row.locationCode}</TableCell>
                      <TableCell className="text-right">{row.quantity}</TableCell>
                      <TableCell className="text-xs">{row.expiryDate ? String(row.expiryDate) : "—"}</TableCell>
                      <TableCell>{row.tenantName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
            {rows.length > 50 && (
              <p className="text-xs text-muted-foreground text-center">Exibindo 50 de {rows.length} linhas</p>
            )}

            {/* Resultado da validação */}
            {validation && (
              <div className="space-y-3">
                <Separator />
                <div className="flex items-center gap-4 flex-wrap">
                  <Badge variant={validation.valid ? "default" : "destructive"} className="text-sm px-3 py-1">
                    {validation.valid ? "✓ Validação aprovada" : `✗ ${validation.errorCount} erro(s)`}
                  </Badge>
                  <span className="text-sm text-muted-foreground">{validation.validCount} linhas válidas de {validation.totalRows}</span>
                </div>

                {validation.errors.length > 0 && (
                  <Alert variant="destructive">
                    <XCircle className="h-4 w-4" />
                    <AlertTitle>
                      <div className="flex items-center justify-between">
                        <span>Erros de Validação ({validation.errorCount})</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-4 h-7 text-xs border-red-300 text-red-700 hover:bg-red-50"
                          onClick={handleDownloadErrorReport}
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Baixar Relatório de Erros
                        </Button>
                      </div>
                    </AlertTitle>
                    <AlertDescription>
                      <ScrollArea className="h-32 mt-2">
                        {validation.errors.map((e, i) => (
                          <p key={i} className="text-xs">
                            <strong>Linha {e.linha}</strong> (SKU: {e.sku}, Endereço: {e.locationCode}): {e.erro}
                          </p>
                        ))}
                      </ScrollArea>
                    </AlertDescription>
                  </Alert>
                )}

                {validation.preview.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Prévia com status derivado:</p>
                    <ScrollArea className="h-40 rounded border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                               <TableHead>#</TableHead>
                            <TableHead>Cód. Interno</TableHead>
                            <TableHead>Lote</TableHead>
                            <TableHead>Endereço</TableHead>
                            <TableHead>uniqueCode</TableHead>
                            <TableHead>Status Derivado</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {validation.preview.map((row, i) => (
                            <TableRow key={i}>
                              <TableCell className="text-xs text-muted-foreground">{row.linha}</TableCell>
                              <TableCell className="font-mono text-sm">{row.sku}</TableCell>
                              <TableCell className="text-sm">{row.batch ?? "—"}</TableCell>
                              <TableCell className="font-mono text-sm">{row.locationCode}</TableCell>
                              <TableCell className="font-mono text-xs">{row.uniqueCode}</TableCell>
                              <TableCell>
                                <Badge variant={row.statusDerivado === "available" ? "default" : "secondary"} className="text-xs">
                                  {row.statusDerivado}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </div>
                )}
              </div>
            )}

            {/* Ações */}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={handleReset}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Novo Arquivo
              </Button>
              {!validation && (
                <Button onClick={handleValidate} disabled={validateMutation.isPending}>
                  {validateMutation.isPending ? (
                    <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Validando...</>
                  ) : (
                    <><CheckCircle2 className="h-4 w-4 mr-2" />Validar Dados</>
                  )}
                </Button>
              )}
              {validation?.valid && (
                <Button onClick={handleImport} disabled={importMutation.isPending} className="bg-green-600 hover:bg-green-700">
                  {importMutation.isPending ? (
                    <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Importando...</>
                  ) : (
                    <><Upload className="h-4 w-4 mr-2" />Confirmar Importação ({rows.length} linhas)</>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Etapa: Importando */}
      {step === "importing" && (
        <Card>
          <CardContent className="py-10 text-center space-y-4">
            <RefreshCw className="h-10 w-10 mx-auto animate-spin text-primary" />
            <p className="font-medium">Importando {rows.length} registros...</p>
            <p className="text-sm text-muted-foreground">Transação em andamento. Não feche esta página.</p>
            <Progress value={undefined} className="w-48 mx-auto" />
          </CardContent>
        </Card>
      )}

      {/* Etapa: Concluído */}
      {step === "done" && importResult && (
        <Card>
          <CardContent className="py-10 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500" />
            <h2 className="text-xl font-bold">Importação Concluída!</h2>
            <p className="text-muted-foreground">{importResult.message}</p>
            <div className="flex justify-center gap-6 mt-2">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-600">{importResult.inserted}</p>
                <p className="text-sm text-muted-foreground">Inseridos</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold text-blue-600">{importResult.updated}</p>
                <p className="text-sm text-muted-foreground">Atualizados</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold">{importResult.total}</p>
                <p className="text-sm text-muted-foreground">Total</p>
              </div>
            </div>
            <Button onClick={handleReset} className="mt-4">
              <Upload className="h-4 w-4 mr-2" />
              Nova Importação
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Etapa: Erro */}
      {step === "error" && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Erro na Importação</AlertTitle>
          <AlertDescription className="mt-2">
            <p>{errorMessage}</p>
            <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white mt-3" onClick={handleReset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Tentar Novamente
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
