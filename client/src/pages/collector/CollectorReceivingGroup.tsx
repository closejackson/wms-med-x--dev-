/**
 * Tela: Conferência Cega Agrupada (Multi-NF)
 * Rota: /collector/receiving-group?groupId=<id>
 *
 * O operador não vê a qual nota o item pertence.
 * Visualiza a lista total de SKUs com quantidades somadas de todas as NFs.
 * A distribuição FIFO é feita virtualmente e persistida apenas na finalização.
 *
 * Etiquetas não cadastradas: ao bipar uma etiqueta desconhecida, abre dialog
 * para o operador informar produto, lote, validade e qtd/caixa, criando a
 * labelAssociation e registrando a bipagem em seguida.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useBarcodeScan } from "../../hooks/useBarcodeScan";
import { CollectorLayout } from "../../components/CollectorLayout";
import { Card, CardContent } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { Progress } from "../../components/ui/progress";
import { Label } from "../../components/ui/label";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import {
  Camera, Check, Loader2, Undo2, Package, AlertTriangle,
  Layers, ChevronDown, ChevronUp, X, Tag, Search, Scissors
} from "lucide-react";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter
} from "../../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";

// ─── Tipos internos ────────────────────────────────────────────────────────────

interface ScanResult {
  productId?: number;
  productName: string;
  productSku: string;
  batch: string | null;
  expiryDate?: string | null;
  unitsPerBox: number;
  currentTotal: number;
  totalExpected: number;
  isExcess: boolean;
}

interface NewLabelForm {
  labelCode: string;
  productId: number | null;
  productSku: string;
  productName: string;
  batch: string;
  expiryDate: string;
  unitsPerBox: number;
}

const EMPTY_FORM: NewLabelForm = {
  labelCode: "",
  productId: null,
  productSku: "",
  productName: "",
  batch: "",
  expiryDate: "",
  unitsPerBox: 1,
};

// ─── Componente principal ──────────────────────────────────────────────────────

export function CollectorReceivingGroup() {
  const [, setLocation] = useLocation();

  // Extrair groupId da query string
  const groupId = (() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("groupId");
    return id ? parseInt(id) : null;
  })();

  const [showScanner, setShowScanner] = useState(false);
  const [showItemsDetail, setShowItemsDetail] = useState(false);
  const [showConfirmFinish, setShowConfirmFinish] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<ScanResult | null>(null);

  // ── Estado do dialog de nova etiqueta ─────────────────────────────────────
  const [showNewLabelDialog, setShowNewLabelDialog] = useState(false);
  const [newLabelForm, setNewLabelForm] = useState<NewLabelForm>(EMPTY_FORM);
  const [productSearch, setProductSearch] = useState("");

  // ── Estado do dialog de caixa fracionada ─────────────────────────────────
  const [showFractionalDialog, setShowFractionalDialog] = useState(false);
  const [fractionalLabelCode, setFractionalLabelCode] = useState("");
  const [fractionalUnitsPerBox, setFractionalUnitsPerBox] = useState(0);
  const [fractionalQty, setFractionalQty] = useState("");

  const utils = trpc.useUtils();

  // ── Busca de produtos para o dialog ──────────────────────────────────────
  const { data: productSearchResults, isFetching: isSearchingProducts } =
    trpc.products.list.useQuery(
      { search: productSearch, limit: 10 },
      { enabled: showNewLabelDialog && productSearch.trim().length >= 2 }
    );

  // Buscar grupo ativo (para retomada quando groupId não está na URL)
  const { data: activeGroup, isLoading: isLoadingActive } = trpc.blindConferenceGroup.getActiveGroup.useQuery(
    {},
    { enabled: !groupId }
  );

  // Redirecionar automaticamente para o grupo ativo se não houver groupId na URL
  useEffect(() => {
    if (!groupId && activeGroup?.group?.id) {
      setLocation(`/collector/receiving-group?groupId=${activeGroup.group.id}`);
    }
  }, [groupId, activeGroup, setLocation]);

  // Buscar resumo do grupo
  const { data: summary, isLoading, refetch } = trpc.blindConferenceGroup.getGroupSummary.useQuery(
    { groupId: groupId! },
    { enabled: !!groupId, refetchInterval: false }
  );

  // ── Mutations ──────────────────────────────────────────────────────────────

  const scanMutation = trpc.blindConferenceGroup.scanLabel.useMutation({
    onSuccess: (data) => {
      if (data.isNewLabel) {
        // Abrir dialog de vinculação com o código já preenchido
        // O código bipado é passado pelo handleScan antes de chamar a mutation
        setProductSearch("");
        setShowNewLabelDialog(true);
        barcode.clear();
        return;
      }
      if (data.association) {
        setLastScanResult({ ...data.association, isExcess: data.isExcess });
        if (data.isExcess) {
          toast.error(data.message, { duration: 5000 });
        } else {
          toast.success(data.message, { duration: 3000 });
        }
        // Abrir dialog de caixa fracionada APENAS quando a quantidade restante
        // é menor que uma caixa cheia (próxima bipagem causaria over-receiving)
        const assoc = data.association;
        const remaining = assoc?.remainingQuantity ?? null;
        const upb = assoc?.unitsPerBox ?? 1;
        const shouldAskFractional = upb > 1 && remaining !== null && remaining < upb && remaining > 0;
        if (shouldAskFractional) {
          setFractionalLabelCode(assoc.labelCode || "");
          setFractionalUnitsPerBox(upb);
          setFractionalQty(String(remaining)); // pré-preencher com a quantidade restante
          setShowFractionalDialog(true);
        } else {
          barcode.focus();
        }
      } else {
        barcode.focus();
      }
      barcode.clear();
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao registrar bipagem");
      barcode.clear();
      barcode.focus();
    },
  });

  const registerNewLabelMutation = trpc.blindConferenceGroup.registerNewLabelInGroup.useMutation({
    onSuccess: (data) => {
      setShowNewLabelDialog(false);
      setNewLabelForm(EMPTY_FORM);
      setProductSearch("");
      setLastScanResult({ ...data.association, isExcess: data.isExcess });
      if (data.isExcess) {
        toast.error(data.message, { duration: 5000 });
      } else {
        toast.success(data.message, { duration: 3000 });
      }
      refetch();
      barcode.focus();
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao vincular etiqueta");
    },
  });

  const undoMutation = trpc.blindConferenceGroup.undoLastScan.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setLastScanResult(null);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao desfazer bipagem");
    },
  });

  const finalizeMutation = trpc.blindConferenceGroup.finalizeGroup.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setLocation("/receiving");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao finalizar conferência agrupada");
      setShowConfirmFinish(false);
    },
  });

  const correctFractionalMutation = trpc.blindConferenceGroup.correctFractionalBox.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setShowFractionalDialog(false);
      setFractionalQty("");
      refetch();
      barcode.focus();
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao registrar caixa fracionada");
    },
  });

  const cancelMutation = trpc.blindConferenceGroup.cancelGroup.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setLocation("/receiving");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao cancelar conferência agrupada");
      setShowCancelConfirm(false);
    },
  });

  // Focar no input de bipagem ao carregar
  useEffect(() => {
    barcode.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScan = useCallback((code: string) => {
    const trimmed = code.trim();
    if (!trimmed || !groupId) return;
    // Pré-preencher o labelCode no form para o caso de etiqueta nova
    setNewLabelForm(f => ({ ...f, labelCode: trimmed }));
    scanMutation.mutate({ groupId, labelCode: trimmed });
  }, [groupId, scanMutation]);

  // Hook de auto-submit para o campo de bipagem
  const barcode = useBarcodeScan({
    onSubmit: (code) => handleScan(code),
    disabled: scanMutation.isPending,
  });

  // ── Handlers do dialog de nova etiqueta ──────────────────────────────────

  const handleSelectProduct = (product: { id: number; sku: string; description: string; unitsPerBox?: number | null }) => {
    setNewLabelForm(f => ({
      ...f,
      productId: product.id,
      productSku: product.sku,
      productName: product.description,
      unitsPerBox: product.unitsPerBox || f.unitsPerBox,
    }));
    setProductSearch(product.sku + " – " + product.description);
  };

  const handleConfirmNewLabel = () => {
    if (!newLabelForm.productId || !groupId) return;
    registerNewLabelMutation.mutate({
      groupId,
      labelCode: newLabelForm.labelCode,
      productId: newLabelForm.productId,
      batch: newLabelForm.batch || null,
      expiryDate: newLabelForm.expiryDate || null,
      unitsPerBox: newLabelForm.unitsPerBox,
    });
  };

  // ── Telas de carregamento / erro ──────────────────────────────────────────

  if (!groupId) {
    if (isLoadingActive) {
      return (
        <CollectorLayout title="Conferência Agrupada">
          <div className="p-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-indigo-500" />
            <p className="text-gray-500">Verificando sessões ativas...</p>
          </div>
        </CollectorLayout>
      );
    }
    if (activeGroup?.group?.id) {
      return (
        <CollectorLayout title="Conferência Agrupada">
          <div className="p-4 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-indigo-500" />
            <p className="text-gray-500">Retomando conferência agrupada...</p>
          </div>
        </CollectorLayout>
      );
    }
    return (
      <CollectorLayout title="Conferência Agrupada">
        <div className="p-4 text-center">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-500" />
          <p className="text-gray-700 font-medium mb-1">Nenhuma conferência agrupada ativa.</p>
          <p className="text-gray-500 text-sm mb-4">Selecione 2 ou mais NFs no Recebimento para iniciar uma conferência agrupada.</p>
          <Button onClick={() => setLocation("/receiving")}>
            Ir para Recebimento
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  if (isLoading) {
    return (
      <CollectorLayout title="Conferência Agrupada">
        <div className="p-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-indigo-500" />
          <p className="text-gray-500">Carregando conferência agrupada...</p>
        </div>
      </CollectorLayout>
    );
  }

  if (!summary) {
    return (
      <CollectorLayout title="Conferência Agrupada">
        <div className="p-4 text-center text-red-500">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p>Conferência não encontrada.</p>
          <Button className="mt-4" onClick={() => setLocation("/receiving")}>
            Voltar ao Recebimento
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  const { group, orders, consolidatedItems, totalExpected, totalRead, progress, hasExcess, canUndo } = summary;

  return (
    <CollectorLayout title="Conferência Agrupada">
      <div className="flex flex-col gap-3 p-3">

        {/* Header do Grupo */}
        <Card className="border-indigo-200 bg-indigo-50">
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-indigo-600" />
                <span className="font-semibold text-indigo-800 text-sm">{group.groupNumber}</span>
              </div>
              <Badge className={hasExcess ? "bg-red-600 text-white" : "bg-indigo-600 text-white"}>
                {hasExcess ? "⚠ Excesso" : `${progress}%`}
              </Badge>
            </div>

            {/* NFs do grupo */}
            <div className="flex flex-wrap gap-1 mb-2">
              {orders.map(o => (
                <Badge key={o.receivingOrderId} variant="outline" className="text-xs border-indigo-300 text-indigo-700">
                  NF {o.nfeNumber || o.orderNumber}
                </Badge>
              ))}
            </div>

            {/* Barra de progresso */}
            <Progress value={progress} className="h-2 mb-1" />
            <div className="flex justify-between text-xs text-indigo-700">
              <span>{totalRead} bipados</span>
              <span>{totalExpected} esperados</span>
            </div>
          </CardContent>
        </Card>

        {/* Campo de Bipagem */}
        <Card>
          <CardContent className="pt-3 pb-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  ref={barcode.ref}
                  value={barcode.value}
                  onChange={barcode.onChange}
                  onKeyDown={barcode.onKeyDown}
                  placeholder="Bipe ou digite o código da etiqueta..."
                  className="h-12 text-base font-mono"
                  disabled={scanMutation.isPending}
                  autoComplete="off"
                  
                  autoFocus
                />
              </div>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setShowScanner(true)}
                className="h-12 w-12 shrink-0"
              >
                <Camera className="h-5 w-5" />
              </Button>
              <Button
                onClick={() => barcode.onKeyDown({ key: "Enter", preventDefault: () => {} } as any)}
                disabled={!barcode.value.trim() || scanMutation.isPending}
                className="h-12 px-4 bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
              >
                {scanMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Último resultado de bipagem */}
        {lastScanResult && (
          <Card className={`border-2 ${lastScanResult.isExcess ? "border-red-400 bg-red-50" : "border-green-400 bg-green-50"}`}>
            <CardContent className="pt-3 pb-3">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{lastScanResult.productName}</p>
                  <p className="text-xs text-gray-600 font-mono">{lastScanResult.productSku}</p>
                  {lastScanResult.batch && (
                    <p className="text-xs text-gray-500">Lote: {lastScanResult.batch}</p>
                  )}
                </div>
                <div className="text-right ml-3 shrink-0">
                  <p className={`text-lg font-bold ${lastScanResult.isExcess ? "text-red-600" : "text-green-600"}`}>
                    {lastScanResult.currentTotal}/{lastScanResult.totalExpected}
                  </p>
                  <p className="text-xs text-gray-500">un. bipadas/esperadas</p>
                </div>
              </div>
              {lastScanResult.isExcess && (
                <div className="mt-2 flex items-center gap-1 text-red-600 text-xs">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span>Quantidade excedente no agrupamento!</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Botões de Ação */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => undoMutation.mutate({ groupId })}
            disabled={!canUndo || undoMutation.isPending}
            className="flex-1 h-11 border-orange-300 text-orange-700 hover:bg-orange-50"
          >
            {undoMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Undo2 className="h-4 w-4 mr-2" />}
            Desfazer
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowItemsDetail(!showItemsDetail)}
            className="flex-1 h-11"
          >
            <Package className="h-4 w-4 mr-2" />
            {showItemsDetail ? "Ocultar" : "Ver Itens"}
            {showItemsDetail ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
          </Button>
        </div>

        {/* Lista de Itens Consolidados */}
        {showItemsDetail && (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs py-2">SKU / Produto</TableHead>
                      <TableHead className="text-xs py-2 text-center">Lote</TableHead>
                      <TableHead className="text-xs py-2 text-right">Bipado</TableHead>
                      <TableHead className="text-xs py-2 text-right">Esperado</TableHead>
                      <TableHead className="text-xs py-2 text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {consolidatedItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-gray-400 py-4 text-sm">
                          Nenhum item encontrado
                        </TableCell>
                      </TableRow>
                    ) : (
                      consolidatedItems.map((item, idx) => (
                        <TableRow key={`${item.productId}-${item.batch ?? ""}-${idx}`}
                          className={item.isExcess ? "bg-red-50" : item.isComplete ? "bg-green-50" : ""}
                        >
                          <TableCell className="py-2">
                            <p className="font-mono text-xs font-medium">{item.productSku}</p>
                            <p className="text-xs text-gray-500 truncate max-w-[120px]">{item.productName}</p>
                          </TableCell>
                          <TableCell className="py-2 text-center text-xs font-mono">
                            {item.batch || "-"}
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm font-semibold">
                            <span className={item.isExcess ? "text-red-600" : item.isComplete ? "text-green-600" : ""}>
                              {item.unitsRead}
                            </span>
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm">{item.totalExpected}</TableCell>
                          <TableCell className="py-2 text-center">
                            {item.isExcess ? (
                              <Badge className="bg-red-500 text-white text-xs px-1">Excesso</Badge>
                            ) : item.isComplete ? (
                              <Badge className="bg-green-500 text-white text-xs px-1">OK</Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs px-1">
                                -{item.pendingUnits}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Botões Finalizar / Cancelar */}
        <div className="flex gap-2 mt-2">
          <Button
            variant="outline"
            onClick={() => setShowCancelConfirm(true)}
            className="flex-1 h-12 border-red-300 text-red-600 hover:bg-red-50"
          >
            <X className="h-4 w-4 mr-2" />
            Cancelar
          </Button>
          <Button
            onClick={() => setShowConfirmFinish(true)}
            disabled={totalRead === 0}
            className="flex-1 h-12 bg-green-600 hover:bg-green-700 text-white"
          >
            <Check className="h-4 w-4 mr-2" />
            Finalizar
          </Button>
        </div>

        {/* Alerta de excesso antes de finalizar */}
        {hasExcess && (
          <Card className="border-red-300 bg-red-50">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700">
                  Um ou mais SKUs foram bipados em quantidade superior ao total das NFs agrupadas.
                  Verifique os itens marcados em vermelho antes de finalizar.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Scanner de câmera */}
        {showScanner && (
          <BarcodeScanner
            onScan={(code) => {
              setShowScanner(false);
              handleScan(code);
            }}
            onClose={() => setShowScanner(false)}
          />
        )}

        {/* ── Dialog: Vincular Etiqueta Não Cadastrada ─────────────────────── */}
        <Dialog open={showNewLabelDialog} onOpenChange={(open) => {
          if (!open) {
            setShowNewLabelDialog(false);
            setNewLabelForm(EMPTY_FORM);
            setProductSearch("");
            barcode.focus();
          }
        }}>
          <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Tag className="h-5 w-5 text-amber-500" />
                Etiqueta Não Cadastrada
              </DialogTitle>
              <DialogDescription>
                A etiqueta <span className="font-mono font-semibold text-gray-800">{newLabelForm.labelCode}</span> não
                está cadastrada. Informe os dados do produto para vinculá-la.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">

              {/* Busca de produto */}
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-700">Produto *</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    value={productSearch}
                    onChange={(e) => {
                      setProductSearch(e.target.value);
                      // Limpar seleção ao digitar novamente
                      if (newLabelForm.productId) {
                        setNewLabelForm(f => ({ ...f, productId: null, productSku: "", productName: "" }));
                      }
                    }}
                    placeholder="Digite SKU ou descrição..."
                    className="pl-9 h-10 text-sm"
                  />
                </div>

                {/* Resultados da busca */}
                {!newLabelForm.productId && productSearch.trim().length >= 2 && (
                  <div className="border rounded-md bg-white shadow-sm max-h-40 overflow-y-auto">
                    {isSearchingProducts ? (
                      <div className="p-3 text-center text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                        Buscando...
                      </div>
                    ) : Array.isArray(productSearchResults) && productSearchResults.length > 0 ? (
                      (productSearchResults as Array<{ id: number; sku: string; description: string; unitsPerBox?: number | null }>).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleSelectProduct(p)}
                          className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b last:border-0 transition-colors"
                        >
                          <p className="font-mono text-xs font-semibold text-indigo-700">{p.sku}</p>
                          <p className="text-xs text-gray-600 truncate">{p.description}</p>
                        </button>
                      ))
                    ) : (
                      <div className="p-3 text-center text-sm text-gray-400">
                        Nenhum produto encontrado
                      </div>
                    )}
                  </div>
                )}

                {/* Produto selecionado */}
                {newLabelForm.productId && (
                  <div className="flex items-center gap-2 p-2 bg-indigo-50 rounded-md border border-indigo-200">
                    <Check className="h-4 w-4 text-indigo-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-xs font-semibold text-indigo-700">{newLabelForm.productSku}</p>
                      <p className="text-xs text-gray-600 truncate">{newLabelForm.productName}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setNewLabelForm(f => ({ ...f, productId: null, productSku: "", productName: "" }));
                        setProductSearch("");
                      }}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Lote */}
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-700">Lote</Label>
                <Input
                  value={newLabelForm.batch}
                  onChange={(e) => setNewLabelForm(f => ({ ...f, batch: e.target.value }))}
                  placeholder="Ex: LOT-2024-001"
                  className="h-10 text-sm font-mono"
                />
              </div>

              {/* Validade */}
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-700">Validade</Label>
                <Input
                  type="date"
                  value={newLabelForm.expiryDate}
                  onChange={(e) => setNewLabelForm(f => ({ ...f, expiryDate: e.target.value }))}
                  className="h-10 text-sm"
                />
              </div>

              {/* Qtd por Caixa */}
              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-700">Qtd por Caixa *</Label>
                <Input
                  type="number"
                  min={1}
                  value={newLabelForm.unitsPerBox}
                  onChange={(e) => setNewLabelForm(f => ({ ...f, unitsPerBox: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="h-10 text-sm"
                />
              </div>

            </div>

            <DialogFooter className="flex gap-2 mt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowNewLabelDialog(false);
                  setNewLabelForm(EMPTY_FORM);
                  setProductSearch("");
                  barcode.focus();
                }}
                className="flex-1"
                disabled={registerNewLabelMutation.isPending}
              >
                Cancelar
              </Button>
              <Button
                onClick={handleConfirmNewLabel}
                disabled={!newLabelForm.productId || registerNewLabelMutation.isPending}
                className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {registerNewLabelMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Vinculando...</>
                ) : (
                  <><Tag className="h-4 w-4 mr-2" />Vincular e Bipar</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Modal de Confirmação de Finalização */}
        <Dialog open={showConfirmFinish} onOpenChange={setShowConfirmFinish}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Finalizar Conferência Agrupada</DialogTitle>
              <DialogDescription>
                Confirme os dados antes de finalizar. Esta ação não pode ser desfeita.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {/* Resumo por NF */}
              <div className="rounded-lg border p-3 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600 mb-2">NFs incluídas:</p>
                {orders.map(o => (
                  <div key={o.receivingOrderId} className="flex justify-between text-xs py-1 border-b last:border-0">
                    <span className="font-mono">NF {o.nfeNumber || o.orderNumber}</span>
                    <Badge variant="outline" className="text-xs">Agendado → Recebido</Badge>
                  </div>
                ))}
              </div>
              {/* Totais */}
              <div className="rounded-lg border p-3 bg-gray-50">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total bipado:</span>
                  <span className="font-bold">{totalRead} un.</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total esperado:</span>
                  <span className="font-bold">{totalExpected} un.</span>
                </div>
                {totalRead !== totalExpected && (
                  <div className="mt-2 flex items-center gap-1 text-orange-600 text-xs">
                    <AlertTriangle className="h-3 w-3" />
                    <span>
                      {totalRead < totalExpected
                        ? `Divergência: ${totalExpected - totalRead} un. não bipadas`
                        : `Excesso: ${totalRead - totalExpected} un. a mais`}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="flex gap-2 mt-2">
              <Button variant="outline" onClick={() => setShowConfirmFinish(false)} className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white flex-1">
                Revisar
              </Button>
              <Button
                onClick={() => finalizeMutation.mutate({ groupId })}
                disabled={finalizeMutation.isPending}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white"
              >
                {finalizeMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Finalizando...</>
                ) : (
                  <><Check className="h-4 w-4 mr-2" />Confirmar</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Modal de Confirmação de Cancelamento */}
        <Dialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Cancelar Conferência Agrupada</DialogTitle>
              <DialogDescription>
                Todas as bipagens serão descartadas e as NFs retornarão ao status "Agendado".
                Tem certeza?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex gap-2 mt-2">
              <Button variant="outline" onClick={() => setShowCancelConfirm(false)} className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white flex-1">
                Não, continuar
              </Button>
              <Button
                variant="destructive"
                onClick={() => cancelMutation.mutate({ groupId })}
                disabled={cancelMutation.isPending}
                className="flex-1"
              >
                {cancelMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Cancelando...</>
                ) : (
                  <><X className="h-4 w-4 mr-2" />Cancelar Conferência</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Dialog de Caixa Fracionada */}
        <Dialog
          open={showFractionalDialog}
          onOpenChange={(open) => {
            if (!open) {
              setShowFractionalDialog(false);
              setFractionalQty("");
              barcode.focus();
            }
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Scissors className="w-5 h-5 text-amber-500" />
                Caixa Fracionada?
              </DialogTitle>
              <DialogDescription>
                Esta caixa possui <strong>{fractionalUnitsPerBox} unidades</strong> completas.
                Se a caixa estiver aberta (fracionada), informe a quantidade real.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-sm font-medium">Quantidade real na caixa</Label>
                <Input
                  type="number"
                  value={fractionalQty}
                  onChange={(e) => setFractionalQty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const qty = parseInt(fractionalQty);
                      if (qty > 0 && qty < fractionalUnitsPerBox && groupId && fractionalLabelCode) {
                        correctFractionalMutation.mutate({ groupId, labelCode: fractionalLabelCode, fractionalQty: qty });
                      }
                    }
                  }}
                  placeholder={`Máx: ${fractionalUnitsPerBox}`}
                  min="1"
                  max={fractionalUnitsPerBox - 1}
                  className="h-12 text-lg text-center mt-1"
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">Deve ser menor que {fractionalUnitsPerBox} (quantidade da caixa cheia)</p>
              </div>
            </div>
            <DialogFooter className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 h-12"
                onClick={() => {
                  setShowFractionalDialog(false);
                  setFractionalQty("");
                  barcode.focus();
                }}
              >
                Caixa Cheia ({fractionalUnitsPerBox} un.)
              </Button>
              <Button
                className="flex-1 h-12 bg-amber-500 hover:bg-amber-600"
                disabled={!fractionalQty || parseInt(fractionalQty) <= 0 || parseInt(fractionalQty) >= fractionalUnitsPerBox || correctFractionalMutation.isPending}
                onClick={() => {
                  const qty = parseInt(fractionalQty);
                  if (qty > 0 && qty < fractionalUnitsPerBox && groupId && fractionalLabelCode) {
                    correctFractionalMutation.mutate({ groupId, labelCode: fractionalLabelCode, fractionalQty: qty });
                  }
                }}
              >
                {correctFractionalMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <><Scissors className="w-4 h-4 mr-1" /> Fracionada</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
    </CollectorLayout>
  );
}
