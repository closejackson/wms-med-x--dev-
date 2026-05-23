import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Printer, Download, AlertTriangle, Package, Tag } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────
type LabelSize = "100x50" | "100x100";
type LabelFormat = "pdf" | "zpl";

interface LabelItem {
  id: number;
  productId: number;
  productSku: string | null;
  productInternalCode: string | null;
  displayCode: string;
  productDescription: string | null;
  batch: string | null;
  expiryDate: string | null;
  unitsPerBox: number | null;
  unitOfMeasure: string | null;
  quantityForLabels: number;
  numLabels: number | null;
  lastLabelQty: number | null;
  hasFraction: boolean;
  needsManualInput: boolean;
}

interface ManualInput {
  itemId: number;
  unitsPerBox: number;
}

interface VolumeLabelDialogProps {
  open: boolean;
  onClose: () => void;
  receivingOrderId: number;
  orderNumber?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pré-visualização SVG da etiqueta
// ─────────────────────────────────────────────────────────────────────────────
function LabelPreview({
  item,
  qty,
  size,
  batchOverride,
}: {
  item: LabelItem & { resolvedUnitsPerBox: number };
  qty: number;
  size: LabelSize;
  batchOverride?: string;
}) {
  const w = size === "100x100" ? 300 : 300;
  const h = size === "100x100" ? 300 : 150;
  const desc = (item.productDescription || "").substring(0, 45);
  const descDisplay = desc.length > 38 ? desc.substring(0, 37) + "…" : desc;
  const validade = item.expiryDate
    ? item.expiryDate.split("-").reverse().join("/")
    : "";
  const uom = item.unitOfMeasure || "UN";
  const batchDisplay = batchOverride?.trim() || item.batch || "S/L";

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="border border-gray-300 rounded bg-white shadow-sm"
      style={{ fontFamily: "monospace" }}
    >
      {/* Borda */}
      <rect x="1" y="1" width={w - 2} height={h - 2} fill="white" stroke="#ccc" strokeWidth="1" rx="3" />

      {/* Logo placeholder */}
      <rect x={w - 80} y="6" width="74" height="22" fill="#1e293b" rx="3" />
      <text x={w - 43} y="21" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold">Med@x WMS</text>

      {/* Linha 1: Descrição */}
      <text x="8" y="18" fill="#111" fontSize="9" fontWeight="bold">{descDisplay}</text>

      {/* Linha 2: Código */}
      <text x="8" y="32" fill="#333" fontSize="8">Cod: {item.displayCode}</text>

      {/* Linha 3: Lote */}
      <text x="8" y="44" fill="#333" fontSize="8">Lote: {batchDisplay}</text>

      {/* Linha 4: Validade */}
      {validade && (
        <text x="8" y="56" fill="#333" fontSize="8">Val: {validade}</text>
      )}

      {/* Linha 5: Conteúdo */}
      <text x="8" y={validade ? 68 : 56} fill="#111" fontSize="9" fontWeight="bold">
        CONTEÚDO: {qty} {uom}
      </text>

      {/* Barcode placeholder */}
      <rect x="8" y={h - 55} width={w - 16} height="40" fill="#f8f8f8" stroke="#ddd" strokeWidth="0.5" rx="2" />
      {/* Barras simuladas */}
      {Array.from({ length: 40 }).map((_, i) => (
        <rect
          key={i}
          x={8 + i * ((w - 16) / 40)}
          y={h - 54}
          width={Math.random() > 0.5 ? 3 : 1.5}
          height={30}
          fill="#111"
        />
      ))}
      <text x={w / 2} y={h - 10} textAnchor="middle" fill="#333" fontSize="7">
        {item.displayCode}|{batchDisplay}|{item.expiryDate || ""}
      </text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────
export function VolumeLabelDialog({
  open,
  onClose,
  receivingOrderId,
  orderNumber,
}: VolumeLabelDialogProps) {
  const [step, setStep] = useState<"select-scope" | "select-items" | "configure" | "preview">("select-scope");
  const [scope, setScope] = useState<"all" | "specific">("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manualInputs, setManualInputs] = useState<ManualInput[]>([]);
  const [labelSize, setLabelSize] = useState<LabelSize>("100x50");
  const [labelFormat, setLabelFormat] = useState<LabelFormat>("pdf");
  const [previewItem, setPreviewItem] = useState<(LabelItem & { resolvedUnitsPerBox: number }) | null>(null);
  const [quantityOverrides, setQuantityOverrides] = useState<Record<number, number>>({});
  // Lote editável por item (chave = item.id, valor = string do lote)
  const [batchOverrides, setBatchOverrides] = useState<Record<number, string>>({});

  const { data: items, isLoading } = trpc.receiving.getItemsForLabels.useQuery(
    { receivingOrderId },
    { enabled: open }
  );

  const generateMutation = trpc.receiving.generateVolumeLabels.useMutation({
    onSuccess: (data) => {
      const ext = data.format === "zpl" ? "zpl" : "pdf";
      const mime = data.format === "zpl" ? "text/plain" : "application/pdf";
      const link = document.createElement("a");
      link.href = data.content;
      link.download = `etiquetas-${orderNumber || receivingOrderId}-${Date.now()}.${ext}`;
      link.click();
      toast.success(`${data.totalLabels} etiqueta(s) gerada(s) com sucesso!`);
      onClose();
    },
    onError: (err) => {
      toast.error(`Erro ao gerar etiquetas: ${err.message}`);
    },
  });

  // Resetar ao abrir
  useEffect(() => {
    if (open) {
      setStep("select-scope");
      setScope("all");
      setSelectedIds([]);
      setManualInputs([]);
      setQuantityOverrides({});
      setBatchOverrides({});
      setPreviewItem(null);
    }
  }, [open]);

  // Itens que precisam de input manual
  const itemsNeedingManual = (items || []).filter((i) => {
    const inScope = scope === "all" || selectedIds.includes(i.id);
    return inScope && i.needsManualInput;
  });

  // Itens selecionados para geração
  const selectedItems = (items || []).filter((i) =>
    scope === "all" ? true : selectedIds.includes(i.id)
  );

  // Resolver unitsPerBox (manual ou do banco)
  const resolveUpb = (item: LabelItem): number => {
    const manual = manualInputs.find((m) => m.itemId === item.id);
    if (manual) return manual.unitsPerBox;
    return item.unitsPerBox || 1;
  };

  // Resolver lote: override do usuário > valor do XML > "S/L"
  const resolveBatch = (item: LabelItem): string | null => {
    const override = batchOverrides[item.id];
    if (override !== undefined) return override.trim() || null;
    return item.batch;
  };

  // Resolver numLabels com override de quantidade
  const resolveNumLabels = (item: LabelItem): number => {
    const upb = resolveUpb(item);
    const qty = quantityOverrides[item.id] ?? item.quantityForLabels;
    return Math.ceil(qty / upb);
  };

  const resolveLastLabelQty = (item: LabelItem): number => {
    const upb = resolveUpb(item);
    const qty = quantityOverrides[item.id] ?? item.quantityForLabels;
    return qty % upb !== 0 ? qty % upb : upb;
  };

  const handleGenerate = () => {
    const itemsToGenerate = selectedItems.map((item) => {
      const upb = resolveUpb(item);
      const qty = quantityOverrides[item.id] ?? item.quantityForLabels;
      const numLabels = Math.ceil(qty / upb);
      const lastLabelQty = qty % upb !== 0 ? qty % upb : upb;
      return {
        productId: item.productId,
        productSku: item.productSku || "",
        displayCode: item.displayCode,
        productDescription: item.productDescription || "",
        batch: resolveBatch(item),
        expiryDate: item.expiryDate,
        unitsPerBox: upb,
        unitOfMeasure: item.unitOfMeasure || "UN",
        quantityForLabels: qty,
        numLabels,
        lastLabelQty,
      };
    });

    generateMutation.mutate({
      receivingOrderId,
      items: itemsToGenerate,
      format: labelFormat,
      labelSize,
    });
  };

  const totalLabels = selectedItems.reduce((sum, item) => sum + resolveNumLabels(item), 0);
  const hasFractions = selectedItems.some((item) => {
    const upb = resolveUpb(item);
    const qty = quantityOverrides[item.id] ?? item.quantityForLabels;
    return qty % upb !== 0;
  });

  // ── Step: Selecionar escopo ──────────────────────────────────────────────
  if (step === "select-scope") {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-blue-600" />
              Gerar Etiquetas de Produto
            </DialogTitle>
            <DialogDescription>
              {orderNumber ? `Recebimento ${orderNumber}` : `OR #${receivingOrderId}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">Deseja gerar etiquetas para:</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setScope("all"); setStep("configure"); }}
                className="flex flex-col items-center gap-2 p-4 border-2 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <Package className="h-8 w-8 text-blue-600" />
                <span className="font-medium text-sm">Todos os Itens</span>
                <span className="text-xs text-gray-500">{items?.length || 0} produto(s)</span>
              </button>
              <button
                onClick={() => { setScope("specific"); setStep("select-items"); }}
                className="flex flex-col items-center gap-2 p-4 border-2 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <Tag className="h-8 w-8 text-blue-600" />
                <span className="font-medium text-sm">Selecionar Específicos</span>
                <span className="text-xs text-gray-500">Escolher por SKU</span>
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: Selecionar itens específicos ───────────────────────────────────
  if (step === "select-items") {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Selecionar Itens</DialogTitle>
            <DialogDescription>Marque os produtos para os quais deseja gerar etiquetas</DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="py-8 text-center text-gray-500">Carregando itens...</div>
          ) : (
            <div className="space-y-2 mt-2">
              {(items || []).map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedIds.includes(item.id) ? "bg-blue-50 border-blue-300" : "hover:bg-gray-50"
                  }`}
                  onClick={() => {
                    setSelectedIds((prev) =>
                      prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                    );
                  }}
                >
                  <Checkbox checked={selectedIds.includes(item.id)} onCheckedChange={() => {}} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{item.productDescription || "—"}</p>
                    <p className="text-xs text-gray-500">
                      {item.displayCode} · Lote: {item.batch || "S/L"} · Qtd: {item.quantityForLabels}
                    </p>
                  </div>
                  <div className="text-right">
                    {item.unitsPerBox ? (
                      <Badge variant="outline" className="text-xs">
                        {Math.ceil(item.quantityForLabels / item.unitsPerBox)} etiqueta(s)
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                        Sem fator UOM
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between mt-4">
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setStep("select-scope")}>Voltar</Button>
            <Button
              onClick={() => setStep("configure")}
              disabled={selectedIds.length === 0}
            >
              Continuar ({selectedIds.length} selecionado(s))
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: Configurar (modal de intervenção UOM + opções) ─────────────────
  if (step === "configure") {
    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Configurar Etiquetas</DialogTitle>
            <DialogDescription>
              {totalLabels} etiqueta(s) serão geradas para {selectedItems.length} produto(s)
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-2">
            {/* Intervenção manual para SKUs sem unitsPerBox */}
            {itemsNeedingManual.length > 0 && (
              <Alert className="border-amber-300 bg-amber-50">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription>
                  <p className="font-medium text-amber-800 mb-2">
                    {itemsNeedingManual.length} produto(s) sem fator de embalagem cadastrado
                  </p>
                  <div className="space-y-3">
                    {itemsNeedingManual.map((item) => (
                      <div key={item.id} className="flex items-center gap-3">
                        <span className="text-sm font-mono text-amber-900 flex-1 truncate">
                          {item.displayCode} — {(item.productDescription || "").substring(0, 30)}
                        </span>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-amber-700 whitespace-nowrap">UN por caixa:</Label>
                          <Input
                            type="number"
                            min={1}
                            className="w-20 h-7 text-sm"
                            value={manualInputs.find((m) => m.itemId === item.id)?.unitsPerBox || ""}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 1;
                              setManualInputs((prev) => {
                                const existing = prev.find((m) => m.itemId === item.id);
                                if (existing) return prev.map((m) => m.itemId === item.id ? { ...m, unitsPerBox: val } : m);
                                return [...prev, { itemId: item.id, unitsPerBox: val }];
                              });
                            }}
                            placeholder="ex: 12"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Alerta de caixa fracionada */}
            {hasFractions && (
              <Alert className="border-blue-300 bg-blue-50">
                <AlertTriangle className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800 text-sm">
                  Alguns itens têm quantidade fracionada. A última etiqueta refletirá a quantidade real da caixa incompleta.
                </AlertDescription>
              </Alert>
            )}

            {/* Lista de itens com quantidade e lote editáveis */}
            <div>
              <h4 className="text-sm font-semibold mb-2 text-gray-700">Resumo por produto</h4>
              <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                {selectedItems.map((item) => {
                  const upb = resolveUpb(item);
                  const qty = quantityOverrides[item.id] ?? item.quantityForLabels;
                  const numL = Math.ceil(qty / upb);
                  const lastQ = qty % upb !== 0 ? qty % upb : upb;
                  const isFrac = qty % upb !== 0;
                  // Valor exibido no campo Lote: override do usuário ou valor do XML
                  const batchValue = batchOverrides[item.id] !== undefined
                    ? batchOverrides[item.id]
                    : (item.batch || "");
                  const batchMissing = !item.batch && !batchOverrides[item.id]?.trim();

                  return (
                    <div key={item.id} className="p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
                      {/* Cabeçalho do item */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate">{item.productDescription}</p>
                          <p className="text-xs text-gray-500">{item.displayCode} · {upb} UN/cx</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={isFrac ? "outline" : "secondary"} className="text-xs whitespace-nowrap">
                            {numL} etiq{isFrac ? ` (última: ${lastQ})` : ""}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            title="Pré-visualizar"
                            onClick={() => {
                              setPreviewItem({ ...item, resolvedUnitsPerBox: upb });
                              setStep("preview");
                            }}
                          >
                            👁
                          </Button>
                        </div>
                      </div>

                      {/* Campos editáveis: Qtd total + Lote */}
                      <div className="grid grid-cols-2 gap-3">
                        {/* Quantidade */}
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-gray-500 whitespace-nowrap shrink-0">Qtd total:</Label>
                          <Input
                            type="number"
                            min={1}
                            className="h-7 text-xs"
                            value={qty}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 1;
                              setQuantityOverrides((prev) => ({ ...prev, [item.id]: val }));
                            }}
                          />
                        </div>

                        {/* Lote */}
                        <div className="flex items-center gap-2">
                          <Label
                            className={`text-xs whitespace-nowrap shrink-0 ${batchMissing ? "text-amber-600 font-medium" : "text-gray-500"}`}
                          >
                            Lote:
                          </Label>
                          <Input
                            type="text"
                            className={`h-7 text-xs font-mono ${batchMissing ? "border-amber-400 focus-visible:ring-amber-400" : ""}`}
                            value={batchValue}
                            placeholder={item.batch ? item.batch : "Informar lote…"}
                            onChange={(e) => {
                              setBatchOverrides((prev) => ({ ...prev, [item.id]: e.target.value }));
                            }}
                          />
                        </div>
                      </div>

                      {/* Aviso quando lote está ausente */}
                      {batchMissing && (
                        <p className="text-xs text-amber-600 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Lote não informado no XML — preencha manualmente ou será impresso como "S/L"
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Seletor de modelo */}
            <div>
              <h4 className="text-sm font-semibold mb-2 text-gray-700">Modelo de etiqueta</h4>
              <RadioGroup
                value={labelSize}
                onValueChange={(v) => setLabelSize(v as LabelSize)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="100x50" id="size-50" />
                  <Label htmlFor="size-50" className="cursor-pointer">
                    <span className="font-medium">100×50mm</span>
                    <span className="text-xs text-gray-500 ml-1">(padrão logístico)</span>
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="100x100" id="size-100" />
                  <Label htmlFor="size-100" className="cursor-pointer">
                    <span className="font-medium">100×100mm</span>
                    <span className="text-xs text-gray-500 ml-1">(itens grandes)</span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Seletor de formato */}
            <div>
              <h4 className="text-sm font-semibold mb-2 text-gray-700">Formato de saída</h4>
              <RadioGroup
                value={labelFormat}
                onValueChange={(v) => setLabelFormat(v as LabelFormat)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="pdf" id="fmt-pdf" />
                  <Label htmlFor="fmt-pdf" className="cursor-pointer">
                    <span className="font-medium">PDF</span>
                    <span className="text-xs text-gray-500 ml-1">(impressoras comuns)</span>
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="zpl" id="fmt-zpl" />
                  <Label htmlFor="fmt-zpl" className="cursor-pointer">
                    <span className="font-medium">ZPL</span>
                    <span className="text-xs text-gray-500 ml-1">(Zebra / térmica)</span>
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>

          <div className="flex justify-between mt-6">
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setStep(scope === "all" ? "select-scope" : "select-items")}>
              Voltar
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  if (selectedItems[0]) {
                    const item = selectedItems[0];
                    setPreviewItem({ ...item, resolvedUnitsPerBox: resolveUpb(item) });
                    setStep("preview");
                  }
                }}
                disabled={selectedItems.length === 0}
              >
                👁 Pré-visualizar
              </Button>
              <Button
                onClick={handleGenerate}
                disabled={
                  generateMutation.isPending ||
                  itemsNeedingManual.some((i) => !manualInputs.find((m) => m.itemId === i.id))
                }
                className="bg-blue-600 hover:bg-blue-700"
              >
                {generateMutation.isPending ? (
                  "Gerando..."
                ) : (
                  <>
                    {labelFormat === "pdf" ? <Printer className="h-4 w-4 mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                    Gerar {totalLabels} Etiqueta(s)
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Step: Pré-visualização ───────────────────────────────────────────────
  if (step === "preview" && previewItem) {
    const upb = resolveUpb(previewItem);
    const qty = quantityOverrides[previewItem.id] ?? previewItem.quantityForLabels;
    const numL = Math.ceil(qty / upb);
    const lastQ = qty % upb !== 0 ? qty % upb : upb;
    const batchPreview = batchOverrides[previewItem.id] !== undefined
      ? batchOverrides[previewItem.id]
      : (previewItem.batch || "");

    return (
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Pré-visualização da Etiqueta</DialogTitle>
            <DialogDescription>
              {previewItem.productDescription} · {numL} etiqueta(s)
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 mt-4">
            <LabelPreview
              item={previewItem}
              qty={upb}
              size={labelSize}
              batchOverride={batchPreview}
            />
            {numL > 1 && (
              <p className="text-xs text-gray-500 text-center">
                Etiquetas 1 a {numL - 1}: {upb} {previewItem.unitOfMeasure || "UN"} cada
                {lastQ !== upb && ` · Etiqueta ${numL}: ${lastQ} ${previewItem.unitOfMeasure || "UN"} (fracionada)`}
              </p>
            )}
            <div className="text-xs text-gray-400 text-center">
              Barcode: {previewItem.displayCode}|{batchPreview || "SL"}|{previewItem.expiryDate || ""}
            </div>
          </div>

          <div className="flex justify-between mt-4">
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setStep("configure")}>
              ← Voltar às configurações
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={generateMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {generateMutation.isPending ? "Gerando..." : (
                <>
                  {labelFormat === "pdf" ? <Printer className="h-4 w-4 mr-2" /> : <Download className="h-4 w-4 mr-2" />}
                  Gerar {totalLabels} Etiqueta(s)
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return null;
}
