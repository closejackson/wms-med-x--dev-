/**
 * CollectorIntraHospitalar — Coletor de Rastreabilidade Intra-Hospitalar
 *
 * Interface Scan&Go para registro de checkpoints de pedidos dentro do
 * complexo hospitalar (docas e farmácias).
 *
 * Fluxo de telas:
 *  select_point → scan_point → select_status → scan_orders → confirm → done
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { CollectorLayout } from "../../components/CollectorLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";
import {
  MapPin,
  CheckCircle2,
  AlertTriangle,
  Scan,
  ArrowLeft,
  Building2,
  Truck,
  Package,
  Clock,
  ChevronRight,
  X,
  Plus,
  RotateCcw,
  Home,
  Camera,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen =
  | "select_point"       // Selecionar ou bipar ponto de entrega
  | "select_status"      // Selecionar o tipo de checkpoint
  | "scan_nf"            // Bipar NF ou pedido (chegada na doca)
  | "scan_orders"        // Bipar/adicionar pedidos
  | "confirm"            // Confirmar e enviar batch
  | "done";              // Resultado

type ScanMode = "nf" | "order";

interface NfResult {
  type: "nfe" | "order";
  nfeKey: string | null;
  nfeNumber: string | null;
  orders: { orderId: number; customerOrderNumber: string }[];
}

type DeliveryStatus =
  | "ARRIVED_COMPLEX"
  | "DEPARTED_TO_UNIT"
  | "ARRIVED_UNIT"
  | "RECEIVING_STARTED"
  | "RECEIVE_COMPLETE";

interface DeliveryPoint {
  id: number;
  name: string;
  type: "DOCK" | "PHARMACY";
  externalCode: string;
  floor?: string | null;
}

interface ScannedOrder {
  orderId: number;
  orderNumber: string;
  status: "pending" | "success" | "error";
  error?: string;
}

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  ARRIVED_COMPLEX: "Chegou à Doca",
  DEPARTED_TO_UNIT: "Saiu para a Farmácia",
  ARRIVED_UNIT: "Chegou à Farmácia",
  RECEIVING_STARTED: "Recebimento Iniciado",
  RECEIVE_COMPLETE: "Recebimento Concluído",
};

const STATUS_BY_POINT_TYPE: Record<"DOCK" | "PHARMACY", DeliveryStatus[]> = {
  DOCK: ["ARRIVED_COMPLEX", "DEPARTED_TO_UNIT"],
  PHARMACY: ["ARRIVED_UNIT", "RECEIVING_STARTED", "RECEIVE_COMPLETE"],
};

const STATUS_COLORS: Record<DeliveryStatus, string> = {
  ARRIVED_COMPLEX: "bg-blue-500",
  DEPARTED_TO_UNIT: "bg-yellow-500",
  ARRIVED_UNIT: "bg-purple-500",
  RECEIVING_STARTED: "bg-orange-500",
  RECEIVE_COMPLETE: "bg-green-500",
};

// ─── Componente ───────────────────────────────────────────────────────────────

export function CollectorIntraHospitalar() {
  const [screen, setScreen] = useState<Screen>("select_point");
  const [selectedPoint, setSelectedPoint] = useState<DeliveryPoint | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<DeliveryStatus | null>(null);
  const [scannedOrders, setScannedOrders] = useState<ScannedOrder[]>([]);
  const [orderInput, setOrderInput] = useState("");
  const [pointInput, setPointInput] = useState("");
  const [batchResult, setBatchResult] = useState<{
    successCount: number;
    failCount: number;
    results: { orderId: number; orderNumber?: string; success: boolean; error?: string }[];
  } | null>(null);
  const [showScanner, setShowScanner] = useState<"point" | "order" | "nf" | null>(null);
  const [nfInput, setNfInput] = useState("");
  const [scanMode, setScanMode] = useState<ScanMode>("nf");
  const [nfResult, setNfResult] = useState<NfResult | null>(null);
  const [nfLoading, setNfLoading] = useState(false);

  const orderInputRef = useRef<HTMLInputElement>(null);
  const pointInputRef = useRef<HTMLInputElement>(null);
  const nfInputRef = useRef<HTMLInputElement>(null);

  // ─── Queries ────────────────────────────────────────────────────────────────

  const { data: deliveryPoints, isLoading: loadingPoints } = trpc.intraHospital.listDeliveryPoints.useQuery({});

  const batchMut = trpc.intraHospital.batchRegisterCheckpoint.useMutation({
    onSuccess: (data) => {
      setBatchResult(data);
      setScreen("done");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const utils = trpc.useUtils();

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handlePointScan = useCallback(async (code: string) => {
    if (!code.trim()) return;
    const point = deliveryPoints?.find(p => p.externalCode === code.trim());
    if (point) {
      setSelectedPoint(point as DeliveryPoint);
      setScreen("select_status");
      toast.success(`Ponto identificado: ${point.name}`);
    } else {
      toast.error(`Ponto "${code}" não encontrado. Verifique o QR Code.`);
    }
    setPointInput("");
  }, [deliveryPoints]);

  const handleOrderScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;

    try {
      // Resolve o código (customerOrderNumber ou ID numérico) via backend
      const resolved = await utils.intraHospital.resolveOrderByCode.fetch({ code: value });

      // Verificar duplicidade
      if (scannedOrders.some(o => o.orderId === resolved.orderId)) {
        toast.warning(`Pedido ${resolved.customerOrderNumber} já foi adicionado.`);
        setOrderInput("");
        return;
      }

      setScannedOrders(prev => [...prev, {
        orderId: resolved.orderId,
        orderNumber: resolved.customerOrderNumber,
        status: "pending",
      }]);
      setOrderInput("");
      toast.success(`Pedido ${resolved.customerOrderNumber} adicionado.`);
    } catch (err: any) {
      toast.error(err?.message ?? "Pedido não encontrado. Verifique o código.");
      setOrderInput("");
    }
  }, [scannedOrders, utils]);

  const handleRemoveOrder = (orderId: number) => {
    setScannedOrders(prev => prev.filter(o => o.orderId !== orderId));
  };

  const handleConfirm = () => {
    if (!selectedPoint || !selectedStatus || scannedOrders.length === 0) return;
    batchMut.mutate({
      orderIds: scannedOrders.map(o => o.orderId),
      deliveryPointId: selectedPoint.id,
      status: selectedStatus,
    });
  };

  const handleNfScan = useCallback(async (raw: string) => {
    const value = raw.trim().replace(/\s/g, "");
    if (!value) return;
    setNfLoading(true);
    try {
      const result = await utils.intraHospital.getOrdersByNfeKey.fetch({ code: value });
      setNfResult(result);
      // Pré-preenche a lista de pedidos
      const newOrders = result.orders
        .filter(o => !scannedOrders.some(s => s.orderId === o.orderId))
        .map(o => ({ orderId: o.orderId, orderNumber: o.customerOrderNumber, status: "pending" as const }));
      if (newOrders.length > 0) {
        setScannedOrders(prev => [...prev, ...newOrders]);
      }
      if (result.type === "nfe") {
        toast.success(`NF-e encontrada: ${result.nfeNumber ?? result.nfeKey?.slice(-6)} · ${result.orders.length} pedido(s)`);
      } else {
        toast.success(`Pedido ${result.orders[0].customerOrderNumber} adicionado.`);
      }
      setNfInput("");
    } catch (err: any) {
      toast.error(err?.message ?? "Código não encontrado.");
      setNfInput("");
    } finally {
      setNfLoading(false);
    }
  }, [scannedOrders, utils]);

  const handleCameraScan = useCallback((code: string) => {
    setShowScanner(null);
    if (showScanner === "point") {
      handlePointScan(code);
    } else if (showScanner === "order") {
      handleOrderScan(code);
    } else if (showScanner === "nf") {
      handleNfScan(code);
    }
  }, [showScanner, handlePointScan, handleOrderScan, handleNfScan]);

  const handleReset = () => {
    setScreen("select_point");
    setSelectedPoint(null);
    setSelectedStatus(null);
    setScannedOrders([]);
    setOrderInput("");
    setPointInput("");
    setNfInput("");
    setNfResult(null);
    setScanMode("nf");
    setBatchResult(null);
  };

  // Focar input ao mudar de tela
  useEffect(() => {
    if (screen === "select_point") {
      setTimeout(() => pointInputRef.current?.focus(), 100);
    } else if (screen === "scan_orders") {
      setTimeout(() => orderInputRef.current?.focus(), 100);
    } else if (screen === "scan_nf") {
      setTimeout(() => nfInputRef.current?.focus(), 100);
    }
  }, [screen]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
    {/* ── Scanner de câmera (overlay fullscreen) ── */}
    {showScanner && (
      <BarcodeScanner
        onScan={handleCameraScan}
        onClose={() => setShowScanner(null)}
      />
    )}
    <CollectorLayout
      title="Rastreio Intra-Hospitalar"
      headerActions={
        <div className="flex items-center gap-1">
          <Link href="/collector">
            <Button variant="ghost" size="sm" className="text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1.5 h-8 px-2">
              <ArrowLeft className="h-4 w-4" />
              <span className="text-xs hidden sm:inline">Voltar</span>
            </Button>
          </Link>
          <Link href="/home">
            <Button variant="ghost" size="sm" className="text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1.5 h-8 px-2">
              <Home className="h-4 w-4" />
              <span className="text-xs hidden sm:inline">Home</span>
            </Button>
          </Link>
        </div>
      }
    >
      <div className="max-w-lg mx-auto space-y-4">

        {/* ── TELA: SELECIONAR PONTO ── */}
        {screen === "select_point" && (
          <div className="space-y-4">
            <div className="bg-slate-800 rounded-xl p-4 text-white">
              <div className="flex items-center gap-2 mb-3">
                <MapPin className="h-5 w-5 text-blue-400" />
                <h2 className="text-lg font-semibold">Selecionar Ponto de Entrega</h2>
              </div>
              <p className="text-slate-400 text-sm mb-4">
                Bipe o QR Code do ponto ou selecione na lista abaixo.
              </p>

              {/* Campo de scan */}
              <div className="flex gap-2 mb-3">
                <Input
                  ref={pointInputRef}
                  value={pointInput}
                  onChange={e => setPointInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handlePointScan(pointInput)}
                  placeholder="Bipe o QR Code do ponto..."
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 flex-1"
                  autoComplete="off"
                />
                <Button
                  size="icon"
                  variant="outline"
                  className="bg-slate-700 border-slate-600 text-white hover:bg-slate-600 shrink-0"
                  onClick={() => setShowScanner("point")}
                  title="Usar câmera"
                >
                  <Camera className="h-5 w-5" />
                </Button>
              </div>
              {pointInput && (
                <Button
                  className="w-full mb-4"
                  onClick={() => handlePointScan(pointInput)}
                >
                  <Scan className="h-4 w-4 mr-2" />
                  Confirmar Código
                </Button>
              )}
            </div>

            {/* Lista de pontos */}
            {loadingPoints ? (
              <div className="text-center text-slate-500 py-8">Carregando pontos...</div>
            ) : (
              <div className="space-y-2">
                {/* Docas */}
                {(deliveryPoints?.filter(p => p.type === "DOCK")?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                      <Truck className="h-3 w-3" /> Docas de Descarregamento
                    </p>
                    {deliveryPoints?.filter(p => p.type === "DOCK").map(point => (
                      <button
                        key={point.id}
                        onClick={() => { setSelectedPoint(point as DeliveryPoint); setScreen("select_status"); }}
                        className="w-full text-left bg-white rounded-lg p-3 mb-2 border border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium text-slate-800">{point.name}</p>
                          <p className="text-xs text-slate-500">Código: {point.externalCode}{point.floor ? ` · ${point.floor}` : ""}</p>
                        </div>
                        <Badge className="bg-blue-100 text-blue-700">DOCA</Badge>
                      </button>
                    ))}
                  </div>
                )}

                {/* Farmácias */}
                {(deliveryPoints?.filter(p => p.type === "PHARMACY")?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                      <Building2 className="h-3 w-3" /> Farmácias
                    </p>
                    {deliveryPoints?.filter(p => p.type === "PHARMACY").map(point => (
                      <button
                        key={point.id}
                        onClick={() => { setSelectedPoint(point as DeliveryPoint); setScreen("select_status"); }}
                        className="w-full text-left bg-white rounded-lg p-3 mb-2 border border-slate-200 hover:border-purple-400 hover:bg-purple-50 transition-colors flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium text-slate-800">{point.name}</p>
                          <p className="text-xs text-slate-500">Código: {point.externalCode}{point.floor ? ` · ${point.floor}` : ""}</p>
                        </div>
                        <Badge className="bg-purple-100 text-purple-700">FARMÁCIA</Badge>
                      </button>
                    ))}
                  </div>
                )}

                {deliveryPoints?.length === 0 && (
                  <div className="text-center text-slate-500 py-8 bg-white rounded-lg border border-dashed">
                    <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>Nenhum ponto de entrega cadastrado.</p>
                    <p className="text-xs mt-1">Acesse Intra-Hospitalar → Pontos de Entrega para cadastrar.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── TELA: SELECIONAR STATUS ── */}
        {screen === "select_status" && selectedPoint && (
          <div className="space-y-4">
            <div className="bg-slate-800 rounded-xl p-4 text-white">
              <button onClick={() => setScreen("select_point")} className="flex items-center gap-1 text-slate-400 text-sm mb-3 hover:text-white">
                <ArrowLeft className="h-4 w-4" /> Trocar ponto
              </button>
              <div className="flex items-center gap-2 mb-1">
                {selectedPoint.type === "DOCK"
                  ? <Truck className="h-5 w-5 text-blue-400" />
                  : <Building2 className="h-5 w-5 text-purple-400" />
                }
                <h2 className="text-lg font-semibold">{selectedPoint.name}</h2>
              </div>
              <p className="text-slate-400 text-sm">Selecione o tipo de movimentação:</p>
            </div>

            <div className="space-y-2">
              {STATUS_BY_POINT_TYPE[selectedPoint.type].map(status => (
                <button
                  key={status}
                  onClick={() => {
                    setSelectedStatus(status);
                    // ARRIVED_COMPLEX: fluxo por NF ou pedido
                    if (status === "ARRIVED_COMPLEX") {
                      setScannedOrders([]);
                      setNfResult(null);
                      setScanMode("nf");
                      setScreen("scan_nf");
                    } else {
                      setScreen("scan_orders");
                    }
                  }}
                  className="w-full text-left bg-white rounded-lg p-4 border border-slate-200 hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${STATUS_COLORS[status]}`} />
                    <span className="font-medium text-slate-800">{STATUS_LABELS[status]}</span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── TELA: SCAN NF / PEDIDO (chegada na doca) ── */}
        {screen === "scan_nf" && selectedPoint && selectedStatus && (
          <div className="space-y-4">
            <div className="bg-slate-800 rounded-xl p-4 text-white">
              <button onClick={() => setScreen("select_status")} className="flex items-center gap-1 text-slate-400 text-sm mb-3 hover:text-white">
                <ArrowLeft className="h-4 w-4" /> Voltar
              </button>
              <div className="flex items-center gap-2 mb-1">
                <Truck className="h-5 w-5 text-blue-400" />
                <h2 className="text-lg font-semibold">Chegada na Doca</h2>
              </div>
              <p className="text-slate-400 text-sm">{selectedPoint.name}</p>
            </div>

            {/* Toggle NF / Pedido */}
            <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-3">
              <div className="flex gap-2 mb-1">
                <button
                  onClick={() => { setScanMode("nf"); setNfInput(""); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    scanMode === "nf"
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  Bipar NF-e
                </button>
                <button
                  onClick={() => { setScanMode("order"); setNfInput(""); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    scanMode === "order"
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  Bipar Pedido
                </button>
              </div>

              <p className="text-xs text-slate-500">
                {scanMode === "nf"
                  ? "Bipe o código de barras da NF-e (chave de acesso de 44 dígitos). Todos os pedidos vinculados serão registrados automaticamente."
                  : "Bipe o número do pedido para adicionar individualmente."}
              </p>

              <div className="flex gap-2">
                <Input
                  ref={nfInputRef}
                  value={nfInput}
                  onChange={e => setNfInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleNfScan(nfInput)}
                  placeholder={scanMode === "nf" ? "Chave NF-e (44 dígitos)..." : "Número do pedido..."}
                  className="flex-1"
                  autoComplete="off"
                  disabled={nfLoading}
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setShowScanner("nf")}
                  title="Usar câmera"
                  disabled={nfLoading}
                >
                  <Camera className="h-5 w-5" />
                </Button>
                <Button
                  size="icon"
                  onClick={() => handleNfScan(nfInput)}
                  disabled={!nfInput.trim() || nfLoading}
                >
                  {nfLoading ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Pedidos adicionados */}
            {scannedOrders.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700 flex items-center gap-1">
                    <Package className="h-4 w-4" />
                    {scannedOrders.length} pedido(s) para registrar
                  </p>
                  {nfResult?.type === "nfe" && nfResult.nfeNumber && (
                    <span className="text-xs text-slate-400">NF-e {nfResult.nfeNumber}</span>
                  )}
                </div>
                <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {scannedOrders.map(order => (
                    <div key={order.orderId} className="flex items-center justify-between p-3">
                      <span className="text-sm font-mono text-slate-800">#{order.orderNumber}</span>
                      <button
                        onClick={() => handleRemoveOrder(order.orderId)}
                        className="text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button
              className="w-full h-14 text-base font-semibold"
              disabled={scannedOrders.length === 0 || batchMut.isPending}
              onClick={() => setScreen("confirm")}
            >
              <CheckCircle2 className="h-5 w-5 mr-2" />
              Confirmar {scannedOrders.length} Pedido(s)
            </Button>
          </div>
        )}

        {/* ── TELA: BIPAR PEDIDOS ── */}
        {screen === "scan_orders" && selectedPoint && selectedStatus && (
          <div className="space-y-4">
            <div className="bg-slate-800 rounded-xl p-4 text-white">
              <button onClick={() => setScreen("select_status")} className="flex items-center gap-1 text-slate-400 text-sm mb-3 hover:text-white">
                <ArrowLeft className="h-4 w-4" /> Voltar
              </button>
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-3 h-3 rounded-full ${STATUS_COLORS[selectedStatus]}`} />
                <h2 className="text-lg font-semibold">{STATUS_LABELS[selectedStatus]}</h2>
              </div>
              <p className="text-slate-400 text-sm">{selectedPoint.name}</p>
            </div>

            {/* Campo de scan de pedidos */}
            <div className="bg-white rounded-xl p-4 border border-slate-200 space-y-3">
              <p className="text-sm font-medium text-slate-700 flex items-center gap-1">
                <Scan className="h-4 w-4" /> Bipe ou digite o número do pedido:
              </p>
              <div className="flex gap-2">
                <Input
                  ref={orderInputRef}
                  value={orderInput}
                  onChange={e => setOrderInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleOrderScan(orderInput)}
                  placeholder="Número do pedido (ex: PED-001)..."
                  className="flex-1"
                  autoComplete="off"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setShowScanner("order")}
                  title="Usar câmera"
                >
                  <Camera className="h-5 w-5" />
                </Button>
                <Button
                  size="icon"
                  onClick={() => handleOrderScan(orderInput)}
                  disabled={!orderInput.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

            </div>

            {/* Lista de pedidos adicionados */}
            {scannedOrders.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700 flex items-center gap-1">
                    <Package className="h-4 w-4" />
                    {scannedOrders.length} pedido(s) adicionado(s)
                  </p>
                </div>
                <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {scannedOrders.map(order => (
                    <div key={order.orderId} className="flex items-center justify-between p-3">
                      <span className="text-sm font-mono text-slate-800">#{order.orderNumber}</span>
                      <button
                        onClick={() => handleRemoveOrder(order.orderId)}
                        className="text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Botão confirmar */}
            <Button
              className="w-full h-14 text-base font-semibold"
              disabled={scannedOrders.length === 0 || batchMut.isPending}
              onClick={() => setScreen("confirm")}
            >
              <CheckCircle2 className="h-5 w-5 mr-2" />
              Confirmar {scannedOrders.length} Pedido(s)
            </Button>
          </div>
        )}

        {/* ── TELA: CONFIRMAR ── */}
        {screen === "confirm" && selectedPoint && selectedStatus && (
          <div className="space-y-4">
            <div className="bg-slate-800 rounded-xl p-4 text-white">
              <h2 className="text-lg font-semibold mb-1">Confirmar Registro</h2>
              <p className="text-slate-400 text-sm">Verifique os dados antes de confirmar.</p>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
              <div className="p-4 flex items-center gap-3">
                {selectedPoint.type === "DOCK"
                  ? <Truck className="h-5 w-5 text-blue-500" />
                  : <Building2 className="h-5 w-5 text-purple-500" />
                }
                <div>
                  <p className="text-xs text-slate-500">Ponto de Entrega</p>
                  <p className="font-semibold text-slate-800">{selectedPoint.name}</p>
                </div>
              </div>
              <div className="p-4 flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full ${STATUS_COLORS[selectedStatus]}`} />
                <div>
                  <p className="text-xs text-slate-500">Tipo de Movimentação</p>
                  <p className="font-semibold text-slate-800">{STATUS_LABELS[selectedStatus]}</p>
                </div>
              </div>
              <div className="p-4 flex items-center gap-3">
                <Package className="h-5 w-5 text-slate-400" />
                <div>
                  <p className="text-xs text-slate-500">Pedidos</p>
                  <p className="font-semibold text-slate-800">{scannedOrders.length} pedido(s)</p>
                  <p className="text-xs text-slate-400 font-mono">
                    {scannedOrders.map(o => `#${o.orderNumber}`).join(", ")}
                  </p>
                </div>
              </div>

            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setScreen("scan_orders")}
                disabled={batchMut.isPending}
              >
                <ArrowLeft className="h-4 w-4 mr-2" /> Voltar
              </Button>
              <Button
                className="flex-1 h-12 font-semibold"
                onClick={handleConfirm}
                disabled={batchMut.isPending}
              >
                {batchMut.isPending ? (
                  <span className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Registrando...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" /> Confirmar
                  </span>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* ── TELA: RESULTADO ── */}
        {screen === "done" && batchResult && (
          <div className="space-y-4">
            <div className={`rounded-xl p-5 text-white ${batchResult.failCount === 0 ? "bg-green-600" : "bg-yellow-600"}`}>
              <div className="flex items-center gap-2 mb-2">
                {batchResult.failCount === 0
                  ? <CheckCircle2 className="h-6 w-6" />
                  : <AlertTriangle className="h-6 w-6" />
                }
                <h2 className="text-xl font-bold">
                  {batchResult.failCount === 0 ? "Registrado com Sucesso!" : "Registrado com Alertas"}
                </h2>
              </div>
              <p className="text-sm opacity-90">
                {batchResult.successCount} pedido(s) registrado(s) em <strong>{selectedPoint?.name}</strong>
                {batchResult.failCount > 0 && ` · ${batchResult.failCount} com erro`}
              </p>
            </div>

            {/* Detalhes dos resultados */}
            {batchResult.results.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-64 overflow-y-auto">
                {batchResult.results.map(r => (
                  <div key={r.orderId} className="flex items-center justify-between p-3">
                    <span className="text-sm font-mono text-slate-700">
                      #{r.orderNumber ?? r.orderId}
                    </span>
                    {r.success
                      ? <Badge className="bg-green-100 text-green-700">OK</Badge>
                      : <div className="text-right">
                          <Badge className="bg-red-100 text-red-700">Erro</Badge>
                          <p className="text-xs text-red-500 mt-1 max-w-40 text-right">{r.error}</p>
                        </div>
                    }
                  </div>
                ))}
              </div>
            )}

            <Button className="w-full h-12 font-semibold" onClick={handleReset}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Nova Movimentação
            </Button>
          </div>
        )}

      </div>
    </CollectorLayout>
    </>
  );
}
