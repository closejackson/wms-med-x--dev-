/**
 * IntraHospitalarDashboard.tsx
 * Dashboard de Performance — Módulo Intra-Hospitalar
 *
 * KPIs de tempo de ciclo, WIP por estágio, alertas de SLA
 * e distribuição de chegadas por hora.
 * Atualização automática a cada 30 segundos.
 */
import { useState, useMemo } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Home,
  Clock,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Truck,
  Building2,
  RefreshCw,
  Timer,
  Activity,
  Package,
  Calendar,
} from "lucide-react";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ─── Constantes ───────────────────────────────────────────────────────────────

const SLA_OPTIONS = [
  { label: "30 min", value: 30 },
  { label: "1h", value: 60 },
  { label: "2h", value: 120 },
  { label: "4h", value: 240 },
];

const STATUS_LABELS: Record<string, string> = {
  ARRIVED_COMPLEX:   "Chegou à Doca",
  DEPARTED_TO_UNIT:  "Saiu para a Farmácia",
  ARRIVED_UNIT:      "Chegou à Farmácia",
  RECEIVING_STARTED: "Recebimento Iniciado",
  RECEIVE_COMPLETE:  "Recebimento Concluído",
};

const STAGE_COLORS: Record<string, string> = {
  ARRIVED_COMPLEX:   "#3b82f6",
  DEPARTED_TO_UNIT:  "#f59e0b",
  ARRIVED_UNIT:      "#8b5cf6",
  RECEIVING_STARTED: "#ec4899",
  RECEIVE_COMPLETE:  "#10b981",
};

const BAR_COLORS = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd",
  "#7c3aed", "#4f46e5", "#818cf8",
];

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  color = "text-slate-700",
  loading,
}: {
  title: string;
  value: string | number | null;
  sub?: string;
  icon: React.ElementType;
  color?: string;
  loading?: boolean;
}) {
  return (
    <Card className="bg-white border border-slate-200 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide truncate">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-20 mt-1" />
            ) : (
              <p className={`text-2xl font-bold mt-1 ${color}`}>
                {value ?? "—"}
              </p>
            )}
            {sub && !loading && (
              <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
            )}
          </div>
          <div className={`p-2 rounded-lg bg-slate-50 ${color}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertRow({
  orderId,
  customerOrderNumber,
  currentStatus,
  pointName,
  maxFaseFormatted,
  slaExceededBy,
  slaMinutes,
}: {
  orderId: number;
  customerOrderNumber: string;
  currentStatus: string;
  pointName: string | null;
  maxFaseFormatted: string | null;
  slaExceededBy: number;
  slaMinutes: number;
}) {
  const severity = slaExceededBy > slaMinutes * 2 ? "high" : slaExceededBy > slaMinutes ? "medium" : "low";
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
      severity === "high"   ? "bg-red-50 border-red-200" :
      severity === "medium" ? "bg-orange-50 border-orange-200" :
                              "bg-yellow-50 border-yellow-200"
    }`}>
      <AlertTriangle className={`h-4 w-4 flex-shrink-0 ${
        severity === "high" ? "text-red-500" : severity === "medium" ? "text-orange-500" : "text-yellow-500"
      }`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-800">{customerOrderNumber}</span>
          <Badge variant="outline" className="text-xs">
            {STATUS_LABELS[currentStatus] ?? currentStatus}
          </Badge>
          {pointName && (
            <span className="text-xs text-slate-500">{pointName}</span>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-0.5">
          Tempo máximo: <span className="font-semibold">{maxFaseFormatted ?? "—"}</span>
          {slaExceededBy > 0 && (
            <span className={`ml-1 font-semibold ${
              severity === "high" ? "text-red-600" : severity === "medium" ? "text-orange-600" : "text-yellow-600"
            }`}>
              (+{slaExceededBy}min acima do SLA)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function IntraHospitalarDashboard() {
  const [slaMinutes, setSlaMinutes] = useState(120);
  const [selectedTenantId, setSelectedTenantId] = useState<number | undefined>(undefined);
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);

  const { user } = useAuth();
  const isGlobalAdmin = user?.tenantId === 1;

  // Busca lista de tenants (apenas para Global Admin)
  const tenantsQuery = trpc.tenants.list.useQuery(
    undefined,
    { enabled: isGlobalAdmin }
  );
  const tenants = tenantsQuery.data ?? [];

  // tenantId efetivo para as queries de analytics
  const queryTenantId = useMemo(() => {
    if (!isGlobalAdmin) return undefined;
    return selectedTenantId;
  }, [isGlobalAdmin, selectedTenantId]);

  const refetchInterval = 30_000; // 30 segundos

  const wipQuery = trpc.intraHospitalarAnalytics.getWipStatus.useQuery(
    { tenantId: queryTenantId, startDate, endDate },
    { refetchInterval }
  );

  const leadTimeQuery = trpc.intraHospitalarAnalytics.getLeadTimeStats.useQuery(
    { tenantId: queryTenantId, startDate, endDate },
    { refetchInterval }
  );

  const alertsQuery = trpc.intraHospitalarAnalytics.getAlerts.useQuery(
    { slaMinutes, tenantId: queryTenantId, startDate, endDate },
    { refetchInterval }
  );

  const arrivalsQuery = trpc.intraHospitalarAnalytics.getArrivalsByHour.useQuery(
    { days: 30, tenantId: queryTenantId, tzOffsetMinutes: -new Date().getTimezoneOffset(), startDate, endDate },
    { refetchInterval }
  );

  const waveDeliveryQuery = trpc.intraHospitalarAnalytics.getWaveDeliveryTimes.useQuery(
    { tenantId: queryTenantId, days: 30, limit: 50, startDate, endDate },
    { refetchInterval }
  );

  const isLoading = wipQuery.isLoading || leadTimeQuery.isLoading;

  const wip = wipQuery.data;
  const lead = leadTimeQuery.data;
  const alerts = alertsQuery.data ?? [];
  const arrivals = arrivalsQuery.data ?? [];

  const pctConcluidos = wip && wip.total > 0
    ? Math.round((wip.concluidos / wip.total) * 100)
    : 0;

  const pctAlertas = wip && wip.total > 0
    ? Math.round((alerts.length / wip.total) * 100)
    : 0;

  const waveChartData = useMemo(() => {
    return (waveDeliveryQuery.data ?? []).map(w => ({
      label: w.romaneio,
      data: w.inicioEntrega ? new Date(w.inicioEntrega).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "",
      horas: w.duracaoMinutos !== null ? Math.round((w.duracaoMinutos / 60) * 100) / 100 : null,
      duracaoLabel: w.duracaoLabel,
      totalOrders: w.totalOrders,
    }));
  }, [waveDeliveryQuery.data]);

  // Média do tempo total calculada sobre os romaneios (não por pedido)
  const avgWaveStats = useMemo(() => {
    const waves = (waveDeliveryQuery.data ?? []).filter(w => w.duracaoMinutos !== null);
    if (waves.length === 0) return null;
    const avg = waves.reduce((sum, w) => sum + (w.duracaoMinutos ?? 0), 0) / waves.length;
    const h = Math.floor(avg / 60);
    const m = Math.round(avg % 60);
    const label = h > 0 ? `${h}h ${m}min` : `${m}min`;
    return { avgMinutes: avg, label };
  }, [waveDeliveryQuery.data]);

  function handleRefresh() {
    wipQuery.refetch();
    leadTimeQuery.refetch();
    alertsQuery.refetch();
    arrivalsQuery.refetch();
    waveDeliveryQuery.refetch();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Link href="/intra-hospitalar">
              <Button variant="ghost" size="sm" className="gap-1.5 text-slate-600">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Voltar</span>
              </Button>
            </Link>
            <Link href="/home">
              <Button variant="ghost" size="sm" className="gap-1.5 text-slate-600">
                <Home className="h-4 w-4" />
                <span className="hidden sm:inline">Home</span>
              </Button>
            </Link>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-600" />
              <div>
                <h1 className="text-base font-bold text-slate-900 leading-tight">
                  Dashboard de Performance
                </h1>
                <p className="text-xs text-slate-500">Intra-Hospitalar · Atualiza a cada 30s</p>
              </div>
            </div>
          </div>
          {/* Filtro de período */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Calendar className="h-3.5 w-3.5 text-slate-400 hidden sm:block" />
            <input
              type="date"
              className="h-8 rounded-md border border-slate-200 px-2 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
              value={startDate ? startDate.toISOString().split('T')[0] : ''}
              onChange={e => setStartDate(e.target.value ? new Date(e.target.value + 'T00:00:00') : undefined)}
            />
            <span className="text-xs text-slate-400">até</span>
            <input
              type="date"
              className="h-8 rounded-md border border-slate-200 px-2 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
              value={endDate ? endDate.toISOString().split('T')[0] : ''}
              onChange={e => setEndDate(e.target.value ? new Date(e.target.value + 'T23:59:59') : undefined)}
            />
            {(startDate || endDate) && (
              <button
                onClick={() => { setStartDate(undefined); setEndDate(undefined); }}
                className="h-8 px-1.5 rounded-md text-xs text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                title="Limpar filtro"
              >✕</button>
            )}
          </div>
          {/* Filtro de cliente — visível apenas para Global Admin */}
          {isGlobalAdmin && (
            <Select
              value={selectedTenantId !== undefined ? String(selectedTenantId) : "all"}
              onValueChange={(v) => setSelectedTenantId(v === "all" ? undefined : Number(v))}
            >
              <SelectTrigger className="w-48 h-8 text-xs">
                <SelectValue placeholder="Todos os clientes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os clientes</SelectItem>
                {tenants.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Atualizar</span>
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── Cards KPI ── */}
        <section>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
            Resumo Operacional
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              title="Total no Complexo"
              value={wip?.total ?? 0}
              sub="pedidos rastreados"
              icon={Package}
              color="text-slate-700"
              loading={wipQuery.isLoading}
            />
            <KpiCard
              title="Concluídos"
              value={wip ? `${wip.concluidos} (${pctConcluidos}%)` : null}
              sub="recebimento completo"
              icon={CheckCircle2}
              color="text-emerald-600"
              loading={wipQuery.isLoading}
            />
            <KpiCard
              title="Tempo Médio Total"
              value={avgWaveStats?.label ?? lead?.global.avgTotalFormatted ?? "—"}
              sub="média por romaneio"
              icon={Timer}
              color="text-indigo-600"
              loading={waveDeliveryQuery.isLoading}
            />
            <KpiCard
              title="Alertas de SLA"
              value={alerts.length > 0 ? `${alerts.length} (${pctAlertas}%)` : "0"}
              sub={`SLA: ${slaMinutes}min por fase`}
              icon={AlertTriangle}
              color={alerts.length > 0 ? "text-red-600" : "text-slate-400"}
              loading={alertsQuery.isLoading}
            />
          </div>
        </section>

        {/* ── WIP por estágio + Lead Time ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* WIP por estágio */}
          <Card className="bg-white border border-slate-200 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-indigo-500" />
                Pedidos por Estágio (WIP)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {wipQuery.isLoading ? (
                <div className="space-y-2">
                  {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(wip?.porStatus ?? {}).map(([status, count]) => {
                    const pct = wip && wip.total > 0 ? Math.round((count / wip.total) * 100) : 0;
                    return (
                      <div key={status} className="flex items-center gap-3">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: STAGE_COLORS[status] ?? "#94a3b8" }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs text-slate-600 truncate">
                              {STATUS_LABELS[status] ?? status}
                            </span>
                            <span className="text-xs font-semibold text-slate-800 ml-2 flex-shrink-0">
                              {count}
                            </span>
                          </div>
                          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: STAGE_COLORS[status] ?? "#94a3b8",
                              }}
                            />
                          </div>
                        </div>
                        <span className="text-xs text-slate-400 w-8 text-right flex-shrink-0">{pct}%</span>
                      </div>
                    );
                  })}
                  <div className="pt-2 border-t border-slate-100 flex justify-between text-xs text-slate-500">
                    <span>Na Doca: <strong className="text-slate-700">{wip?.naDoca ?? 0}</strong></span>
                    <span>Em Trânsito: <strong className="text-slate-700">{wip?.emTransito ?? 0}</strong></span>
                    <span>Na Farmácia: <strong className="text-slate-700">{wip?.naFarmacia ?? 0}</strong></span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Lead Time médio */}
          <Card className="bg-white border border-slate-200 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Clock className="h-4 w-4 text-indigo-500" />
                Tempos Médios de Ciclo
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {leadTimeQuery.isLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : (
                <div className="space-y-3">
                  {[
                    { label: "Permanência na Doca", value: lead?.global.avgDocaFormatted, color: "#3b82f6", icon: Truck },
                    { label: "Trânsito Doca → Farmácia", value: lead?.global.avgTransitoFormatted, color: "#f59e0b", icon: TrendingUp },
                    { label: "Conferência na Farmácia", value: lead?.global.avgConferenciaFormatted, color: "#8b5cf6", icon: Building2 },
                    { label: "Tempo Total (Chegada → Conclusão)", value: avgWaveStats?.label ?? lead?.global.avgTotalFormatted, color: "#10b981", icon: CheckCircle2 },
                  ].map(({ label, value, color, icon: Icon }) => (
                    <div key={label} className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-50">
                      <Icon className="h-4 w-4 flex-shrink-0" style={{ color }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-500 truncate">{label}</p>
                        <p className="text-sm font-semibold text-slate-800">{value ?? "Sem dados"}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Gráfico de barras: tempo médio por farmácia ── */}
        <Card className="bg-white border border-slate-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-indigo-500" />
              Tempo Médio de Conferência por Farmácia (min)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {leadTimeQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (lead?.byPharmacy ?? []).length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
                Nenhum dado disponível
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={(lead?.byPharmacy ?? []).map(p => ({
                    name: p.pointName,
                    conferencia: p.avgConferencia ?? 0,
                    total: p.avgTotal ?? 0,
                    pedidos: p.totalPedidos,
                  }))}
                  margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} unit="min" />
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      `${v}min`,
                      name === "conferencia" ? "Conferência" : "Total",
                    ]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="conferencia" name="Conferência" radius={[4, 4, 0, 0]}>
                    {(lead?.byPharmacy ?? []).map((_, i) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* ── Gráfico de área: chegadas por hora ── */}
        <Card className="bg-white border border-slate-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Truck className="h-4 w-4 text-indigo-500" />
              Volume de Chegadas na Doca por Hora (últimos 30 dias)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {arrivalsQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart
                  data={arrivals}
                  margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                >
                  <defs>
                    <linearGradient id="colorArrivals" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="horaLabel"
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    interval={3}
                  />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                  <Tooltip
                    formatter={(v: number) => [`${v} chegadas`, "Chegadas"]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#colorArrivals)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* ── Gráfico: Tempo Total por Romaneio ── */}
        <Card className="bg-white border border-slate-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Clock className="h-4 w-4 text-violet-500" />
              Tempo Total de Entrega por Romaneio (últimos 30 dias)
            </CardTitle>
            <p className="text-xs text-slate-400 mt-0.5">Da chegada do 1º pedido na doca até a conclusão do último na farmácia</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {waveDeliveryQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : waveChartData.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
                Nenhum romaneio concluído nos últimos 30 dias.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={waveChartData}
                  margin={{ top: 4, right: 8, left: 0, bottom: 24 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="data"
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={40}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    tickFormatter={(v: number) => `${v}h`}
                    label={{ value: "Horas", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 11, fill: "#94a3b8" } }}
                  />
                  <Tooltip
                    formatter={(v: number, _: string, entry: any) => [
                      `${v}h (${entry.payload.duracaoLabel})`,
                      `Romaneio ${entry.payload.label}`
                    ]}
                    labelFormatter={(label: string) => `Data: ${label}`}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="horas" fill="#7c3aed" radius={[4, 4, 0, 0]}>
                    {waveChartData.map((_, idx) => (
                      <Cell key={idx} fill={idx % 2 === 0 ? "#7c3aed" : "#a78bfa"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* ── Alertas de SLA ── */}
        <Card className="bg-white border border-slate-200 shadow-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                Alertas de SLA
                {alerts.length > 0 && (
                  <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">
                    {alerts.length}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-1">
                {SLA_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSlaMinutes(opt.value)}
                    className={`px-2 py-1 text-xs rounded-md font-medium transition-colors ${
                      slaMinutes === opt.value
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {alertsQuery.isLoading ? (
              <div className="space-y-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : alerts.length === 0 ? (
              <div className="flex items-center gap-3 p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                <CheckCircle2 className="h-5 w-5 text-emerald-500 flex-shrink-0" />
                <p className="text-sm text-emerald-700">
                  Nenhum pedido excedeu o SLA de <strong>{slaMinutes}min</strong> por fase.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {alerts.map(alert => (
                  <AlertRow key={alert.orderId} {...alert} slaMinutes={slaMinutes} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </main>
    </div>
  );
}
