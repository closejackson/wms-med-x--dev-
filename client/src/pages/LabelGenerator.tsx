/**
 * LabelGenerator.tsx
 *
 * Módulo Gerador de Etiquetas — WMS Med@x
 *
 * Formulário para geração de etiquetas logísticas com:
 * - Busca de produto por Cód. Externo (com auto-preenchimento)
 * - Lógica Get-or-Create de labelCode
 * - Enriquecimento de unitsPerBox
 * - Sincronização condicional de inventário
 * - Saída em ZPL (impressoras térmicas) ou PDF (visualização)
 */

import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Tag,
  Printer,
  FileText,
  Search,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Package,
  Info,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function downloadBase64(dataUri: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUri;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function openPdfPreview(dataUri: string) {
  const win = window.open();
  if (!win) return;
  win.document.write(
    `<html><body style="margin:0"><iframe src="${dataUri}" width="100%" height="100%" style="border:none"></iframe></body></html>`
  );
}

// ── Tipos ────────────────────────────────────────────────────────────────────

interface FormState {
  codExterno: string;
  lote: string;
  validade: string;
  unitsPerBox: string;
  copies: string;
  format: "pdf" | "zpl";
  labelSize: "100x50" | "100x100";
}

const INITIAL_FORM: FormState = {
  codExterno: "",
  lote: "",
  validade: "",
  unitsPerBox: "",
  copies: "1",
  format: "pdf",
  labelSize: "100x50",
};

// ════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

export function LabelGenerator() {
  // Tenant
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");
  const { data: tenants } = trpc.tenants.list.useQuery();

  // Formulário
  const [form, setForm] = useState<FormState>(INITIAL_FORM);

  // Estado de lookup do produto
  const [productInfo, setProductInfo] = useState<{
    found: boolean;
    sku: string | null;
    description: string;
    unitsPerBox: number | null;
  } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resultado da geração
  const [result, setResult] = useState<{
    labelCode: string;
    isNew: boolean;
    inventoryUpdated: boolean;
    format: "pdf" | "zpl";
    output: string;
    message: string;
  } | null>(null);

  // Mutations e queries
  const lookupQuery = trpc.labelGenerator.lookupProduct.useQuery(
    {
      tenantId: parseInt(selectedTenantId || "0"),
      codExterno: form.codExterno,
    },
    {
      enabled: false, // Controlado manualmente
    }
  );

  const generateMutation = trpc.labelGenerator.generate.useMutation({
    onSuccess: (data) => {
      setResult(data);
      if (data.isNew) {
        toast.success("Etiqueta criada com sucesso", { description: data.message });
      } else {
        toast.info("Etiqueta existente recuperada", { description: data.message });
      }
    },
    onError: (err) => {
      toast.error("Erro ao gerar etiqueta", { description: err.message });
    },
  });

  // ── Auto-lookup ao digitar Cód. Externo ──────────────────────────────────
  useEffect(() => {
    if (!form.codExterno.trim() || !selectedTenantId) {
      setProductInfo(null);
      return;
    }

    if (lookupTimeout.current) clearTimeout(lookupTimeout.current);
    lookupTimeout.current = setTimeout(async () => {
      setLookupLoading(true);
      try {
        const data = await lookupQuery.refetch();
        if (data.data) {
          setProductInfo({
            found: data.data.found,
            sku: data.data.sku || form.codExterno,
            description: data.data.description,
            unitsPerBox: data.data.unitsPerBox ?? null,
          });
          // Auto-preencher unitsPerBox se disponível e campo vazio
          if (data.data.unitsPerBox && !form.unitsPerBox) {
            setForm((f) => ({ ...f, unitsPerBox: String(data.data!.unitsPerBox) }));
          }
        } else {
          setProductInfo(null);
        }
      } catch {
        setProductInfo(null);
      } finally {
        setLookupLoading(false);
      }
    }, 600);

    return () => {
      if (lookupTimeout.current) clearTimeout(lookupTimeout.current);
    };
  }, [form.codExterno, selectedTenantId]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleField(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    if (field === "codExterno") {
      setProductInfo(null);
      setResult(null);
    }
  }

  async function handleGenerate() {
    if (!selectedTenantId) {
      toast.error("Selecione um cliente");
      return;
    }
    if (!form.codExterno.trim()) {
      toast.error("Informe o Cód. Externo");
      return;
    }
    if (!form.lote.trim()) {
      toast.error("Informe o Lote");
      return;
    }
    const upb = parseInt(form.unitsPerBox);
    if (!upb || upb < 1) {
      toast.error("Informe Unidades por Caixa (≥ 1)");
      return;
    }
    const copies = parseInt(form.copies);
    if (!copies || copies < 1) {
      toast.error("Informe a Quantidade de Etiquetas (≥ 1)");
      return;
    }

    setResult(null);
    generateMutation.mutate({
      tenantId: parseInt(selectedTenantId),
      codExterno: form.codExterno.trim().toUpperCase(),
      lote: form.lote.trim().toUpperCase(),
      validade: form.validade || null,
      unitsPerBox: upb,
      copies,
      format: form.format,
      labelSize: form.labelSize,
    });
  }

  function handleReset() {
    setForm(INITIAL_FORM);
    setProductInfo(null);
    setResult(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="container py-6 max-w-3xl mx-auto space-y-6">
      {/* Cabeçalho */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Tag className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Gerador de Etiquetas</h1>
          <p className="text-sm text-muted-foreground">
            Crie ou recupere etiquetas logísticas por Cód. Externo e Lote
          </p>
        </div>
      </div>

      {/* Seleção de Cliente */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cliente</CardTitle>
          <CardDescription>Selecione o cliente para o qual a etiqueta será gerada</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
            <SelectTrigger>
              <SelectValue placeholder="Selecione um cliente..." />
            </SelectTrigger>
            <SelectContent>
              {(tenants || []).map((t: any) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Formulário */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Dados da Etiqueta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Cód. Externo */}
          <div className="space-y-1.5">
            <Label htmlFor="codExterno">
              Cód. Externo (Fornecedor) <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Input
                id="codExterno"
                placeholder="Ex: 401460"
                value={form.codExterno}
                onChange={(e) => handleField("codExterno", e.target.value)}
                className="pr-8"
                disabled={!selectedTenantId}
              />
              <div className="absolute right-2 top-2.5">
                {lookupLoading ? (
                  <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : productInfo ? (
                  productInfo.found ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-destructive" />
                  )
                ) : (
                  <Search className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </div>
            {/* Info do produto encontrado */}
            {productInfo && productInfo.found && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800">
                <Package className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                <div className="text-xs text-green-700 dark:text-green-400">
                  <span className="font-semibold">{productInfo.sku}</span> —{" "}
                  {productInfo.description}
                  {productInfo.unitsPerBox && (
                    <span className="ml-1 text-muted-foreground">
                      ({productInfo.unitsPerBox} UN/CX)
                    </span>
                  )}
                </div>
              </div>
            )}
            {productInfo && !productInfo.found && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Produto não encontrado para este cliente
              </p>
            )}
          </div>

          {/* Lote e Validade */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="lote">
                Lote <span className="text-destructive">*</span>
              </Label>
              <Input
                id="lote"
                placeholder="Ex: P22D08"
                value={form.lote}
                onChange={(e) => handleField("lote", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="validade">Validade</Label>
              <Input
                id="validade"
                type="date"
                value={form.validade}
                onChange={(e) => handleField("validade", e.target.value)}
              />
            </div>
          </div>

          {/* Unidades por Caixa e Cópias */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="unitsPerBox">
                Unidades por Caixa <span className="text-destructive">*</span>
              </Label>
              <Input
                id="unitsPerBox"
                type="number"
                min={1}
                placeholder="Ex: 30"
                value={form.unitsPerBox}
                onChange={(e) => handleField("unitsPerBox", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="copies">
                Qtd. de Etiquetas <span className="text-destructive">*</span>
              </Label>
              <Input
                id="copies"
                type="number"
                min={1}
                max={100}
                placeholder="Ex: 1"
                value={form.copies}
                onChange={(e) => handleField("copies", e.target.value)}
              />
            </div>
          </div>

          <Separator />

          {/* Configurações de impressão */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Formato de Saída</Label>
              <Select
                value={form.format}
                onValueChange={(v) => handleField("format", v as "pdf" | "zpl")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pdf">
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4" /> PDF (visualização)
                    </span>
                  </SelectItem>
                  <SelectItem value="zpl">
                    <span className="flex items-center gap-2">
                      <Printer className="h-4 w-4" /> ZPL (impressora térmica)
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tamanho da Etiqueta</Label>
              <Select
                value={form.labelSize}
                onValueChange={(v) => handleField("labelSize", v as "100x50" | "100x100")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="100x50">100mm × 50mm</SelectItem>
                  <SelectItem value="100x100">100mm × 100mm</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Botões */}
          <div className="flex gap-3 pt-2">
            <Button
              onClick={handleGenerate}
              disabled={generateMutation.isPending || !selectedTenantId}
              className="flex-1"
            >
              {generateMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Gerando...
                </>
              ) : (
                <>
                  <Tag className="h-4 w-4 mr-2" />
                  Gerar Etiqueta
                </>
              )}
            </Button>
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={handleReset} disabled={generateMutation.isPending}>
              Limpar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Resultado */}
      {result && (
        <Card className="border-green-200 dark:border-green-800">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Etiqueta Gerada
              </CardTitle>
              <div className="flex gap-2">
                <Badge variant={result.isNew ? "default" : "secondary"}>
                  {result.isNew ? "Nova" : "Existente"}
                </Badge>
                {result.inventoryUpdated && (
                  <Badge variant="outline" className="text-green-600 border-green-400">
                    Inventário sincronizado
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Info da etiqueta */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Label Code:</span>
                <p className="font-mono font-semibold break-all">{result.labelCode}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Unique Code:</span>
                <p className="font-mono text-xs break-all">{(result as any).uniqueCode}</p>
              </div>
            </div>

            {!result.inventoryUpdated && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-400">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Inventário não atualizado — nenhum registro com saldo {">"} 0 encontrado para
                  este item/lote. A etiqueta foi registrada normalmente.
                </span>
              </div>
            )}

            {/* Ações de download/visualização */}
            <div className="flex gap-3">
              {result.format === "pdf" ? (
                <>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => openPdfPreview(result.output)}
                    className="flex-1"
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Visualizar PDF
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadBase64(result.output, `etiqueta-${result.labelCode}.pdf`)
                    }
                  >
                    Baixar PDF
                  </Button>
                </>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() =>
                    downloadBase64(result.output, `etiqueta-${result.labelCode}.zpl`)
                  }
                  className="flex-1"
                >
                  <Printer className="h-4 w-4 mr-2" />
                  Baixar ZPL
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Legenda */}
      <Card className="bg-muted/40">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                <strong>Get-or-Create:</strong> Se já existir uma etiqueta para este Cód. Externo +
                Lote, o sistema reutiliza o labelCode existente sem criar duplicatas.
              </p>
              <p>
                <strong>Enriquecimento:</strong> Se o produto não tiver "Unidades por Caixa"
                cadastrado, o valor informado será salvo automaticamente.
              </p>
              <p>
                <strong>Sincronização de Inventário:</strong> O labelCode é vinculado ao estoque
                apenas se houver saldo físico {">"} 0 para o item/lote.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
