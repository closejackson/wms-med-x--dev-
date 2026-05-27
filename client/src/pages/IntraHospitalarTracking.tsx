/**
 * IntraHospitalarTracking.tsx
 * Dashboard de Rastreabilidade Intra-Hospitalar
 *
 * Exibe todos os pedidos com seus checkpoints em uma timeline visual,
 * com filtros por status, ponto de entrega, data e número do pedido.
 */
import { useState, useMemo } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Building2,
  Truck,
  CheckCircle2,
  Clock,
  Search,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Package,
  MapPin,
  User,
  Calendar,
  AlertCircle,
  Filter,
  Activity,
  ArrowLeft,
  Home,
  Eye,
  Boxes,
} from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type DeliveryStatus =
  | "ARRIVED_COMPLEX"
  | "DEPARTED_TO_UNIT"
  | "ARRIVED_UNIT"
  | "RECEIVING_STARTED"
  | "RECEIVE_COMPLETE";

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  ARRIVED_COMPLEX: "Chegou à Doca",
  DEPARTED_TO_UNIT: "Saiu para a Farmácia",
  ARRIVED_UNIT: "Chegou à Farmácia",
  RECEIVING_STARTED: "Recebimento Iniciado",
  RECEIVE_COMPLETE: "Recebimento Concluído",
};

const STATUS_ORDER: DeliveryStatus[] = [
  "ARRIVED_COMPLEX",
  "DEPARTED_TO_UNIT",
  "ARRIVED_UNIT",
  "RECEIVING_STARTED",
  "RECEIVE_COMPLETE",
];

// Cores por status
const STATUS_CONFIG: Record<DeliveryStatus, { bg: string; text: string; border: string; dot: string; icon: React.FC<{ className?: string }> }> = {
  ARRIVED_COMPLEX: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-500",
    icon: Truck,
  },
  DEPARTED_TO_UNIT: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-500",
    icon: Truck,
  },
  ARRIVED_UNIT: {
    bg: "bg-purple-50",
    text: "text-purple-700",
    border: "border-purple-200",
    dot: "bg-purple-500",
    icon: Building2,
  },
  RECEIVING_STARTED: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    dot: "bg-orange-500",
    icon: Package,
  },
  RECEIVE_COMPLETE: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
    icon: CheckCircle2,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateShort(date: Date | string): string {
  return new Date(date).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Componente: Badge de status ──────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as DeliveryStatus];
  if (!cfg) return <Badge variant="outline">{status}</Badge>;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <Icon className="h-3 w-3" />
      {STATUS_LABELS[status as DeliveryStatus] ?? status}
    </span>
  );
}

// ─── Componente: Barra de progresso do pedido ─────────────────────────────────

function OrderProgressBar({ lastStatus, isComplete }: { lastStatus: string; isComplete: boolean }) {
  const currentIdx = STATUS_ORDER.indexOf(lastStatus as DeliveryStatus);
  return (
    <div className="flex items-center gap-0.5 mt-2">
      {STATUS_ORDER.map((s, idx) => {
        const done = idx <= currentIdx;
        const cfg = STATUS_CONFIG[s];
        return (
          <div key={s} className="flex items-center flex-1">
            <div
              className={`h-2 flex-1 rounded-full transition-all ${done ? cfg.dot : "bg-slate-200"}`}
              title={STATUS_LABELS[s]}
            />
            {idx < STATUS_ORDER.length - 1 && (
              <div className={`w-1 h-0.5 ${done && idx < currentIdx ? cfg.dot : "bg-slate-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Componente: Timeline de checkpoints ──────────────────────────────────────

interface TimelineEntry {
  id: number;
  status: string;
  statusLabel: string;
  timestamp: Date | string;
  pointName: string | null;
  pointType: string | null;
  pointFloor: string | null;
  userName: string | null;
  notes: string | null;
  leadTimeFormatted: string | null;
}

function OrderTimeline({ timeline }: { timeline: TimelineEntry[] }) {
  return (
    <div className="relative pl-6 space-y-0">
      {/* Linha vertical */}
      <div className="absolute left-2.5 top-3 bottom-3 w-0.5 bg-slate-200" />
      {timeline.map((entry, idx) => {
        const cfg = STATUS_CONFIG[entry.status as DeliveryStatus];
        const isLast = idx === timeline.length - 1;
        return (
          <div key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
            {/* Dot */}
            <div className={`absolute -left-[1.35rem] mt-0.5 w-4 h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center ${cfg?.dot ?? "bg-slate-400"}`}>
              {isLast && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
            </div>
            {/* Conteúdo */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className={`text-xs font-semibold ${cfg?.text ?? "text-slate-700"}`}>
                  {entry.statusLabel}
                </span>
                {entry.leadTimeFormatted && (
                  <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="h-3 w-3" />
                    +{entry.leadTimeFormatted}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {formatDateTime(entry.timestamp)}
                </span>
                {entry.pointName && (
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {entry.pointName}
                    {entry.pointFloor ? ` · ${entry.pointFloor}` : ""}
                  </span>
                )}
                {entry.userName && (
                  <span className="flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {entry.userName}
                  </span>
                )}
              </div>
              {entry.notes && (
                <p className="mt-1 text-xs text-slate-400 italic">{entry.notes}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Componente: Card de pedido ───────────────────────────────────────────────

interface OrderCardProps {
  order: {
    orderId: number;
    customerOrderNumber: string;
    orderStatus: string | null;
    lastDeliveryStatus: string;
    lastDeliveryStatusLabel: string;
    lastPointName: string | null;
    lastPointType: string | null;
    lastTimestamp: Date | string;
    isComplete: boolean;
    checkpointCount: number;
    totalFormatted: string | null;
    totalItems: number | null;
    totalQuantity: number | null;
    totalVolumes: number | null;
    timeline: TimelineEntry[];
  };
}

function OrderDetailsModal({ orderId, orderNumber, onClose }: { orderId: number; orderNumber: string; onClose: () => void }) {
  const { data, isLoading } = trpc.intraHospital.getOrderDetails.useQuery({ orderId });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-indigo-600" />
            Detalhes do Pedido #{orderNumber}
          </DialogTitle>
        </DialogHeader>
        {isLoading && <p className="text-sm text-slate-500 py-4 text-center">Carregando...</p>}
        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="bg-slate-100 rounded-lg px-3 py-1.5 font-medium">{data.totalItems} iten{data.totalItems !== 1 ? "s" : ""}</span>
              <span className="bg-slate-100 rounded-lg px-3 py-1.5 font-medium">{data.totalQuantity} unidades</span>
              {data.totalVolumes != null && (
                <span className="bg-indigo-50 text-indigo-700 rounded-lg px-3 py-1.5 font-medium flex items-center gap-1">
                  <Boxes className="h-4 w-4" />{data.totalVolumes} volume{data.totalVolumes !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead>Lote</TableHead>
                  <TableHead>Validade</TableHead>
                  <TableHead className="text-right">Qtd Pedida</TableHead>
                  <TableHead className="text-right">Qtd Separada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map(item => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.productSku ?? "—"}</TableCell>
                    <TableCell className="text-sm">{item.productName ?? "—"}</TableCell>
                    <TableCell className="text-xs">{item.batch ?? "—"}</TableCell>
                    <TableCell className="text-xs">{item.expiryDate ?? "—"}</TableCell>
                    <TableCell className="text-right text-sm">{item.requestedQuantity} {item.requestedUM === "box" ? "cx" : "un"}</TableCell>
                    <TableCell className="text-right text-sm">{item.pickedQuantity} {item.requestedUM === "box" ? "cx" : "un"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OrderCard({ order }: OrderCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const cfg = STATUS_CONFIG[order.lastDeliveryStatus as DeliveryStatus];

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${order.isComplete ? "border-emerald-200" : "border-slate-200"}`}>
      {/* Header do card */}
      <div
        className="flex items-start justify-between p-4 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-bold text-slate-800 text-base">
              #{order.customerOrderNumber}
            </span>
            {order.isComplete && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="h-3 w-3" /> Concluído
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mb-2">
            <span className="flex items-center gap-1">
              <Activity className="h-3 w-3" />
              {order.checkpointCount} checkpoint{order.checkpointCount !== 1 ? "s" : ""}
            </span>
            {order.totalFormatted && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Tempo total: {order.totalFormatted}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              Último: {formatDateShort(order.lastTimestamp)}
            </span>
            {order.lastPointName && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {order.lastPointName}
              </span>
            )}
            {order.totalVolumes != null ? (
              <span className="flex items-center gap-1 font-semibold text-indigo-600">
                <Boxes className="h-3 w-3" />
                {order.totalVolumes} volume{order.totalVolumes !== 1 ? "s" : ""}
              </span>
            ) : order.totalItems != null && order.totalItems > 0 ? (
              <span className="flex items-center gap-1 font-semibold text-indigo-600">
                <Package className="h-3 w-3" />
                {order.totalItems} iten{order.totalItems !== 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
          <StatusBadge status={order.lastDeliveryStatus} />
          <OrderProgressBar lastStatus={order.lastDeliveryStatus} isComplete={order.isComplete} />
        </div>
        <div className="flex items-center gap-1 ml-3 mt-0.5 flex-shrink-0">
          <button
            onClick={e => { e.stopPropagation(); setShowDetails(true); }}
            className="p-1 text-slate-400 hover:text-indigo-600 transition-colors"
            title="Ver detalhes"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button className="text-slate-400 hover:text-slate-600">
            {expanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {showDetails && (
        <OrderDetailsModal
          orderId={order.orderId}
          orderNumber={order.customerOrderNumber}
          onClose={() => setShowDetails(false)}
        />
      )}
      {/* Timeline expandida */}
      {expanded && (
        <>
          <Separator />
          <div className="p-4 bg-slate-50">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-1">
              <Activity className="h-3 w-3" /> Timeline de Checkpoints
            </p>
            <OrderTimeline timeline={order.timeline} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Componente: Estatísticas resumidas ───────────────────────────────────────

function SummaryStats({ orders }: { orders: OrderCardProps["order"][] }) {
  const total = orders.length;
  const complete = orders.filter(o => o.isComplete).length;
  const inTransit = orders.filter(o => o.lastDeliveryStatus === "DEPARTED_TO_UNIT").length;
  const atUnit = orders.filter(o =>
    o.lastDeliveryStatus === "ARRIVED_UNIT" || o.lastDeliveryStatus === "RECEIVING_STARTED"
  ).length;
  const atDock = orders.filter(o => o.lastDeliveryStatus === "ARRIVED_COMPLEX").length;

  const stats = [
    { label: "Total de Pedidos", value: total, color: "text-slate-800", bg: "bg-slate-100" },
    { label: "Concluídos", value: complete, color: "text-emerald-700", bg: "bg-emerald-50" },
    { label: "Em Trânsito", value: inTransit, color: "text-amber-700", bg: "bg-amber-50" },
    { label: "Na Farmácia", value: atUnit, color: "text-purple-700", bg: "bg-purple-50" },
    { label: "Na Doca", value: atDock, color: "text-blue-700", bg: "bg-blue-50" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {stats.map(s => (
        <div key={s.label} className={`rounded-xl p-3 border ${s.bg} border-transparent`}>
          <p className="text-xs text-slate-500 mb-1">{s.label}</p>
          <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function IntraHospitalarTracking() {
  const { user } = useAuth();
  const isGlobalAdmin = user?.tenantId === 1;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [pointFilter, setPointFilter] = useState<string>("ALL");
  const [selectedTenantId, setSelectedTenantId] = useState<number | undefined>(undefined);

  const { data: tenantsList } = trpc.tenants.list.useQuery(undefined, { enabled: isGlobalAdmin });

  // Buscar pontos de entrega para o filtro
  const { data: deliveryPoints } = trpc.intraHospital.listDeliveryPoints.useQuery({
    includeInactive: false,
    tenantId: isGlobalAdmin ? selectedTenantId : undefined,
  });

  // Buscar pedidos com checkpoints
  const {
    data: orders,
    isLoading,
    error,
    refetch,
    isFetching,
  } = trpc.intraHospital.listOrdersWithCheckpoints.useQuery(
    {
      status: statusFilter === "ALL" ? undefined : statusFilter,
      deliveryPointId: pointFilter !== "ALL" ? Number(pointFilter) : undefined,
      limit: 200,
      tenantId: isGlobalAdmin ? selectedTenantId : undefined,
    },
    {
      refetchInterval: 30_000, // atualiza a cada 30s
    }
  );

  // Filtro de busca por número do pedido (client-side)
  const filtered = useMemo(() => {
    if (!orders) return [];
    if (!search.trim()) return orders;
    const q = search.trim().toLowerCase();
    return orders.filter(o => o.customerOrderNumber.toLowerCase().includes(q));
  }, [orders, search]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/intra-hospitalar">
              <Button variant="ghost" size="sm" className="flex items-center gap-1.5 text-slate-600 hover:text-slate-900">
                <ArrowLeft className="h-4 w-4" />
                Voltar
              </Button>
            </Link>
            <div className="w-px h-6 bg-slate-200" />
            <div>
              <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <Activity className="h-5 w-5 text-blue-600" />
                Rastreabilidade Intra-Hospitalar
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Timeline completa de checkpoints por pedido
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/home">
              <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white flex items-center gap-1.5">
                <Home className="h-4 w-4" />
                Home
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Atualizar
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-1">
            <Filter className="h-3 w-3" /> Filtros
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Filtro de cliente — apenas Global Admin */}
            {isGlobalAdmin && (
              <Select
                value={selectedTenantId ? String(selectedTenantId) : "ALL"}
                onValueChange={v => setSelectedTenantId(v === "ALL" ? undefined : Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos os clientes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todos os clientes</SelectItem>
                  {tenantsList?.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {/* Busca por número */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Buscar por número do pedido..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Filtro de status */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Status do checkpoint" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os status</SelectItem>
                {STATUS_ORDER.map(s => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Filtro de ponto de entrega */}
            <Select value={pointFilter} onValueChange={setPointFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Ponto de entrega" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os pontos</SelectItem>
                {deliveryPoints?.map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name} ({p.type === "DOCK" ? "Doca" : "Farmácia"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Estado de carregamento */}
        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 p-4">
                <Skeleton className="h-5 w-32 mb-2" />
                <Skeleton className="h-4 w-64 mb-3" />
                <Skeleton className="h-6 w-40" />
              </div>
            ))}
          </div>
        )}

        {/* Erro */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3 text-red-700">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <p className="text-sm">Erro ao carregar dados: {error.message}</p>
          </div>
        )}

        {/* Conteúdo */}
        {!isLoading && !error && (
          <>
            {/* Estatísticas */}
            {orders && orders.length > 0 && (
              <SummaryStats orders={filtered as OrderCardProps["order"][]} />
            )}

            {/* Contagem de resultados */}
            {orders && (
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-slate-500">
                  {filtered.length === 0
                    ? "Nenhum pedido encontrado"
                    : `${filtered.length} pedido${filtered.length !== 1 ? "s" : ""} encontrado${filtered.length !== 1 ? "s" : ""}`}
                  {search && ` para "${search}"`}
                </p>
                {isFetching && (
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Atualizando...
                  </span>
                )}
              </div>
            )}

            {/* Lista de pedidos */}
            {filtered.length > 0 ? (
              <div className="space-y-3">
                {filtered.map(order => (
                  <OrderCard key={order.orderId} order={order as OrderCardProps["order"]} />
                ))}
              </div>
            ) : (
              !isLoading && (
                <div className="bg-white rounded-xl border border-dashed border-slate-300 p-12 text-center">
                  <Activity className="h-10 w-10 mx-auto mb-3 text-slate-300" />
                  <p className="text-slate-500 font-medium">Nenhum pedido com checkpoints registrados</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Use o coletor Intra-Hospitalar para registrar movimentações de pedidos.
                  </p>
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
