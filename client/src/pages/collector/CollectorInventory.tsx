/**
 * CollectorInventory.tsx
 * Fluxo conforme especificação seção 4:
 *  1. Selecionar inventário (pending/in_progress)
 *  2. Tela principal: mostra próximo endereço da fila + campo scan do endereço
 *  3. Validação: código bipado deve corresponder ao endereço esperado
 *  4. Contagem de volumes: bipa etiquetas uma a uma (incrementa contador)
 *  5. Finalizar contagem → análise de divergências
 *  6. Sem divergência → próximo endereço (auto após 2s)
 *  7. Com divergência → recontagem automática; após 2 contagens iguais → registrar sobra/falta
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { CollectorLayout } from "../../components/CollectorLayout";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import {
  ClipboardList,
  ScanLine,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  ChevronRight,
  Package,
  Loader2,
  ArrowLeft,
  MapPin,
  TrendingUp,
  TrendingDown,
  Tag,
  Search,
} from "lucide-react";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Step =
  | "select-inventory"   // 1. Escolher inventário
  | "scan-address"       // 2. Mostrar próximo endereço + campo scan
  | "count-volumes"      // 3. Bipar volumes
  | "divergence"         // 4. Divergência detectada → recontagem ou registrar
  | "done-location";     // 5. Endereço concluído (sem divergência)

interface CountedItem {
  productId: number;
  productSku: string | null;
  productDescription: string | null;
  batch: string | null;
  expiryDate: string | null;
  expectedQuantity: number;
  countedQuantity: number; // incrementado a cada bipe
  labelCode: string | null;
  tenantId?: number | null;
}

interface DivergenceResult {
  hasDivergence: boolean;
  attemptNumber: number;
  counts: {
    productId: number;
    productSku?: string;
    productDescription?: string;
    batch?: string;
    expiryDate?: string;
    expectedQuantity: number;
    countedQuantity: number;
  }[];
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function CollectorInventory() {
  // ── Navegação ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>("select-inventory");
  const [selectedInventoryId, setSelectedInventoryId] = useState<number | null>(null);
  const [selectedInventoryNumber, setSelectedInventoryNumber] = useState<string>("");

  // ── Endereço atual ─────────────────────────────────────────────────────────
  const [invLocId, setInvLocId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [locationCode, setLocationCode] = useState<string>("");
  const [addressInput, setAddressInput] = useState<string>("");
  const [addressError, setAddressError] = useState<string>("");

  // ── Contagem de volumes ────────────────────────────────────────────────────
  const [countedItems, setCountedItems] = useState<CountedItem[]>([]);
  const [volumeInput, setVolumeInput] = useState<string>("");
  const [volumeError, setVolumeError] = useState<string>("");
  const [attemptNumber, setAttemptNumber] = useState<number>(1);
  const [lastDivergence, setLastDivergence] = useState<DivergenceResult | null>(null);
  const [prevAttemptCounts, setPrevAttemptCounts] = useState<DivergenceResult["counts"] | null>(null);
  const [confirmEmptyOpen, setConfirmEmptyOpen] = useState(false);

  // ── Associação de etiqueta (quando found:false e não é wrongLocation) ────────
  const [labelAssocOpen, setLabelAssocOpen] = useState(false);
  const [pendingLabelCode, setPendingLabelCode] = useState<string>("");
  const [labelProductSearch, setLabelProductSearch] = useState<string>("");
  const [labelSelectedProduct, setLabelSelectedProduct] = useState<{ id: number; sku: string | null; description: string | null } | null>(null);
  const [labelBatch, setLabelBatch] = useState<string>("");
  const [labelExpiryDate, setLabelExpiryDate] = useState<string>("");
  const [labelUnitsPerBox, setLabelUnitsPerBox] = useState<number>(1);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const addressRef = useRef<HTMLInputElement>(null);
  const volumeRef = useRef<HTMLInputElement>(null);
  const addressDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utils = trpc.useUtils();

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: activeInventories, isLoading: loadingInventories } =
    trpc.inventoryMgmt.listActiveForCollector.useQuery({});

  const { data: nextLocData, isLoading: loadingNext, refetch: refetchNext } =
    trpc.inventoryMgmt.getNextLocation.useQuery(
      { inventoryId: selectedInventoryId! },
      { enabled: !!selectedInventoryId && step === "scan-address" }
    );

  const { data: locationStock, isLoading: loadingStock } =
    trpc.inventoryMgmt.getLocationStock.useQuery(
      { inventoryId: selectedInventoryId!, locationId: locationId! },
      { enabled: !!selectedInventoryId && !!locationId && step === "count-volumes" }
    );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const scanVolumeMutation = trpc.inventoryMgmt.scanVolume.useMutation();
  const associateLabelMutation = trpc.inventoryMgmt.associateLabelForInventory.useMutation();

  // Busca de produtos para associação de etiqueta (debounced)
  const { data: productSearchResults, isLoading: searchingProducts } =
    trpc.inventoryMgmt.searchProductsForLabel.useQuery(
      { query: labelProductSearch },
      { enabled: labelProductSearch.length >= 2 }
    );

  const markEmptyMutation = trpc.inventoryMgmt.markLocationEmpty.useMutation({
    onSuccess: (data) => {
      setConfirmEmptyOpen(false);
      if (!data.hasDivergence) {
        // Endereço realmente vazio — avança direto
        setStep("done-location");
        setTimeout(() => advanceToNextLocation(), 2000);
      } else {
        // Havia saldo esperado — gera divergência de falta total
        const divergence: DivergenceResult = {
          hasDivergence: true,
          attemptNumber,
          counts: data.expectedItems.map((item) => ({
            productId: item.productId,
            productSku: item.productSku ?? undefined,
            batch: item.batch ?? undefined,
            expectedQuantity: item.expectedQuantity,
            countedQuantity: 0,
          })),
        };
        setLastDivergence(divergence);
        setStep("divergence");
      }
    },
    onError: (err) => {
      setConfirmEmptyOpen(false);
      toast.error(err.message);
    },
  });

  const handleMarkEmpty = () => {
    if (!selectedInventoryId || !invLocId || !locationId) return;
    markEmptyMutation.mutate({
      inventoryId: selectedInventoryId,
      inventoryLocationId: invLocId,
      locationId,
      locationCode,
      attemptNumber,
    });
  };

  const finishCountMutation = trpc.inventoryMgmt.finishLocationCount.useMutation({
    onSuccess: (data) => {
      if (!data.hasDivergence) {
        setStep("done-location");
        setTimeout(() => advanceToNextLocation(), 2000);
      } else {
        setLastDivergence(data);
        setStep("divergence");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const resolveMutation = trpc.inventoryMgmt.resolveDivergence.useMutation({
    onSuccess: (data) => {
      const msgs = data.results.map((r) =>
        r.orderNumber ? `OM ${r.orderNumber} criada` : `Movido para ${r.falLocation}`
      );
      toast.success(msgs.join(" | ") || "Divergência registrada");
      advanceToNextLocation();
    },
    onError: (err) => toast.error(err.message),
  });

  // ── Efeito: preencher countedItems com saldo esperado ao entrar em count-volumes
  useEffect(() => {
    if (!locationStock || step !== "count-volumes") return;
    // Só preenche na 1ª tentativa; nas recontagens, reseta para zero
    const rows: CountedItem[] = locationStock.stockRows.map((s) => ({
      productId: s.productId,
      productSku: s.productSku ?? null,
      productDescription: s.productDescription ?? null,
      batch: s.batch ?? null,
      expiryDate: s.expiryDate ?? null,
      expectedQuantity: s.quantity,
      countedQuantity: 0, // começa em zero — operador bipa para incrementar
      labelCode: s.labelCode ?? null,
    }));
    setCountedItems(rows);
  }, [locationStock, step]);

  // ── Focar inputs automaticamente ──────────────────────────────────────────
  useEffect(() => {
    if (step === "scan-address") setTimeout(() => addressRef.current?.focus(), 150);
    if (step === "count-volumes") setTimeout(() => volumeRef.current?.focus(), 150);
    // Limpar debounces ao trocar de step
    return () => {
      if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
    };
  }, [step]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const advanceToNextLocation = useCallback(() => {
    setInvLocId(null);
    setLocationId(null);
    setLocationCode("");
    setAddressInput("");
    setAddressError("");
    setCountedItems([]);
    setVolumeInput("");
    setVolumeError("");
    setAttemptNumber(1);
    setLastDivergence(null);
    setPrevAttemptCounts(null);
    setStep("scan-address");
    refetchNext();
  }, [refetchNext]);

  const handleSelectInventory = (id: number, number: string) => {
    setSelectedInventoryId(id);
    setSelectedInventoryNumber(number);
    setStep("scan-address");
  };

  // Valida o endereço bipado contra o próximo esperado
  const handleScanAddress = () => {
    if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
    const code = addressInput.trim().toUpperCase();
    if (!code) return;
    const expected = nextLocData?.nextLocation?.locationCode?.toUpperCase();
    if (!expected) {
      toast.error("Nenhum endereço pendente neste inventário");
      return;
    }
    if (code !== expected) {
      setAddressError(`Endereço incorreto! Esperado: ${expected} | Lido: ${code}`);
      setAddressInput("");
      addressRef.current?.focus();
      return;
    }
    // Correto
    setAddressError("");
    setInvLocId(Number(nextLocData!.nextLocation!.id));
    setLocationId(Number(nextLocData!.nextLocation!.locationId));
    setLocationCode(nextLocData!.nextLocation!.locationCode);
    setStep("count-volumes");
  };

  // Wrapper para Enter/botão: lê o estado atual e delega
  const handleScanVolume = () => {
    if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
    const code = volumeInput.trim();
    if (code) handleScanVolumeWithCode(code);
  };

  // Bipa volume: lógica central que recebe o código já capturado
  const handleScanVolumeWithCode = async (code: string) => {
    if (!code || !selectedInventoryId || !invLocId || !locationId) return;
    setVolumeInput("");
    setVolumeError("");

    try {
      const result = await scanVolumeMutation.mutateAsync({
        inventoryId: Number(selectedInventoryId),
        inventoryLocationId: Number(invLocId),
        locationId: Number(locationId),
        labelCode: code,
      });

      if (!result.found) {
        if (result.wrongLocation) {
          setVolumeError(`⚠️ Produto ${result.product?.productSku ?? ""} pertence a outro endereço`);
          setTimeout(() => volumeRef.current?.focus(), 50);
        } else {
          // Etiqueta sem labelAssociation — abrir modal para associar
          setPendingLabelCode(code);
          setLabelProductSearch("");
          setLabelSelectedProduct(null);
          setLabelBatch("");
          setLabelExpiryDate("");
          setLabelUnitsPerBox(1);
          setLabelAssocOpen(true);
        }
        return;
      }

            const p = result.product as { productId: number; productSku: string | null; productDescription: string | null; batch: string | null; expiryDate: string | null; expectedQuantity: number; labelCode: string | null; uniqueCode: string | null };
      const qty = result.unitsPerBox ?? 1; // quantidade real por etiqueta
      setCountedItems((prev) => {
        const idx = prev.findIndex(
          (r) => r.productId === p.productId && r.batch === p.batch
        );
        if (idx >= 0) {
          return prev.map((r, i) =>
            i === idx ? { ...r, countedQuantity: r.countedQuantity + qty } : r
          );
        }
        // Produto não estava no saldo esperado (sobra nova)
        return [
          ...prev,
          {
            productId: p.productId,
            productSku: p.productSku ?? null,
            productDescription: p.productDescription ?? null,
            batch: p.batch ?? null,
            expiryDate: p.expiryDate ?? null,
            expectedQuantity: 0,
            countedQuantity: qty,
            labelCode: p.labelCode ?? null,
          },
        ];
      });

      // Feedback visual com a quantidade adicionada
      if (qty > 1) {
        toast.success(`+${qty} un. — ${p.productSku ?? p.productDescription ?? "Produto"}`, { duration: 1500 });
      }
    } catch (err: any) {
      setVolumeError(err.message ?? "Erro ao processar volume");
    }
    // Foca o input após o re-render para aguardar a próxima leitura
    setTimeout(() => volumeRef.current?.focus(), 50);
  };

  // Finaliza contagem do endereço
  const handleFinishCount = () => {
    if (!selectedInventoryId || !invLocId || !locationId) return;
    finishCountMutation.mutate({
      inventoryId: selectedInventoryId,
      inventoryLocationId: invLocId,
      locationId,
      locationCode,
      attemptNumber,
      counts: countedItems.map((r) => ({
        productId: r.productId,
        productSku: r.productSku ?? undefined,
        productDescription: r.productDescription ?? undefined,
        batch: r.batch ?? undefined,
        expiryDate: r.expiryDate ?? undefined,
        expectedQuantity: r.expectedQuantity,
        countedQuantity: r.countedQuantity,
      })),
    });
  };

  // Inicia recontagem: reseta contadores, incrementa tentativa
  const handleStartRecount = () => {
    setPrevAttemptCounts(lastDivergence?.counts ?? null);
    setAttemptNumber((n) => n + 1);
    setCountedItems((prev) => prev.map((r) => ({ ...r, countedQuantity: 0 })));
    setVolumeInput("");
    setVolumeError("");
    setLastDivergence(null);
    setStep("count-volumes");
  };

  // Registra divergência (sobra ou falta)
  const handleRegisterDivergence = (action: "surplus" | "shortage") => {
    if (!selectedInventoryId || !invLocId || !locationId || !lastDivergence) return;
    const divergentItems = lastDivergence.counts.filter(
      (c) => c.countedQuantity !== c.expectedQuantity
    );
    resolveMutation.mutate({
      inventoryId: selectedInventoryId,
      inventoryLocationId: invLocId,
      locationId,
      locationCode,
      action,
      items: divergentItems.map((c) => ({
        productId: c.productId,
        productSku: c.productSku,
        productDescription: c.productDescription,
        batch: c.batch,
        expiryDate: c.expiryDate,
        expectedQuantity: c.expectedQuantity,
        countedQuantity: c.countedQuantity,
      })),
    });
  };

  // ── Dados de progresso ─────────────────────────────────────────────────────
  const selectedInventory = activeInventories?.find((i) => i.id === selectedInventoryId);
  const progress = selectedInventory
    ? Math.round(((selectedInventory.countedLocations ?? 0) / (selectedInventory.totalLocations || 1)) * 100)
    : 0;

  const atLeastOneScanned = countedItems.some((r) => r.countedQuantity > 0);

  // ── Análise de divergência para exibição ──────────────────────────────────
  const divergentItems = lastDivergence?.counts.filter(
    (c) => c.countedQuantity !== c.expectedQuantity
  ) ?? [];
  const isSurplus = divergentItems.some((c) => c.countedQuantity > c.expectedQuantity);
  const isShortage = divergentItems.some((c) => c.countedQuantity < c.expectedQuantity);

  // Verifica se 2 contagens consecutivas tiveram o mesmo resultado (permite registrar)
  const canRegister = prevAttemptCounts !== null && lastDivergence !== null &&
    lastDivergence.counts.every((c) => {
      const prev = prevAttemptCounts.find(
        (p) => p.productId === c.productId && p.batch === c.batch
      );
      return prev && prev.countedQuantity === c.countedQuantity;
    });

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <CollectorLayout title="Inventário">
      <div className="flex flex-col gap-4 p-4 max-w-lg mx-auto">

        {/* ── 1. Selecionar inventário ───────────────────────────────────────── */}
        {step === "select-inventory" && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <ClipboardList className="h-5 w-5 text-teal-600" />
              <h2 className="text-lg font-semibold">Selecionar Inventário</h2>
            </div>

            {loadingInventories && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loadingInventories && (!activeInventories || activeInventories.length === 0) && (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  <ClipboardList className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="font-medium">Nenhum inventário em andamento</p>
                  <p className="text-xs mt-1">Aguarde a criação de um inventário pelo gestor.</p>
                </CardContent>
              </Card>
            )}

            {activeInventories?.map((inv) => {
              const pct = Math.round(((inv.countedLocations ?? 0) / (inv.totalLocations || 1)) * 100);
              return (
                <Card
                  key={inv.id}
                  className="cursor-pointer hover:border-teal-500 transition-colors"
                  onClick={() => handleSelectInventory(inv.id, inv.inventoryNumber)}
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-base">{inv.inventoryNumber}</p>
                        <p className="text-sm text-muted-foreground capitalize">
                          {inv.type === "cyclic" ? "Cíclico" : "Geral"}
                        </p>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>{inv.countedLocations ?? 0} / {inv.totalLocations} endereços</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div className="bg-teal-500 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </>
        )}

        {/* ── 2. Tela principal: próximo endereço + scan ────────────────────── */}
        {step === "scan-address" && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <Button variant="ghost" size="sm" className="p-0 h-auto" onClick={() => setStep("select-inventory")}>
                <ArrowLeft className="h-4 w-4 mr-1" />
                Voltar
              </Button>
            </div>

            {/* Progresso */}
            {selectedInventory && (
              <Card className="border-teal-200 bg-teal-50/50">
                <CardContent className="py-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-teal-800">{selectedInventoryNumber}</span>
                    <span className="text-teal-700">{progress}%</span>
                  </div>
                  <div className="w-full bg-teal-100 rounded-full h-2">
                    <div className="bg-teal-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-xs text-teal-600 mt-1">
                    {selectedInventory.countedLocations ?? 0} / {selectedInventory.totalLocations} endereços contados
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Próximo endereço */}
            <Card className="border-2 border-dashed border-teal-400">
              <CardContent className="py-5">
                <div className="flex items-center gap-2 mb-3">
                  <MapPin className="h-5 w-5 text-teal-600" />
                  <span className="font-semibold text-base">Próximo Endereço:</span>
                </div>

                {loadingNext && (
                  <div className="flex items-center gap-2 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Carregando...</span>
                  </div>
                )}

                {!loadingNext && !nextLocData?.nextLocation && (
                  <div className="text-center py-4">
                    <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
                    <p className="font-semibold text-green-700">Todos os endereços contados!</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {nextLocData?.countedLocations} / {nextLocData?.totalLocations} endereços
                    </p>
                  </div>
                )}

                {!loadingNext && nextLocData?.nextLocation && (
                  <>
                    <p className="text-3xl font-mono font-bold text-center text-teal-700 py-2">
                      {nextLocData.nextLocation.locationCode}
                    </p>
                    <p className="text-xs text-center text-muted-foreground mb-4">
                      ⚠️ Aguardando leitura...
                    </p>

                    <div className="flex gap-2">
                  <Input
                    ref={addressRef}
                    value={addressInput}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase();
                      setAddressInput(val);
                      setAddressError("");
                      // Auto-submit: dispara 300ms após parar de digitar (leitora de código de barras)
                      if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
                      if (val.trim()) {
                        addressDebounceRef.current = setTimeout(() => {
                          handleScanAddress();
                        }, 300);
                      }
                    }}
                    onKeyDown={(e) => e.key === "Enter" && handleScanAddress()}
                    placeholder="Escanear endereço..."
                    className="font-mono text-lg"
                    autoComplete="off"
                    autoCapitalize="characters"
                  />
                      <Button onClick={handleScanAddress} className="bg-teal-600 hover:bg-teal-700">
                        <ScanLine className="h-4 w-4" />
                      </Button>
                    </div>

                    {addressError && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        {addressError}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* ── 3. Contagem de volumes ─────────────────────────────────────────── */}
        {step === "count-volumes" && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <Button variant="ghost" size="sm" className="p-0 h-auto" onClick={() => setStep("scan-address")}>
                <ArrowLeft className="h-4 w-4 mr-1" />
                Outro endereço
              </Button>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-mono">{locationCode}</CardTitle>
                  {attemptNumber > 1 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-400">
                      Recontagem #{attemptNumber}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{selectedInventoryNumber}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {/* Campo de scan de volume */}
                <div className="flex gap-2">
                  <Input
                    ref={volumeRef}
                    value={volumeInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setVolumeInput(val);
                      setVolumeError("");
                      // Auto-submit: dispara 300ms após parar de digitar (leitora de código de barras)
                      // Passa o valor capturado diretamente para evitar leitura de estado stale
                      if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
                      if (val.trim()) {
                        volumeDebounceRef.current = setTimeout(() => {
                          handleScanVolumeWithCode(val.trim());
                        }, 300);
                      }
                    }}
                    onKeyDown={(e) => e.key === "Enter" && handleScanVolume()}
                    placeholder="Escanear volume..."
                    className="font-mono"
                    autoComplete="off"
                    disabled={scanVolumeMutation.isPending}
                  />
                  <Button
                    onClick={handleScanVolume}
                    className="bg-teal-600 hover:bg-teal-700"
                    disabled={scanVolumeMutation.isPending}
                  >
                    {scanVolumeMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <ScanLine className="h-4 w-4" />
                    }
                  </Button>
                </div>

                {volumeError && (
                  <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {volumeError}
                  </div>
                )}

                {/* Produtos esperados */}
                {loadingStock && (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!loadingStock && countedItems.length === 0 && (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    <p>Endereço vazio no sistema.</p>
                    <p className="text-xs mt-1">Bipe volumes para registrar sobra.</p>
                  </div>
                )}

                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Produtos Esperados:
                </p>

                {countedItems.map((row, i) => {
                  const ok = row.countedQuantity === row.expectedQuantity;
                  const pending = row.countedQuantity < row.expectedQuantity;
                  return (
                    <div
                      key={i}
                      className={`border rounded-lg p-3 ${
                        ok ? "border-green-400 bg-green-50/50" :
                        row.countedQuantity > row.expectedQuantity ? "border-amber-400 bg-amber-50/50" :
                        "border-border"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {row.productDescription ?? row.productSku ?? "Produto desconhecido"}
                          </p>
                          {row.productSku && (
                            <p className="text-xs text-muted-foreground font-mono">{row.productSku}</p>
                          )}
                          {row.batch && (
                            <p className="text-xs text-muted-foreground">Lote: {row.batch}</p>
                          )}
                        </div>
                        {ok && <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />}
                        {!ok && pending && <span className="text-xs text-muted-foreground">⏳</span>}
                        {!ok && !pending && <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-sm">
                        <span className="text-muted-foreground">
                          Esperado: <strong>{row.expectedQuantity}</strong>
                        </span>
                        <span className={ok ? "text-green-700 font-bold" : "text-amber-700 font-bold"}>
                          Contado: {row.countedQuantity}
                        </span>
                      </div>
                    </div>
                  );
                })}

                <Button
                  className="w-full bg-teal-600 hover:bg-teal-700 mt-2"
                  onClick={handleFinishCount}
                  disabled={!atLeastOneScanned || finishCountMutation.isPending || markEmptyMutation.isPending}
                >
                  {finishCountMutation.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    : <CheckCircle2 className="h-4 w-4 mr-2" />
                  }
                  Finalizar Contagem
                </Button>

                <Button
                  variant="outline"
                  className="w-full border-orange-400 text-orange-600 hover:bg-orange-50"
                  onClick={() => setConfirmEmptyOpen(true)}
                  disabled={finishCountMutation.isPending || markEmptyMutation.isPending}
                >
                  <Package className="h-4 w-4 mr-2" />
                  Registrar como Vazio
                </Button>
              </CardContent>
            </Card>
          </>
        )}

        {/* ── 4. Divergência detectada ───────────────────────────────────────── */}
        {step === "divergence" && lastDivergence && (
          <Card className="border-2 border-amber-400">
            <CardContent className="py-5 flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-6 w-6 text-amber-500" />
                <p className="text-lg font-semibold text-amber-700">Divergência Detectada</p>
              </div>

              <p className="text-sm text-muted-foreground">
                Endereço: <span className="font-mono font-semibold">{locationCode}</span>
                {" "}— Tentativa {lastDivergence.attemptNumber}
              </p>

              {/* Detalhes por produto */}
              {divergentItems.map((c, i) => {
                const variance = c.countedQuantity - c.expectedQuantity;
                const isSurplusItem = variance > 0;
                return (
                  <div key={i} className="border rounded-lg p-3 bg-amber-50">
                    <p className="font-medium text-sm">{c.productDescription ?? c.productSku}</p>
                    {c.batch && <p className="text-xs text-muted-foreground">Lote: {c.batch}</p>}
                    <div className="flex gap-4 mt-1 text-sm">
                      <span>Esperado: <strong>{c.expectedQuantity}</strong></span>
                      <span>Contado: <strong>{c.countedQuantity}</strong></span>
                      <span className={isSurplusItem ? "text-amber-700 font-bold" : "text-red-700 font-bold"}>
                        {isSurplusItem ? `+${variance}` : variance}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Se 2 contagens iguais → pode registrar */}
              {canRegister ? (
                <>
                  <p className="text-sm font-semibold text-amber-700">
                    {isSurplus && isShortage ? "⚠️ Sobra e Falta confirmadas" :
                     isSurplus ? "⚠️ Sobra Confirmada (2 contagens)" :
                     "⚠️ Falta Confirmada (2 contagens)"}
                  </p>
                  <p className="text-xs text-muted-foreground">Escolha uma ação:</p>
                  <div className="flex flex-col gap-2">
                    {isSurplus && (
                      <Button
                        className="w-full bg-amber-500 hover:bg-amber-600"
                        onClick={() => handleRegisterDivergence("surplus")}
                        disabled={resolveMutation.isPending}
                      >
                        {resolveMutation.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          : <TrendingUp className="h-4 w-4 mr-2" />
                        }
                        Registrar Sobra
                      </Button>
                    )}
                    {isShortage && (
                      <Button
                        className="w-full bg-red-500 hover:bg-red-600"
                        onClick={() => handleRegisterDivergence("shortage")}
                        disabled={resolveMutation.isPending}
                      >
                        {resolveMutation.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          : <TrendingDown className="h-4 w-4 mr-2" />
                        }
                        Registrar Falta
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={handleStartRecount}
                      disabled={resolveMutation.isPending}
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Nova Contagem
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {prevAttemptCounts !== null && (
                    <div className="text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded p-2">
                      <p className="font-semibold mb-1">Nova Divergência:</p>
                      {divergentItems.map((c, i) => {
                        const prev = prevAttemptCounts.find(
                          (p) => p.productId === c.productId && p.batch === c.batch
                        );
                        return (
                          <p key={i}>
                            {c.productSku}: {prev?.countedQuantity ?? "?"} → {c.countedQuantity}
                          </p>
                        );
                      })}
                      <p className="mt-1 text-amber-700">Contagens diferentes — nova recontagem obrigatória</p>
                    </div>
                  )}
                  <Button
                    className="w-full bg-amber-500 hover:bg-amber-600"
                    onClick={handleStartRecount}
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    {lastDivergence.attemptNumber === 1 ? "Iniciar Recontagem" : `Iniciar ${lastDivergence.attemptNumber + 1}ª Contagem`}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full border-red-300 text-red-600"
                    onClick={() => setStep("select-inventory")}
                  >
                    Cancelar Inventário
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── 5. Endereço concluído sem divergência ─────────────────────────── */}
        {step === "done-location" && (
          <Card className="border-2 border-green-400">
            <CardContent className="py-8 text-center flex flex-col items-center gap-3">
              <CheckCircle2 className="h-14 w-14 text-green-500" />
              <p className="text-xl font-semibold text-green-700">Endereço Conferido!</p>
              <p className="font-mono text-lg font-bold">{locationCode}</p>
              <p className="text-sm text-green-600">✅ Sem divergências</p>
              <p className="text-xs text-muted-foreground mt-1">Avançando para o próximo endereço...</p>
            </CardContent>
          </Card>
        )}

      </div>

      {/* ── Dialog: confirmar endereço vazio ──────────────────────────────── */}
      <Dialog open={confirmEmptyOpen} onOpenChange={setConfirmEmptyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-orange-500" />
              Registrar Endereço como Vazio
            </DialogTitle>
            <DialogDescription>
              Você confirma que o endereço{" "}
              <span className="font-mono font-semibold">{locationCode}</span>{" "}
              está completamente vazio?
            </DialogDescription>
          </DialogHeader>

          {countedItems.length > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
              <p className="font-semibold text-amber-700 mb-1">⚠️ Saldo esperado no sistema:</p>
              {countedItems.map((r, i) => (
                <p key={i} className="text-amber-800">
                  {r.productSku ?? r.productDescription ?? `Produto ${r.productId}`}
                  {r.batch ? ` — Lote ${r.batch}` : ""}
                  {" "}· {r.expectedQuantity} un.
                </p>
              ))}
              <p className="text-xs text-amber-600 mt-2">
                Declarar vazio irá gerar uma divergência de falta para estes produtos.
              </p>
            </div>
          )}

          <DialogFooter className="flex gap-2 mt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setConfirmEmptyOpen(false)}
              disabled={markEmptyMutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 bg-orange-500 hover:bg-orange-600"
              onClick={handleMarkEmpty}
              disabled={markEmptyMutation.isPending}
            >
              {markEmptyMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                : <Package className="h-4 w-4 mr-2" />
              }
              Confirmar Vazio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal: Associar Etiqueta ──────────────────────────────────────────────────────── */}
      <Dialog open={labelAssocOpen} onOpenChange={(v) => { if (!v) { setLabelAssocOpen(false); setTimeout(() => volumeRef.current?.focus(), 100); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-blue-500" />
              Associar Etiqueta
            </DialogTitle>
            <DialogDescription>
              O código <span className="font-mono font-semibold">{pendingLabelCode}</span> não possui associação de produto. Preencha os dados para criar a associação e continuar a contagem.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Busca de produto */}
            <div className="space-y-1">
              <label className="text-sm font-medium">Produto *</label>
              {/* Campo de busca */}
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por SKU, cód. interno ou descrição..."
                  className="pl-9"
                  value={labelProductSearch}
                  onChange={(e) => { setLabelProductSearch(e.target.value); setLabelSelectedProduct(null); }}
                />
              </div>
              {searchingProducts && <p className="text-xs text-muted-foreground">Buscando...</p>}
              {/* Select dropdown com resultados */}
              {productSearchResults && productSearchResults.length > 0 && (
                <Select
                  value={labelSelectedProduct ? String(labelSelectedProduct.id) : ""}
                  onValueChange={(val) => {
                    const found = productSearchResults.find((p) => String(p.id) === val);
                    if (found) setLabelSelectedProduct(found);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o produto..." />
                  </SelectTrigger>
                  <SelectContent>
                    {productSearchResults.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        <span className="font-mono text-xs text-muted-foreground mr-2">{p.sku ?? p.internalCode}</span>
                        {p.description}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {labelSelectedProduct && (
                <div className="flex items-center gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="font-semibold">{labelSelectedProduct.sku}</span>
                  <span className="text-muted-foreground truncate">{labelSelectedProduct.description}</span>
                  <button className="ml-auto text-xs text-blue-600 hover:underline" onClick={() => { setLabelSelectedProduct(null); setLabelProductSearch(""); }}>Alterar</button>
                </div>
              )}
            </div>

            {/* Lote */}
            <div className="space-y-1">
              <label className="text-sm font-medium">Lote</label>
              <Input
                placeholder="Número do lote (opcional)"
                value={labelBatch}
                onChange={(e) => setLabelBatch(e.target.value)}
              />
            </div>

            {/* Validade */}
            <div className="space-y-1">
              <label className="text-sm font-medium">Validade</label>
              <Input
                type="date"
                value={labelExpiryDate}
                onChange={(e) => setLabelExpiryDate(e.target.value)}
              />
            </div>

            {/* Unidades por caixa */}
            <div className="space-y-1">
              <label className="text-sm font-medium">Unidades por embalagem</label>
              <Input
                type="number"
                min={1}
                value={labelUnitsPerBox}
                onChange={(e) => setLabelUnitsPerBox(Math.max(1, Number(e.target.value)))}
              />
            </div>
          </div>

          <DialogFooter className="flex gap-2 mt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => { setLabelAssocOpen(false); setTimeout(() => volumeRef.current?.focus(), 100); }}
              disabled={associateLabelMutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 bg-blue-600 hover:bg-blue-700"
              disabled={!labelSelectedProduct || associateLabelMutation.isPending}
              onClick={async () => {
                if (!labelSelectedProduct) return;
                try {
                  const result = await associateLabelMutation.mutateAsync({
                    labelCode: pendingLabelCode,
                    productId: labelSelectedProduct.id,
                    batch: labelBatch || undefined,
                    expiryDate: labelExpiryDate || undefined,
                    unitsPerBox: labelUnitsPerBox,
                  });
                  // Adicionar à contagem com a quantidade configurada
                  const qty = result.unitsPerBox;
                  setCountedItems((prev) => {
                    const idx = prev.findIndex(
                      (r) => r.productId === result.productId && r.batch === (result.batch ?? null)
                    );
                    if (idx >= 0) {
                      return prev.map((r, i) =>
                        i === idx ? { ...r, countedQuantity: r.countedQuantity + qty } : r
                      );
                    }
                    return [
                      ...prev,
                      {
                        productId: result.productId,
                        productSku: result.productSku,
                        productDescription: result.productDescription,
                        batch: result.batch ?? null,
                        expiryDate: result.expiryDate ?? null,
                        expectedQuantity: 0,
                        countedQuantity: qty,
                        labelCode: pendingLabelCode,
                      },
                    ];
                  });
                  toast.success(`Etiqueta associada: ${result.productSku ?? result.productDescription ?? "Produto"} ${result.batch ? `— Lote ${result.batch}` : ""}`);
                  setLabelAssocOpen(false);
                  setTimeout(() => volumeRef.current?.focus(), 100);
                } catch (err: any) {
                  toast.error(err.message ?? "Erro ao associar etiqueta");
                }
              }}
            >
              {associateLabelMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Tag className="h-4 w-4 mr-2" />}
              Associar e Contar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </CollectorLayout>
  );
}
