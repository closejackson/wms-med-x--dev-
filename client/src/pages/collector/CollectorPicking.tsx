/**
 * CollectorPicking — Fluxo guiado de picking com validação de lote
 *
 * Implementa a spec "Parte 1 — /collector/picking: Fluxo guiado por endereço".
 * Backend: collectorPickingRouter (server/collectorPickingRouter.ts)
 *
 * Fluxo de telas:
 *  select_order → scan_location → scan_product → fractional_input?
 *                                              → report_problem?
 *              → location_done → [próximo endereço | all_done]
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useBarcodeScan } from "../../hooks/useBarcodeScan";
import { CollectorLayout } from "../../components/CollectorLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { SyncStatusBadge } from "../../components/SyncStatusIndicator";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";
import { offlineQueue, QueuedOperation } from "../../lib/offlineQueue";
import { Label } from "../../components/ui/label";
import { ProductCombobox } from "../../components/ProductCombobox";
import {
  MapPin,
  Package,
  CheckCircle2,
  AlertTriangle,
  PauseCircle,
  Camera,
  ChevronRight,
  RotateCcw,
  Scale,
  Scan,
  ArrowLeft,
  Tag,
  Loader2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen =
  | "select_order"
  | "resume_summary"
  | "scan_location"
  | "scan_product"
  | "fractional_input"
  | "uom_input"
  | "fraction_confirm"
  | "report_problem"
  | "location_done"
  | "all_done"
  | "associate_label";

interface RouteItem {
  allocationId: number;
  pickingOrderId: number; // ✅ Adicionar pickingOrderId
  productId: number;
  productSku: string;
  productName: string;
  batch: string | null;
  expiryDate: string | null;
  quantity: number;
  pickedQuantity: number;
  isFractional: boolean;
  status: string;
}

interface RouteLocation {
  locationId: number;
  locationCode: string;
  sequence: number;
  hasFractional: boolean;
  allDone: boolean;
  items: RouteItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function totalItems(route: RouteLocation[]) {
  return route.reduce((s, loc) => s + loc.items.length, 0);
}

function completedItems(route: RouteLocation[]) {
  return route.reduce(
    (s, loc) =>
      s +
      loc.items.filter(
        (i) => i.status === "picked" || i.status === "short_picked"
      ).length,
    0
  );
}

function pct(a: number, b: number) {
  if (b === 0) return 0;
  return Math.round((a / b) * 100);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-gray-200 rounded-full h-2">
      <div
        className="bg-blue-600 h-2 rounded-full transition-all duration-500"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function StatusHeader({
  orderNumber,
  locationIndex,
  totalLocations,
  done,
  total,
}: {
  orderNumber: string;
  locationIndex: number;
  totalLocations: number;
  done: number;
  total: number;
}) {
  const progress = pct(done, total);
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
            Pedido
          </p>
          <p className="font-bold text-gray-900">{orderNumber}</p>
        </div>
        <Badge
          variant="outline"
          className="text-blue-700 border-blue-300 bg-blue-50"
        >
          Endereço {locationIndex + 1} / {totalLocations}
        </Badge>
      </div>
      <div className="space-y-1">
        <ProgressBar value={progress} />
        <p className="text-xs text-gray-500 text-right">
          {done} / {total} itens — {progress}% concluído
        </p>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function CollectorPicking() {
  const [screen, setScreen] = useState<Screen>("select_order");
  const [showScanner, setShowScanner] = useState(false);

  // Order state
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [orderInfo, setOrderInfo] = useState<{
    id: number;
    waveNumber: string;
    status: string;
    totalOrders: number;
    totalItems: number;
  } | null>(null);

  // Route state
  const [route, setRoute] = useState<RouteLocation[]>([]);
  const [locationIdx, setLocationIdx] = useState(0);
  const [isResume, setIsResume] = useState(false);

  // Scan inputs
  const [locationScanInput, setLocationScanInput] = useState("");
  const [currentItemIdx, setCurrentItemIdx] = useState(0);
  const [productScanInput, setProductScanInput] = useState("");

  // Fractional
  const [fractionalMax, setFractionalMax] = useState(0);
  const [fractionalInput, setFractionalInput] = useState("");
  const [pendingAllocationId, setPendingAllocationId] = useState<number | null>(
    null
  );

  // UOM input — solicitado quando unitsPerBox não está cadastrado
  const [uomInput, setUomInput] = useState("");
  const [pendingUomAllocationId, setPendingUomAllocationId] = useState<number | null>(null);
  const [pendingUomScannedCode, setPendingUomScannedCode] = useState("");
  const [pendingUomProductSku, setPendingUomProductSku] = useState("");
  const [pendingUomProductName, setPendingUomProductName] = useState("");

  // Fraction confirm — solicitado quando unitsPerBox > saldo restante (caixa fracionada)
  const [fractionInput, setFractionInput] = useState("");
  const [pendingFractionAllocationId, setPendingFractionAllocationId] = useState<number | null>(null);
  const [pendingFractionScannedCode, setPendingFractionScannedCode] = useState("");
  const [pendingFractionProductSku, setPendingFractionProductSku] = useState("");
  const [pendingFractionProductName, setPendingFractionProductName] = useState("");
  const [pendingFractionUnitsPerBox, setPendingFractionUnitsPerBox] = useState(0);
  const [pendingFractionMax, setPendingFractionMax] = useState(0);

  // Feedback da última bipagem (UOM)
  const [lastScanFeedback, setLastScanFeedback] = useState<{
    conversionFactor: number;
    quantityAdded: number;
  } | null>(null);

  // Report problem
  const [reportTarget, setReportTarget] = useState<"location" | "product">(
    "product"
  );
  const [reportReason, setReportReason] = useState("");
  const [insufficientQtyInput, setInsufQtyInput] = useState("");

  // Associação de etiqueta durante picking
  const [pendingLabelCode, setPendingLabelCode] = useState("");
  const [assocProductId, setAssocProductId] = useState<number | null>(null);
  const [assocBatch, setAssocBatch] = useState("");
  const [assocExpiryDate, setAssocExpiryDate] = useState("");
  const [assocUnitsPerBox, setAssocUnitsPerBox] = useState(1);
  const [assocAllocationId, setAssocAllocationId] = useState<number | null>(null);
  const [assocPickingOrderId, setAssocPickingOrderId] = useState<number | null>(null);

  // Pilha LIFO para desfazer bipagens no picking
  const [undoStack, setUndoStack] = useState<Array<{
    allocationId: number;
    pickingOrderId: number;
    quantityAdded: number;
    productName: string;
  }>>([]);

  const locationInputRef = useRef<HTMLInputElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);
  const fractionalInputRef = useRef<HTMLInputElement>(null);
  const uomInputRef = useRef<HTMLInputElement>(null);
  const fractionInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  // ── Derived ────────────────────────────────────────────────────────────────
  const currentLocation: RouteLocation | undefined = route[locationIdx];
  const pendingItems =
    currentLocation?.items.filter(
      (i) => i.status !== "picked" && i.status !== "short_picked"
    ) ?? [];
  const currentItem: RouteItem | undefined = pendingItems[currentItemIdx];

  // ── Queries ────────────────────────────────────────────────────────────────

  // Buscar produto selecionado para preencher unitsPerBox automaticamente
  const { data: assocProduct } = trpc.products.getById.useQuery(
    { id: assocProductId! },
    { enabled: !!assocProductId }
  );

  // Montar lista de produtos únicos da rota para o select do modal
  // Usa os dados do pedido (productId, sku, nome, lote, validade) — sem filtro de tenant
  const routeProductList = route.flatMap((loc) =>
    loc.items.map((item) => ({
      id: item.productId,
      sku: item.productSku,
      description: item.productName,
    }))
  ).filter((p, idx, arr) => arr.findIndex((x) => x.id === p.id) === idx);

  // Preencher unitsPerBox automaticamente quando produto é selecionado
  useEffect(() => {
    if (assocProduct?.unitsPerBox) {
      setAssocUnitsPerBox(assocProduct.unitsPerBox);
    }
  }, [assocProduct]);

  const { data: orders, isLoading: ordersLoading } =
    trpc.collectorPicking.listOrders.useQuery(
      {},
      { enabled: screen === "select_order" }
    );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const startOrResumeMut = trpc.collectorPicking.startOrResume.useMutation({
    onSuccess: (data) => {
      setOrderInfo(data.wave as any);
      setRoute(data.route as RouteLocation[]);
      setIsResume(data.isResume);

      const savedSeq = data.progress.currentSequence;
      const idx = (data.route as RouteLocation[]).findIndex(
        (loc) => loc.sequence >= savedSeq
      );
      setLocationIdx(Math.max(0, idx));
      setCurrentItemIdx(0);

      if (data.isResume && (data.progress.scannedItems as any[]).length > 0) {
        setScreen("resume_summary");
      } else {
        setScreen("scan_location");
        setTimeout(() => locationInputRef.current?.focus(), 200);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const confirmLocationMut = trpc.collectorPicking.confirmLocation.useMutation({
    onSuccess: () => {
      setLocationScanInput("");
      setCurrentItemIdx(0);
      setScreen("scan_product");
      setTimeout(() => productInputRef.current?.focus(), 200);
    },
    onError: (err) => {
      toast.error(err.message, { duration: 4000 });
      setLocationScanInput("");
      setTimeout(() => locationInputRef.current?.focus(), 100);
    },
  });

  // Configurar função de sincronização offline
  const trpcUtils = trpc.useUtils();
  useEffect(() => {
    offlineQueue.setSyncFunction(async (operation: QueuedOperation) => {
      if (operation.operationType === 'scanProduct') {
        try {
          await trpcUtils.client.collectorPicking.scanProduct.mutate(operation.payload);
          return true;
        } catch (error) {
          console.error('[OfflineSync] Error syncing scanProduct:', error);
          return false;
        }
      }
      return false;
    });
  }, [trpcUtils]);

  const scanProductMut = trpc.collectorPicking.scanProduct.useMutation({
    onSuccess: (data) => {
      setProductScanInput("");

      if (data.requiresManualQuantity) {
        setPendingAllocationId(currentItem?.allocationId ?? null);
        setFractionalMax(data.maxQuantity ?? 0);
        setFractionalInput("");
        setScreen("fractional_input");
        setTimeout(() => fractionalInputRef.current?.focus(), 200);
        return;
      }

      // ⚠️ CAIXA FRACIONADA: solicitar confirmação e quantidade manual
      if (data.requiresFractionConfirm) {
        setPendingFractionAllocationId(data.allocationId ?? currentItem?.allocationId ?? null);
        setPendingFractionScannedCode(data.scannedCode ?? "");
        setPendingFractionProductSku(data.productSku ?? currentItem?.productSku ?? "");
        setPendingFractionProductName(data.productName ?? currentItem?.productName ?? "");
        setPendingFractionUnitsPerBox(data.unitsPerBox ?? 0);
        setPendingFractionMax(data.maxQuantity ?? 0);
        setFractionInput("");
        setScreen("fraction_confirm");
        setTimeout(() => fractionInputRef.current?.focus(), 200);
        return;
      }

      // ⚠️ BLOQUEIO UOM: solicitar fator de conversão ao operador
      if (data.requiresUomInput) {
        setPendingUomAllocationId(data.allocationId ?? currentItem?.allocationId ?? null);
        setPendingUomScannedCode(data.scannedCode ?? "");
        setPendingUomProductSku(data.productSku ?? currentItem?.productSku ?? "");
        setPendingUomProductName(data.productName ?? currentItem?.productName ?? "");
        setUomInput("");
        setScreen("uom_input");
        setTimeout(() => uomInputRef.current?.focus(), 200);
        return;
      }

      // 📦 Feedback UOM: salvar para exibir "Lido: 1 CX (N UN)"
      // Usar type assertion pois o discriminated union estreita para 'never' após os guards acima
      const scanData = data as {
        conversionFactor?: number;
        quantityAdded?: number;
        message?: string;
        allocationCompleted?: boolean;
      };
      if (scanData.conversionFactor && scanData.conversionFactor > 1) {
        setLastScanFeedback({
          conversionFactor: scanData.conversionFactor,
          quantityAdded: scanData.quantityAdded ?? scanData.conversionFactor,
        });
        toast.success(`📦 Lido: 1 emb × ${scanData.conversionFactor} un = +${scanData.quantityAdded} un`);
      } else {
        setLastScanFeedback(null);
        toast.success(scanData.message ?? "Bipagem registrada.");
      }

      // Empilhar bipagem na pilha LIFO
      if (currentItem) {
        setUndoStack(prev => [...prev, {
          allocationId: currentItem.allocationId,
          pickingOrderId: currentItem.pickingOrderId,
          quantityAdded: data.quantityAdded ?? 1,
          productName: currentItem.productName,
        }]);
      }
      
      // Atualizar rota e executar lógica após dados estarem atualizados
      refreshRoute((updatedRoute) => {
        if (data.allocationCompleted) {
          advanceItem(updatedRoute);
        } else {
          productInputRef.current?.focus();
        }
      });    },
    onError: async (err) => {
      // Se falhar, adicionar à fila offline
      if (!navigator.onLine) {
        const operationId = await offlineQueue.enqueue('scanProduct', {
          pickingOrderId: currentItem!.pickingOrderId, // ✅ Usar pickingOrderId do item
          allocationId: currentItem!.allocationId,
          scannedCode: productScanInput,
        });
        toast.warning('Offline: Operação salva localmente', { duration: 3000 });
        setProductScanInput("");
        // Simular sucesso localmente para continuar fluxo
        refreshRoute();
        setTimeout(() => productInputRef.current?.focus(), 100);
      } else {
        toast.error(err.message, { duration: 5000 });
        setProductScanInput("");
        setTimeout(() => productInputRef.current?.focus(), 100);
      }
    },
  });

  const recordFractionalMut =
    trpc.collectorPicking.recordFractionalQuantity.useMutation({
      onSuccess: (data) => {
        toast.success(`+${data.quantityAdded} registrado.`);
        // Empilhar bipagem fracionada na pilha LIFO
        if (pendingAllocationId !== null && currentItem) {
          setUndoStack(prev => [...prev, {
            allocationId: pendingAllocationId,
            pickingOrderId: currentItem.pickingOrderId,
            quantityAdded: data.quantityAdded,
            productName: currentItem.productName,
          }]);
        }
        setFractionalInput("");
        setPendingAllocationId(null);
        setScreen("scan_product");
        
        refreshRoute((updatedRoute) => {
          if (data.allocationCompleted) {
            advanceItem(updatedRoute);
          } else {
            setTimeout(() => productInputRef.current?.focus(), 100);
          }
        });
      },
      onError: (err) => toast.error(err.message),
    });

  const confirmUomMut = trpc.collectorPicking.confirmUomFactor.useMutation({
    onSuccess: (data) => {
      toast.success(`✓ Fator UOM salvo: ${data.unitsPerBoxSaved} un/emb. +${data.quantityAdded} registrado.`);
      // Empilhar na pilha LIFO
      if (pendingUomAllocationId !== null && currentItem) {
        setUndoStack(prev => [...prev, {
          allocationId: pendingUomAllocationId,
          pickingOrderId: currentItem.pickingOrderId,
          quantityAdded: data.quantityAdded,
          productName: currentItem.productName,
        }]);
      }
      setUomInput("");
      setPendingUomAllocationId(null);
      setPendingUomScannedCode("");
      setScreen("scan_product");
      refreshRoute((updatedRoute) => {
        if (data.allocationCompleted) {
          advanceItem(updatedRoute);
        } else {
          setTimeout(() => productInputRef.current?.focus(), 100);
        }
      });
    },
    onError: (err) => toast.error(err.message),
  });

  const confirmFractionMut = trpc.collectorPicking.recordFractionalQuantity.useMutation({
    onSuccess: (data) => {
      toast.success(`✓ Caixa fracionada registrada: +${data.quantityAdded} un separadas.`);
      // Empilhar na pilha LIFO
      if (pendingFractionAllocationId !== null && currentItem) {
        setUndoStack(prev => [...prev, {
          allocationId: pendingFractionAllocationId,
          pickingOrderId: currentItem.pickingOrderId,
          quantityAdded: data.quantityAdded,
          productName: currentItem.productName,
        }]);
      }
      setFractionInput("");
      setPendingFractionAllocationId(null);
      setPendingFractionScannedCode("");
      setScreen("scan_product");
      refreshRoute((updatedRoute) => {
        if (data.allocationCompleted) {
          advanceItem(updatedRoute);
        } else {
          setTimeout(() => productInputRef.current?.focus(), 100);
        }
      });
    },
    onError: (err) => toast.error(err.message),
  });

  const reportLocationMut =
    trpc.collectorPicking.reportLocationProblem.useMutation({
      onSuccess: (data) => {
        toast.warning(data.message);
        refreshRoute();
        advanceLocation();
      },
      onError: (err) => toast.error(err.message),
    });

  const reportProductMut =
    trpc.collectorPicking.reportProductProblem.useMutation({
      onSuccess: (data) => {
        if (data.alternativeFound) {
          toast.info(`Endereço alternativo: ${data.alternativeLocation}`);
        } else {
          toast.warning(data.message);
        }
        setScreen("scan_product");
        
        refreshRoute((updatedRoute) => {
          advanceItem(updatedRoute);
        });
      },
      onError: (err) => toast.error(err.message),
    });

  const associateLabelPickingMut = trpc.collectorPicking.associateLabelPicking.useMutation({
    onSuccess: (data) => {
      toast.success(data.message, {
        description: `Etiqueta vinculada ao produto ${currentItem?.productSku ?? ""}`,
      });
      // Resetar estados do modal
      setPendingLabelCode("");
      setAssocProductId(null);
      setAssocBatch("");
      setAssocExpiryDate("");
      setAssocUnitsPerBox(1);
      setAssocAllocationId(null);
      setAssocPickingOrderId(null);
      // Voltar para scan_product e continuar o fluxo
      setScreen("scan_product");
      refreshRoute();
      setTimeout(() => productInputRef.current?.focus(), 200);
    },
    onError: (err) => {
      toast.error(err.message, { duration: 5000 });
    },
  });

  const undoMut = trpc.collectorPicking.undoLastScan.useMutation({
    onSuccess: (data) => {
      setUndoStack(prev => prev.slice(0, -1));
      toast.info(data.message);
      refreshRoute();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleUndo = () => {
    if (undoStack.length === 0) {
      toast.error("Nenhuma bipagem para desfazer");
      return;
    }
    const top = undoStack[undoStack.length - 1];
    undoMut.mutate({
      allocationId: top.allocationId,
      pickingOrderId: top.pickingOrderId,
      quantityToUndo: top.quantityAdded,
    });
  };

  const pauseMut = trpc.collectorPicking.pause.useMutation({
    onSuccess: () => {
      toast.success("Progresso salvo. Retome quando quiser.");
      utils.collectorPicking.listOrders.invalidate();
      resetAll();
    },
    onError: (err) => toast.error(err.message),
  });

  const completeMut = trpc.collectorPicking.complete.useMutation({
    onSuccess: (data) => {
      if (data.hasDivergences) {
        toast.warning(data.message, { duration: 6000 });
      } else {
        toast.success(data.message);
      }
      utils.collectorPicking.listOrders.invalidate();
      setScreen("all_done");
    },
    onError: (err) => toast.error(err.message),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function refreshRoute(onComplete?: (updatedRoute: RouteLocation[]) => void) {
    if (!selectedOrderId) return;
    utils.collectorPicking.getRoute
      .fetch({ pickingOrderId: selectedOrderId })
      .then((r) => {
        const updatedRoute = r as RouteLocation[];
        setRoute(updatedRoute);
        // Executar callback IMEDIATAMENTE com dados atualizados
        if (onComplete) {
          setTimeout(() => onComplete(updatedRoute), 50); // Delay para React processar, mas passa dados diretos
        }
      });
  }

  function advanceItem(updatedRoute?: RouteLocation[]) {
    // IMPORTANTE: Esta função recebe dados ATUALIZADOS diretamente do refreshRoute(),
    // evitando dependência de estado que pode estar desatualizado
    
    const routeToUse = updatedRoute ?? route;
    const currentLoc = routeToUse[locationIdx];
    
    if (!currentLoc) {
      console.warn("[advanceItem] currentLocation é undefined");
      setScreen("location_done");
      return;
    }
    
    // Buscar se ainda existe algum item não coletado neste endereço
    // IMPORTANTE: Incluir "in_progress" pois item pode estar parcialmente bipado
    const pendingItems = currentLoc.items.filter(
      (i) => i.status !== "picked" && i.status !== "short_picked"
    );
    
    const nextPendingItem = pendingItems.length > 0 ? pendingItems[0] : null;
    
    if (nextPendingItem) {
      // ✅ Ainda há lotes aqui! Reseta para o primeiro disponível
      console.log(`[advanceItem] Item pendente encontrado, resetando índice para 0`);
      setCurrentItemIdx(0);
      setScreen("scan_product");
      setTimeout(() => productInputRef.current?.focus(), 100);
    } else {
      // ✅ Acabaram os lotes DESTE endereço.
      // Agora sim verificamos se vamos para o próximo endereço ou se acabou tudo.
      console.log("[advanceItem] Todos os itens do endereço foram separados");
      
      // Sempre vai para location_done — seja para avançar ao próximo endereço
      // ou para exibir o botão "Finalizar Pedido" (último endereço).
      // O completeMut é disparado pelo botão na tela location_done.
      setScreen("location_done");
    }
  }

  function advanceLocation() {
    const nextIdx = locationIdx + 1;
    if (nextIdx < route.length) {
      setLocationIdx(nextIdx);
      setCurrentItemIdx(0);
      setScreen("scan_location");
      setTimeout(() => locationInputRef.current?.focus(), 200);
    } else {
      // Antes de ir para all_done, verificar se ainda há endereços pendentes na rota
      // (protção contra finalização prematura em ondas com múltiplos pedidos)
      const stillPending = route.some(
        (loc) => !loc.allDone && loc.items.some(
          (i: any) => i.status !== 'picked' && i.status !== 'short_picked'
        )
      );
      if (stillPending) {
        // Voltar ao primeiro endereço pendente
        const firstPendingIdx = route.findIndex(
          (loc) => !loc.allDone && loc.items.some(
            (i: any) => i.status !== 'picked' && i.status !== 'short_picked'
          )
        );
        setLocationIdx(firstPendingIdx >= 0 ? firstPendingIdx : 0);
        setCurrentItemIdx(0);
        setScreen("scan_location");
        setTimeout(() => locationInputRef.current?.focus(), 200);
      } else {
        setScreen("all_done");
      }
    }
  }

  function resetAll() {
    setScreen("select_order");
    setSelectedOrderId(null);
    setOrderInfo(null);
    setRoute([]);
    setLocationIdx(0);
    setCurrentItemIdx(0);
    setLocationScanInput("");
    setProductScanInput("");
    setFractionalInput("");
    setPendingAllocationId(null);
    setIsResume(false);
  }

  function handlePause() {
    if (!selectedOrderId || !orderInfo) return;
    pauseMut.mutate({
      pickingOrderId: selectedOrderId,
      currentSequence: currentLocation?.sequence ?? 1,
      currentLocationId: currentLocation?.locationId ?? null,
      scannedItems: [],
    });
  }

  function handleComplete() {
    if (!selectedOrderId) return;
    completeMut.mutate({ pickingOrderId: selectedOrderId });
  }

  function handleFractionalConfirm() {
    const qty = parseInt(fractionalInput);
    if (!qty || qty <= 0 || qty > fractionalMax) {
      toast.error(`Informe uma quantidade entre 1 e ${fractionalMax}`);
      return;
    }
    if (!selectedOrderId || !pendingAllocationId) return;
    recordFractionalMut.mutate({
      pickingOrderId: selectedOrderId,
      allocationId: pendingAllocationId,
      quantity: qty,
    });
  }

  // Hooks de auto-submit para campos de leitura
  const locationBarcode = useBarcodeScan({
    onSubmit: (code) => {
      if (!selectedOrderId || !currentLocation) return;
      setLocationScanInput(code);
      confirmLocationMut.mutate({
        pickingOrderId: selectedOrderId,
        expectedLocationCode: currentLocation.locationCode,
        scannedLocationCode: code,
      });
    },
    disabled: confirmLocationMut.isPending,
  });

  const productBarcode = useBarcodeScan({
    onSubmit: async (code) => {
      if (!selectedOrderId || !currentItem) return;
      if (!currentItem.allocationId) {
        toast.error("Erro: ID de alocação inválido. Atualizando rota...");
        refreshRoute();
        return;
      }
      setProductScanInput(code);

      // Verificar se a etiqueta existe no sistema
      try {
        const check = await utils.client.collectorPicking.checkLabel.query({
          labelCode: code,
          allocationId: currentItem.allocationId,
        });

        // Se a etiqueta não existe → abrir fluxo de associação
        if (!check.exists) {
          setPendingLabelCode(code);
          setAssocAllocationId(currentItem.allocationId);
          setAssocPickingOrderId(currentItem.pickingOrderId);
          // Pré-preencher com dados da alocação
          setAssocProductId(currentItem.productId);
          setAssocBatch(currentItem.batch ?? "");
          setAssocExpiryDate(currentItem.expiryDate ?? "");
          setProductScanInput("");
          setScreen("associate_label");
          return;
        }
      } catch {
        // Se checkLabel falhar, prosseguir normalmente com scanProduct
      }

      scanProductMut.mutate({
        pickingOrderId: currentItem.pickingOrderId,
        allocationId: currentItem.allocationId,
        scannedCode: code,
      });
    },
    disabled: scanProductMut.isPending,
  });

  // Scanner
  const handleScan = useCallback(
    (code: string) => {
      setShowScanner(false);
      if (screen === "scan_location") {
        setLocationScanInput(code);
        if (!selectedOrderId || !currentLocation) return;
        confirmLocationMut.mutate({
          pickingOrderId: selectedOrderId,
          expectedLocationCode: currentLocation.locationCode,
          scannedLocationCode: code,
        });
      } else if (screen === "scan_product") {
        setProductScanInput(code);
        if (!selectedOrderId || !currentItem) return;
        
        if (!currentItem.allocationId) {
          toast.error("Erro: ID de alocação inválido. Atualizando rota...");
          refreshRoute();
          return;
        }

        // Verificar se a etiqueta existe (mesmo fluxo do barcode manual)
        utils.client.collectorPicking.checkLabel
          .query({ labelCode: code, allocationId: currentItem.allocationId })
          .then((check) => {
            if (!check.exists) {
              setPendingLabelCode(code);
              setAssocAllocationId(currentItem.allocationId);
              setAssocPickingOrderId(currentItem.pickingOrderId);
              setAssocProductId(currentItem.productId);
              setAssocBatch(currentItem.batch ?? "");
              setAssocExpiryDate(currentItem.expiryDate ?? "");
              setProductScanInput("");
              setScreen("associate_label");
            } else {
              scanProductMut.mutate({
                pickingOrderId: currentItem.pickingOrderId,
                allocationId: currentItem.allocationId,
                scannedCode: code,
              });
            }
          })
          .catch(() => {
            scanProductMut.mutate({
              pickingOrderId: currentItem.pickingOrderId,
              allocationId: currentItem.allocationId,
              scannedCode: code,
            });
          });
      }
    },
    [screen, selectedOrderId, currentLocation, currentItem]
  );

  // ── Scanner overlay ────────────────────────────────────────────────────────
  if (showScanner) {
    return (
      <BarcodeScanner
        onScan={handleScan}
        onClose={() => setShowScanner(false)}
      />
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: SELECT ORDER
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "select_order") {
    return (
      <CollectorLayout title="Picking — Separação">
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <p className="text-sm font-medium text-blue-900">
              Selecione um pedido para iniciar ou retomar a separação.
            </p>
          </div>

          {ordersLoading && (
            <div className="text-center py-8 text-gray-400">
              <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-sm">Carregando pedidos...</p>
            </div>
          )}

          {!ordersLoading && (!orders || orders.length === 0) && (
            <div className="text-center py-12 text-gray-400">
              <Package className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">Nenhum pedido disponível</p>
              <p className="text-xs mt-1">
                Pedidos pendentes ou em progresso aparecerão aqui
              </p>
            </div>
          )}

          <div className="space-y-3">
            {orders?.map((order) => (
              <button
                key={order.id}
                className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-400 hover:bg-blue-50 transition-all active:scale-[0.98] shadow-sm"
                onClick={() => {
                  setSelectedOrderId(order.id);
                  startOrResumeMut.mutate({ waveId: order.id });
                }}
                disabled={startOrResumeMut.isPending}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-gray-900">
                        Onda {order.waveNumber}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      {order.totalOrders} pedidos · {order.totalItems} itens
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                </div>
              </button>
            ))}
          </div>

          {startOrResumeMut.isPending && (
            <div className="text-center py-4">
              <div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2" />
              <p className="text-sm text-gray-500">Carregando rota...</p>
            </div>
          )}
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: RESUME SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "resume_summary") {
    const done = completedItems(route);
    const total = totalItems(route);
    return (
      <CollectorLayout title="Retomando Separação">
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <RotateCcw className="h-6 w-6 text-amber-600 flex-shrink-0" />
              <div>
                <p className="font-semibold text-amber-900">
                  Retomando: Onda {orderInfo?.waveNumber}
                </p>
                <p className="text-sm text-amber-700 mt-0.5">
                  {done} de {total} itens já foram separados
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
            <ProgressBar value={pct(done, total)} />
            <p className="text-xs text-gray-500 text-center">
              {pct(done, total)}% concluído
            </p>
          </div>

          <p className="text-sm text-gray-600 text-center">
            Continuando no endereço{" "}
            <span className="font-bold text-gray-900">
              {currentLocation?.locationCode}
            </span>
          </p>

          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold"
            onClick={() => {
              setScreen("scan_location");
              setTimeout(() => locationInputRef.current?.focus(), 200);
            }}
          >
            Continuar Separação
          </Button>

          <Button variant="ghost" className="w-full" onClick={resetAll}>
            Cancelar
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: SCAN LOCATION
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "scan_location") {
    const done = completedItems(route);
    const total = totalItems(route);
    return (
      <CollectorLayout title="Bipar Endereço">
        <div className="space-y-4">
          <StatusHeader
            orderNumber={orderInfo?.waveNumber ?? ""}
            locationIndex={locationIdx}
            totalLocations={route.length}
            done={done}
            total={total}
          />

          {/* Destination */}
          <div className="bg-white border-2 border-blue-500 rounded-xl p-5 text-center shadow-sm">
            <MapPin className="h-10 w-10 text-blue-600 mx-auto mb-2" />
            <p className="text-sm text-gray-500 font-medium">Dirija-se ao endereço</p>
            <p className="text-3xl font-black text-gray-900 mt-1 tracking-tight">
              {currentLocation?.locationCode}
            </p>
            <div className="mt-2 flex items-center justify-center gap-3 text-sm text-gray-400">
              <span>{currentLocation?.items.length} item(ns)</span>
              {currentLocation?.hasFractional && (
                <>
                  <span>·</span>
                  <span className="text-amber-600 font-medium">
                    ⚠ item fracionado
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Items preview */}
          <div className="bg-gray-50 rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
              Itens a separar
            </p>
            {currentLocation?.items.map((item) => (
              <div
                key={item.allocationId}
                className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                  item.status === "picked"
                    ? "bg-green-50"
                    : item.status === "short_picked"
                    ? "bg-red-50"
                    : "bg-white border border-gray-100"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">
                    {item.productName}
                  </p>
                  <p className="text-xs text-gray-400">
                    {item.productSku}
                    {item.batch && ` · Lote: ${item.batch}`}
                  </p>
                </div>
                <div className="text-right ml-2 flex-shrink-0 flex items-center gap-2">
                  <span className="text-sm font-bold text-gray-700">
                    {item.pickedQuantity}/{item.quantity}
                  </span>
                  {item.status === "picked" && (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  )}
                </div>
              </div>
            ))}
          </div>

          {currentLocation?.hasFractional && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3">
              <Scale className="h-5 w-5 text-amber-600 flex-shrink-0" />
              <p className="text-sm text-amber-800">
                <span className="font-semibold">Atenção:</span> item
                fracionado. Tenha o instrumento de medição em mãos.
              </p>
            </div>
          )}

          {/* Scan */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700">
              Bipe a etiqueta do endereço para confirmar:
            </p>
            <div className="flex gap-2">
              <Input
                ref={locationBarcode.ref}
                value={locationBarcode.value}
                onChange={locationBarcode.onChange}
                onKeyDown={locationBarcode.onKeyDown}
                placeholder="Bipe o endereço..."
                className="font-mono h-12 text-lg"
                autoComplete="off"
                
                disabled={confirmLocationMut.isPending}
                autoFocus
              />
              <Button
                size="lg"
                variant="outline"
                className="h-12 px-4 flex-shrink-0"
                onClick={() => setShowScanner(true)}
              >
                <Camera className="h-5 w-5" />
              </Button>
              <Button
                size="lg"
                className="h-12 px-4 flex-shrink-0"
                disabled={
                  !locationBarcode.value.trim() || confirmLocationMut.isPending
                }
                onClick={() => locationBarcode.onKeyDown({ key: "Enter", preventDefault: () => {} } as any)}
              >
                {confirmLocationMut.isPending ? (
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Scan className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <Button
              variant="outline"
              className="flex-1 text-red-700 border-red-400 bg-red-50 hover:bg-red-100 font-semibold"
              onClick={() => {
                setReportTarget("location");
                setReportReason("");
                setScreen("report_problem");
              }}
            >
              <AlertTriangle className="h-4 w-4 mr-2" />
              Reportar Problema
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              onClick={handlePause}
              disabled={pauseMut.isPending}
            >
              <PauseCircle className="h-4 w-4 mr-2" />
              Pausar
            </Button>
          </div>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: SCAN PRODUCT
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "scan_product") {
    if (!currentItem) {
      // Todos os itens concluídos — ir para tela de conclusão do endereço
      return (
        <CollectorLayout title="Endereço Concluído">
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-center">
              <CheckCircle2 className="h-14 w-14 text-green-600 mx-auto mb-3" />
              <p className="text-xl font-bold text-green-900">Endereço concluído!</p>
            </div>
            <Button
              size="lg"
              className="w-full h-14 font-semibold"
              onClick={() => setScreen("location_done")}
            >
              Continuar
            </Button>
          </div>
        </CollectorLayout>
      );
    }

    const done = completedItems(route);
    const total = totalItems(route);
    const remaining = currentItem.quantity - currentItem.pickedQuantity;

    return (
      <CollectorLayout title="Bipar Produto">
        <div className="space-y-4">
          <StatusHeader
            orderNumber={orderInfo?.waveNumber ?? ""}
            locationIndex={locationIdx}
            totalLocations={route.length}
            done={done}
            total={total}
          />

          {/* Current item */}
          <div className="bg-white border-2 border-gray-200 rounded-xl p-4 shadow-sm space-y-3">
            <div className="flex items-start gap-3">
              <Package className="h-6 w-6 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 leading-tight">
                  {currentItem.productName}
                </p>
                <p className="text-sm text-gray-700 font-medium mt-0.5">
                  {currentItem.productSku}
                </p>
                {currentItem.batch && (
                  <span className="mt-1.5 inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 border border-blue-200">
                    Lote: {currentItem.batch}
                  </span>
                )}
              </div>
            </div>

            {/* Quantity */}
            <div className="bg-slate-100 rounded-lg p-3 grid grid-cols-3 divide-x divide-slate-300">
              <div className="text-center px-2">
                <p className="text-xs text-gray-700 font-semibold uppercase tracking-wide">
                  Esperado
                </p>
                <p className="text-2xl font-black text-gray-900">
                  {currentItem.quantity}
                </p>
              </div>
              <div className="text-center px-2">
                <p className="text-xs text-gray-700 font-semibold uppercase tracking-wide">
                  Separado
                </p>
                <p className="text-2xl font-black text-green-600">
                  {currentItem.pickedQuantity}
                </p>
              </div>
              <div className="text-center px-2">
                <p className="text-xs text-gray-700 font-semibold uppercase tracking-wide">
                  Restante
                </p>
                <p className="text-2xl font-black text-blue-700">{remaining}</p>
              </div>
            </div>

            {currentItem.isFractional && (
              <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 border border-amber-200">
                <Scale className="h-4 w-4 flex-shrink-0" />
                Item fracionado — quantidade manual será solicitada
              </div>
            )}
          </div>

          {/* Other pending items */}
          {pendingItems.length > 1 && (
            <div className="bg-white border border-gray-200 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2 px-1">
                Próximos itens neste endereço
              </p>
              {pendingItems.slice(1, 4).map((it) => (
                <div
                  key={it.allocationId}
                  className="flex items-center justify-between px-2 py-1.5 text-sm text-gray-700"
                >
                  <span className="truncate">{it.productName}</span>
                  <span className="ml-2 font-semibold flex-shrink-0">
                    {it.pickedQuantity}/{it.quantity}
                  </span>
                </div>
              ))}
              {pendingItems.length > 4 && (
                <p className="text-xs text-gray-600 px-2 pt-1">
                  +{pendingItems.length - 4} mais...
                </p>
              )}
            </div>
          )}

          {/* Scan */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-gray-800">
              Bipe a etiqueta do produto:
            </p>
            <div className="flex gap-2">
              <Input
                ref={productBarcode.ref}
                value={productBarcode.value}
                onChange={productBarcode.onChange}
                onKeyDown={productBarcode.onKeyDown}
                placeholder="Bipe a etiqueta do produto..."
                className="font-mono h-12 text-base border-2 border-slate-400 focus:border-blue-500 bg-white text-gray-900 placeholder:text-gray-500"
                autoComplete="off"
                
                disabled={scanProductMut.isPending}
                autoFocus
              />
              <Button
                size="lg"
                variant="outline"
                className="h-12 px-4 flex-shrink-0"
                onClick={() => setShowScanner(true)}
              >
                <Camera className="h-5 w-5" />
              </Button>
              <Button
                size="lg"
                className="h-12 px-4 flex-shrink-0"
                disabled={
                  !productBarcode.value.trim() || scanProductMut.isPending
                }
                onClick={() => productBarcode.onKeyDown({ key: "Enter", preventDefault: () => {} } as any)}
              >
                {scanProductMut.isPending ? (
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Scan className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>

          {/* Feedback UOM da última bipagem */}
          {lastScanFeedback && lastScanFeedback.conversionFactor > 1 && (
            <div className="flex items-center gap-2 text-sm text-blue-800 bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
              <span className="text-lg">📦</span>
              <span>
                <strong>Lido: 1 emb × {lastScanFeedback.conversionFactor} un</strong>
                {" — "}
                <span className="text-blue-600">+{lastScanFeedback.quantityAdded} unidades adicionadas</span>
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <Button
              variant="outline"
              className="flex-1 text-red-700 border-red-400 bg-red-50 hover:bg-red-100 font-semibold"
              onClick={() => {
                setReportTarget("product");
                setReportReason("");
                setInsufQtyInput("");
                setScreen("report_problem");
              }}
            >
              <AlertTriangle className="h-4 w-4 mr-2" />
              Reportar Falta/Avaria
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleUndo}
              disabled={undoStack.length === 0 || undoMut.isPending}
              title={undoStack.length === 0 ? "Nenhuma bipagem para desfazer" : `Desfazer: ${undoStack[undoStack.length - 1]?.productName}`}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Desfazer
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              onClick={handlePause}
              disabled={pauseMut.isPending}
            >
              <PauseCircle className="h-4 w-4 mr-2" />
              Pausar
            </Button>
          </div>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: ASSOCIATE LABEL
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "associate_label") {
    return (
      <CollectorLayout title="Associar Etiqueta">
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <Tag className="h-6 w-6 text-amber-600 flex-shrink-0" />
              <div>
                <p className="font-semibold text-amber-900">Nova Etiqueta Detectada</p>
                <p className="text-sm text-amber-700 mt-0.5">
                  Código: <span className="font-mono font-bold">{pendingLabelCode}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <div>
              <Label className="text-sm font-semibold text-gray-700">Produto *</Label>
              <p className="text-xs text-gray-500 mb-2">
                Confirme o produto correspondente a esta etiqueta
              </p>
              <ProductCombobox
                products={routeProductList}
                value={assocProductId ? String(assocProductId) : ""}
                onValueChange={(val) => {
                  const pid = val ? Number(val) : null;
                  setAssocProductId(pid);
                  // Preencher lote e validade com os dados do item da rota
                  if (pid) {
                    const routeItem = route
                      .flatMap((loc) => loc.items)
                      .find((i) => i.productId === pid && i.allocationId === assocAllocationId);
                    if (routeItem) {
                      setAssocBatch(routeItem.batch ?? "");
                      setAssocExpiryDate(routeItem.expiryDate ?? "");
                    }
                  }
                }}
                placeholder="Selecione o produto do pedido"
                className="h-12 text-base"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm font-semibold text-gray-700">Lote</Label>
                <Input
                  value={assocBatch}
                  onChange={(e) => setAssocBatch(e.target.value)}
                  placeholder="Lote do produto"
                  className="h-12 text-base mt-1"
                />
              </div>
              <div>
                <Label className="text-sm font-semibold text-gray-700">Validade</Label>
                <Input
                  type="date"
                  value={assocExpiryDate}
                  onChange={(e) => setAssocExpiryDate(e.target.value)}
                  className="h-12 text-base mt-1"
                />
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold text-gray-700">Un/Caixa *</Label>
              <p className="text-xs text-gray-500 mb-1">
                {assocProduct?.unitsPerBox
                  ? `Preenchido automaticamente do cadastro: ${assocProduct.unitsPerBox}`
                  : "Informe a quantidade de unidades por caixa"}
              </p>
              <Input
                type="number"
                value={assocUnitsPerBox}
                onChange={(e) => setAssocUnitsPerBox(parseInt(e.target.value) || 1)}
                className="h-12 text-base"
                min="1"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-12"
              onClick={() => {
                setPendingLabelCode("");
                setAssocProductId(null);
                setAssocBatch("");
                setAssocExpiryDate("");
                setAssocUnitsPerBox(1);
                setAssocAllocationId(null);
                setAssocPickingOrderId(null);
                setScreen("scan_product");
                setTimeout(() => productInputRef.current?.focus(), 200);
              }}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 h-12"
              disabled={
                !assocProductId ||
                !assocAllocationId ||
                !assocPickingOrderId ||
                associateLabelPickingMut.isPending
              }
              onClick={() => {
                if (!assocProductId || !assocAllocationId || !assocPickingOrderId) return;
                associateLabelPickingMut.mutate({
                  pickingOrderId: assocPickingOrderId,
                  allocationId: assocAllocationId,
                  labelCode: pendingLabelCode,
                  productId: assocProductId,
                  batch: assocBatch || null,
                  expiryDate: assocExpiryDate || null,
                  unitsPerBox: assocUnitsPerBox,
                });
              }}
            >
              {associateLabelPickingMut.isPending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                "Confirmar Associação"
              )}
            </Button>
          </div>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: FRACTIONAL INPUT
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "fractional_input") {
    return (
      <CollectorLayout title="Quantidade Fracionada">
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <Scale className="h-6 w-6 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-900">Item fracionado</p>
              <p className="text-sm text-amber-700 mt-1">
                A quantidade restante é menor que 1 caixa completa. Informe a
                quantidade exata separada.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-1">
            <p className="font-bold text-gray-900">{currentItem?.productName}</p>
            <p className="text-sm text-gray-500">{currentItem?.productSku}</p>
            {currentItem?.batch && (
              <p className="text-sm text-blue-700">Lote: {currentItem.batch}</p>
            )}
            <div className="pt-2 border-t border-gray-100 mt-2">
              <p className="text-sm text-gray-600">
                Máximo a separar:{" "}
                <span className="font-bold text-gray-900">{fractionalMax} un.</span>
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">
              Quantidade separada (unidades)
            </label>
            <Input
              ref={fractionalInputRef}
              type="number"
              inputMode="numeric"
              min={1}
              max={fractionalMax}
              value={fractionalInput}
              onChange={(e) => setFractionalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFractionalConfirm();
              }}
              placeholder={`Máx: ${fractionalMax}`}
              className="h-14 text-2xl font-bold text-center"
            />
          </div>

          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold"
            disabled={
              !fractionalInput ||
              parseInt(fractionalInput) <= 0 ||
              parseInt(fractionalInput) > fractionalMax ||
              recordFractionalMut.isPending
            }
            onClick={handleFractionalConfirm}
          >
            {recordFractionalMut.isPending
              ? "Registrando..."
              : "Confirmar Quantidade"}
          </Button>

          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setScreen("scan_product");
              setFractionalInput("");
              setPendingAllocationId(null);
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Voltar
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: UOM INPUT — Solicitar fator de conversão ao operador
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "uom_input") {
    const handleUomConfirm = () => {
      const qty = parseInt(uomInput);
      if (!qty || qty <= 0) {
        toast.error("Informe uma quantidade válida (mínimo 1)");
        return;
      }
      if (!selectedOrderId || !pendingUomAllocationId) return;
      confirmUomMut.mutate({
        allocationId: pendingUomAllocationId,
        pickingOrderId: currentItem?.pickingOrderId ?? selectedOrderId,
        scannedCode: pendingUomScannedCode,
        unitsPerBox: qty,
      });
    };

    return (
      <CollectorLayout title="Fator de Conversão">
        <div className="space-y-4">
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
            <div className="h-6 w-6 text-orange-600 flex-shrink-0 mt-0.5 text-xl">&#9888;</div>
            <div>
              <p className="font-semibold text-orange-900">Unidade de medida não identificada</p>
              <p className="text-sm text-orange-700 mt-1">
                O código <span className="font-mono font-bold">{pendingUomScannedCode}</span> não possui fator de conversão cadastrado.
                Informe quantas unidades estão contidas nesta embalagem.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-1">
            <p className="font-bold text-gray-900">{pendingUomProductName || currentItem?.productName}</p>
            <p className="text-sm text-gray-500">{pendingUomProductSku || currentItem?.productSku}</p>
            {currentItem?.batch && (
              <p className="text-sm text-blue-700">Lote: {currentItem.batch}</p>
            )}
            <div className="pt-2 border-t border-gray-100 mt-2">
              <p className="text-xs text-gray-500">
                Este valor será salvo automaticamente no cadastro do produto.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">
              Quantidade de unidades por embalagem
            </label>
            <Input
              ref={uomInputRef}
              type="number"
              inputMode="numeric"
              min={1}
              value={uomInput}
              onChange={(e) => setUomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleUomConfirm();
              }}
              placeholder="Ex: 10, 12, 24..."
              className="h-14 text-2xl font-bold text-center"
            />
          </div>

          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold bg-orange-600 hover:bg-orange-700"
            disabled={
              !uomInput ||
              parseInt(uomInput) <= 0 ||
              confirmUomMut.isPending
            }
            onClick={handleUomConfirm}
          >
            {confirmUomMut.isPending
              ? "Salvando..."
              : "Confirmar Fator UOM"}
          </Button>

          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setScreen("scan_product");
              setUomInput("");
              setPendingUomAllocationId(null);
              setPendingUomScannedCode("");
              setTimeout(() => productInputRef.current?.focus(), 100);
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cancelar
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: FRACTION CONFIRM — Caixa fracionada excede saldo restante
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "fraction_confirm") {
    const handleFractionConfirm = () => {
      const qty = parseInt(fractionInput);
      if (!qty || qty <= 0) {
        toast.error("Informe uma quantidade válida (mínimo 1)");
        return;
      }
      if (qty > pendingFractionMax) {
        toast.error(`Quantidade não pode exceder o saldo restante: ${pendingFractionMax} un.`);
        return;
      }
      if (!pendingFractionAllocationId || !currentItem) return;
      confirmFractionMut.mutate({
        allocationId: pendingFractionAllocationId,
        pickingOrderId: currentItem.pickingOrderId,
        quantity: qty,
      });
    };

    return (
      <CollectorLayout title="Caixa Fracionada">
        <div className="space-y-4">
          <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-4 flex items-start gap-3">
            <div className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5 text-xl">&#9888;</div>
            <div>
              <p className="font-semibold text-yellow-900">Embalagem excede o saldo do pedido</p>
              <p className="text-sm text-yellow-800 mt-1">
                Esta embalagem contém <span className="font-bold">{pendingFractionUnitsPerBox} un</span>, mas o saldo restante é de apenas{" "}
                <span className="font-bold">{pendingFractionMax} un</span>.
              </p>
              <p className="text-sm text-yellow-700 mt-1">
                Informe quantas unidades estão sendo retiradas desta caixa fracionada.
              </p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-1">
            <p className="font-bold text-gray-900">{pendingFractionProductName || currentItem?.productName}</p>
            <p className="text-sm text-gray-500">{pendingFractionProductSku || currentItem?.productSku}</p>
            {currentItem?.batch && (
              <p className="text-sm text-blue-700">Lote: {currentItem.batch}</p>
            )}
            <p className="text-xs text-gray-400 font-mono mt-1">{pendingFractionScannedCode}</p>
            <div className="pt-2 border-t border-gray-100 mt-2 flex justify-between text-sm">
              <span className="text-gray-600">Saldo máximo:</span>
              <span className="font-bold text-gray-900">{pendingFractionMax} un</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">
              Quantidade a separar desta caixa (máx: {pendingFractionMax} un)
            </label>
            <Input
              ref={fractionInputRef}
              type="number"
              inputMode="numeric"
              min={1}
              max={pendingFractionMax}
              value={fractionInput}
              onChange={(e) => setFractionInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFractionConfirm();
              }}
              placeholder={`Máx: ${pendingFractionMax}`}
              className="h-14 text-2xl font-bold text-center"
            />
          </div>

          {/* Botões rápidos */}
          <div className="grid grid-cols-3 gap-2">
            {[Math.ceil(pendingFractionMax / 2), pendingFractionMax].filter((v, i, a) => a.indexOf(v) === i && v > 0).map((qty, idx) => (
              <Button
                key={`frac-${idx}-${qty}`}
                variant="outline"
                size="sm"
                onClick={() => setFractionInput(String(qty))}
                className="font-semibold"
              >
                {qty} un
              </Button>
            ))}
          </div>

          <Button
            size="lg"
            className="w-full h-14 text-base font-semibold bg-yellow-600 hover:bg-yellow-700"
            disabled={
              !fractionInput ||
              parseInt(fractionInput) <= 0 ||
              parseInt(fractionInput) > pendingFractionMax ||
              confirmFractionMut.isPending
            }
            onClick={handleFractionConfirm}
          >
            {confirmFractionMut.isPending
              ? "Registrando..."
              : "Confirmar Fracionamento"}
          </Button>

          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setScreen("scan_product");
              setFractionInput("");
              setPendingFractionAllocationId(null);
              setPendingFractionScannedCode("");
              setTimeout(() => productInputRef.current?.focus(), 100);
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cancelar
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: REPORT PROBLEM
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "report_problem") {
    const isLocation = reportTarget === "location";
    const locationReasons = [
      { value: "inaccessible", label: "Endereço inacessível" },
      { value: "damaged_label", label: "Etiqueta danificada" },
    ];
    const productReasons = [
      { value: "not_found", label: "Produto não encontrado" },
      { value: "damaged", label: "Produto avariado" },
      { value: "insufficient_quantity", label: "Quantidade insuficiente" },
    ];
    const reasons = isLocation ? locationReasons : productReasons;

    const handleSubmitReport = () => {
      if (!reportReason) {
        toast.error("Selecione o motivo");
        return;
      }
      if (!selectedOrderId) return;

      if (isLocation && currentLocation) {
        reportLocationMut.mutate({
          pickingOrderId: selectedOrderId,
          locationCode: currentLocation.locationCode,
          reason: reportReason as "inaccessible" | "damaged_label",
        });
      } else if (!isLocation && currentItem) {
        const availableQty =
          reportReason === "insufficient_quantity"
            ? parseInt(insufficientQtyInput) || 0
            : undefined;

        reportProductMut.mutate({
          pickingOrderId: selectedOrderId,
          allocationId: currentItem.allocationId,
          reason: reportReason as
            | "not_found"
            | "damaged"
            | "insufficient_quantity",
          availableQuantity: availableQty,
        });
      }
    }

    return (
      <CollectorLayout
        title={isLocation ? "Problema no Endereço" : "Reportar Falta/Avaria"}
      >
        <div className="space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="h-6 w-6 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-900">
                {isLocation
                  ? `Endereço: ${currentLocation?.locationCode}`
                  : `Produto: ${currentItem?.productName}`}
              </p>
              {!isLocation && currentItem?.batch && (
                <p className="text-sm text-red-700 mt-0.5">
                  Lote: {currentItem.batch}
                </p>
              )}
              <p className="text-sm text-red-700 mt-1">
                Selecione o motivo e confirme. O gerente será notificado.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-gray-700">Motivo:</p>
            <div className="space-y-2">
              {reasons.map((r) => (
                <button
                  key={r.value}
                  className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                    reportReason === r.value
                      ? "border-red-500 bg-red-50 text-red-900"
                      : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                  }`}
                  onClick={() => setReportReason(r.value)}
                >
                  <span className="font-medium">{r.label}</span>
                </button>
              ))}
            </div>
          </div>

          {reportReason === "insufficient_quantity" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">
                Quantidade que conseguiu separar:
              </label>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={currentItem?.quantity}
                value={insufficientQtyInput}
                onChange={(e) => setInsufQtyInput(e.target.value)}
                placeholder="Ex: 5"
                className="h-12 text-lg"
              />
            </div>
          )}

          <Button
            size="lg"
            className="w-full h-14 bg-red-600 hover:bg-red-700 text-white font-semibold"
            disabled={
              !reportReason ||
              reportLocationMut.isPending ||
              reportProductMut.isPending
            }
            onClick={handleSubmitReport}
          >
            {reportLocationMut.isPending || reportProductMut.isPending
              ? "Registrando..."
              : "Confirmar Ocorrência"}
          </Button>

          <Button
            variant="ghost"
            className="w-full"
            onClick={() =>
              setScreen(isLocation ? "scan_location" : "scan_product")
            }
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cancelar
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: LOCATION DONE
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "location_done") {
    // Verificar se há itens pendentes em TODA a rota (não apenas no endereço atual)
    const hasPendingItems = route.some(location => 
      location.items.some(item => 
        item.status === "pending" || item.status === "in_progress"
      )
    );
    const isLast = !hasPendingItems;
    return (
      <CollectorLayout title="Endereço Concluído">
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-center">
            <CheckCircle2 className="h-14 w-14 text-green-600 mx-auto mb-3" />
            <p className="text-xl font-bold text-green-900">
              Endereço concluído!
            </p>
            <p className="text-sm text-green-700 mt-1 font-medium">
              {currentLocation?.locationCode}
            </p>
          </div>

          {isLast ? (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
                <p className="font-semibold text-blue-900">
                  Todos os endereços foram visitados!
                </p>
                <p className="text-sm text-blue-700 mt-1">
                  Confirme para finalizar o pedido.
                </p>
              </div>
              <Button
                size="lg"
                className="w-full h-14 text-base font-semibold bg-green-600 hover:bg-green-700"
                onClick={handleComplete}
                disabled={completeMut.isPending}
              >
                {completeMut.isPending
                  ? "Finalizando..."
                  : "Finalizar Pedido"}
              </Button>
            </>
          ) : (
            <>
              <div className="bg-gray-50 rounded-xl p-4 text-center">
                <p className="text-sm text-gray-600">Próximo endereço:</p>
                <p className="text-2xl font-black text-gray-900 mt-1">
                  {route[locationIdx + 1]?.locationCode}
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  {route[locationIdx + 1]?.items.length} item(ns)
                  {route[locationIdx + 1]?.hasFractional && (
                    <span className="text-amber-600"> · ⚠ fracionado</span>
                  )}
                </p>
              </div>
              <Button
                size="lg"
                className="w-full h-14 text-base font-semibold"
                onClick={advanceLocation}
              >
                Ir para Próximo Endereço
                <ChevronRight className="h-5 w-5 ml-2" />
              </Button>
            </>
          )}

          <Button
            variant="ghost"
            className="w-full"
            onClick={handlePause}
            disabled={pauseMut.isPending}
          >
            <PauseCircle className="h-4 w-4 mr-2" />
            Pausar Separação
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: ALL DONE
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === "all_done") {
    return (
      <CollectorLayout title="Separação Finalizada">
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
            <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto mb-3" />
            <p className="text-2xl font-black text-green-900">Concluído!</p>
            {orderInfo && (
              <p className="text-sm text-green-700 mt-2">
                Onda {orderInfo.waveNumber} finalizada.
              </p>
            )}
          </div>
          <Button
            size="lg"
            className="w-full h-14 font-semibold"
            onClick={resetAll}
          >
            Novo Pedido
          </Button>
        </div>
      </CollectorLayout>
    );
  }

  return null;
}
