/**
 * ClientPortalIntraHospitalar.tsx
 *
 * Dashboard de Performance Intra-Hospitalar para o Portal do Cliente.
 * - Valida se o tenant tem intraHospitalEnabled antes de exibir dados
 * - Redireciona para /portal com mensagem de erro se não tiver permissão
 * - Exibe KPIs, WIP, gráficos e alertas de SLA
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useClientPortalAuth } from "@/hooks/useClientPortalAuth";
import { PortalDateRangeFilter, type DateRange } from "@/components/PortalDateRangeFilter";
import { ClientPortalLayout } from "@/components/ClientPortalLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  Cell,
} from "recharts";
import {
  Package,
  CheckCircle2,
  Clock,
  AlertTriangle,
  TrendingUp,
  Activity,
  ShieldX,
} from "lucide-react";
import { toast } from "sonner";
import { PortalExportButton } from "@/components/PortalExportButton";

// ── Constantes ────────────────────────────────────────────────────────────────
const SLA_MINUTES = 120;

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  color = "blue",
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color?: "blue" | "green" | "amber" | "red";
}) {
  const colors = {
    blue:  { bg: "bg-blue-50",  text: "text-blue-600",  icon: "text-blue-500"  },
    green: { bg: "bg-green-50", text: "text-green-600", icon: "text-green-500" },
    amber: { bg: "bg-amber-50", text: "text-amber-600", icon: "text-amber-500" },
    red:   { bg: "bg-red-50",   text: "text-red-600",   icon: "text-red-500"   },
  };
  const c = colors[color];
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</p>
            <p className={`text-2xl font-bold mt-1 ${c.text}`}>{value}</p>
            {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg ${c.bg}`}>
            <Icon className={`h-5 w-5 ${c.icon}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Componente Principal ──────────────────────────────────────────────────────
export function ClientPortalIntraHospitalar() {
  const [, setLocation] = useLocation();
  const { user, loading: authLoading } = useClientPortalAuth({ redirectIfUnauthenticated: true });
  const [dateRange, setDateRange] = useState<DateRange>({ from: undefined, to: undefined });

  // Redirecionar se o tenant não tem intraHospitalEnabled
  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    if (!user.intraHospitalEnabled) {
      toast.error("Módulo Intra-Hospitalar não habilitado para este cliente.");
      setLocation("/portal");
    }
  }, [authLoading, user, setLocation]);

  const leadTimeQuery = trpc.clientPortal.intraLeadTimeStats.useQuery({
    startDate: dateRange.from,
    endDate: dateRange.to,
  }, {
    enabled: !!user?.intraHospitalEnabled,
    retry: false,
  });

  const wipQuery = trpc.clientPortal.intraWipStatus.useQuery(undefined, {
    enabled: !!user?.intraHospitalEnabled,
    retry: false,
  });

  const alertsQuery = trpc.clientPortal.intraAlerts.useQuery(
    { slaMinutes: SLA_MINUTES },
    { enabled: !!user?.intraHospitalEnabled, retry: false }
  );

  const arrivalsQuery = trpc.clientPortal.intraArrivalsByHour.useQuery(
    { days: dateRange.from ? undefined : 30, tzOffsetMinutes: -new Date().getTimezoneOffset() },
    { enabled: !!user?.intraHospitalEnabled, retry: false }
  );

  const isLoading = authLoading || leadTimeQuery.isLoading || wipQuery.isLoading;
  const exportIntraMutation = trpc.portalExport.exportIntraHosp.useMutation();

  // Loading state
  if (authLoading) {
    return (
      <ClientPortalLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        </div>
      </ClientPortalLayout>
    );
  }

  // Sem permissão
  if (!user?.intraHospitalEnabled) {
    return (
      <ClientPortalLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <ShieldX className="h-16 w-16 text-slate-300" />
          <p className="text-slate-500 text-center">
            Módulo Intra-Hospitalar não habilitado para este cliente.
          </p>
        </div>
      </ClientPortalLayout>
    );
  }

  const lead = leadTimeQuery.data;
  const wip = wipQuery.data;
  const alerts = alertsQuery.data ?? [];
  const arrivals = arrivalsQuery.data ?? [];

  // Dados para o gráfico de barras por farmácia
  type PharmacyRow = NonNullable<typeof lead>["byPharmacy"][number];
  const pharmacyChartData = (lead?.byPharmacy ?? []).map((p: PharmacyRow) => ({
    name: p.pointName.length > 16 ? p.pointName.slice(0, 14) + "…" : p.pointName,
    tempo: p.avgTotal ?? 0,
    exceedsSla: (p.avgTotal ?? 0) > SLA_MINUTES,
  }));

  return (
    <ClientPortalLayout>
      <div className="space-y-6">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
              <Activity className="h-5 w-5 text-blue-600" />
              Performance Intra-Hospitalar
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              KPIs e tempos de ciclo — {user?.tenantName}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <PortalDateRangeFilter
              value={dateRange}
              onChange={setDateRange}
            />
            {alerts.length > 0 && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {alerts.length} alerta{alerts.length !== 1 ? "s" : ""}
              </Badge>
            )}
            <PortalExportButton
              onExport={(format) =>
                exportIntraMutation.mutateAsync({ format })
              }
            />
          </div>
        </div>

        {/* KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Total de Pedidos"
              value={wip?.total ?? 0}
              sub="Todos os estágios"
              icon={Package}
              color="blue"
            />
            <KpiCard
              title="Concluídos"
              value={wip?.concluidos ?? 0}
              sub={`${wip?.total ? Math.round((wip.concluidos / wip.total) * 100) : 0}% do total`}
              icon={CheckCircle2}
              color="green"
            />
            <KpiCard
              title="Tempo Médio Total"
              value={lead?.global.avgTotalFormatted ?? "—"}
              sub="Doca → Conferência"
              icon={Clock}
              color="amber"
            />
            <KpiCard
              title="Alertas de SLA"
              value={alerts.length}
              sub={`Acima de ${SLA_MINUTES}min`}
              icon={AlertTriangle}
              color={alerts.length > 0 ? "red" : "green"}
            />
          </div>
        )}

        {/* Tempos médios de ciclo */}
        {!isLoading && lead && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: "Tempo na Doca",         value: lead.global.avgDocaFormatted },
              { label: "Tempo em Trânsito",      value: lead.global.avgTransitoFormatted },
              { label: "Tempo de Conferência",   value: lead.global.avgConferenciaFormatted },
            ].map((item) => (
              <Card key={item.label}>
                <CardContent className="p-4 flex items-center gap-3">
                  <TrendingUp className="h-4 w-4 text-blue-500 shrink-0" />
                  <div>
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="text-lg font-semibold text-slate-800">{item.value ?? "—"}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Gráfico de barras por farmácia */}
        {!isLoading && pharmacyChartData.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-slate-700">
                Tempo Médio por Farmácia
              </CardTitle>
              <p className="text-xs text-slate-400">
                Barras em vermelho indicam farmácias acima do SLA ({SLA_MINUTES}min)
              </p>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={pharmacyChartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit="min" />
                  <Tooltip
                    formatter={(value: number) => [`${value}min`, "Tempo Médio"]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="tempo" radius={[4, 4, 0, 0]} name="Tempo Médio (min)">
                    {pharmacyChartData.map((entry: { name: string; tempo: number; exceedsSla: boolean }, index: number) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.exceedsSla ? "#ef4444" : "#3b82f6"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Gráfico de chegadas por hora */}
        {!isLoading && arrivals.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-slate-700">
                Chegadas na Doca por Hora (últimos 30 dias)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={arrivals} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <defs>
                    <linearGradient id="colorArrivals" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="horaLabel" tick={{ fontSize: 10 }} interval={3} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke="#3b82f6"
                    fill="url(#colorArrivals)"
                    strokeWidth={2}
                    name="Chegadas"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Alertas de SLA */}
        {!isLoading && alerts.length > 0 && (
          <Card className="border-red-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-red-700 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Pedidos com SLA Excedido
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {alerts.slice(0, 10).map((alert: typeof alerts[number]) => (
                  <div
                    key={alert.orderId}
                    className="flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-100"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {alert.customerOrderNumber}
                      </p>
                      <p className="text-xs text-slate-500">
                        {alert.pointName ?? "Sem destino"} · {alert.currentStatus}
                      </p>
                    </div>
                    <div className="text-right">
                      <Badge variant="destructive" className="text-xs">
                        +{alert.slaExceededBy}min acima do SLA
                      </Badge>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Total: {alert.maxFaseFormatted ?? "—"}
                      </p>
                    </div>
                  </div>
                ))}
                {alerts.length > 10 && (
                  <p className="text-xs text-slate-400 text-center pt-1">
                    +{alerts.length - 10} pedidos adicionais com SLA excedido
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Estado vazio */}
        {!isLoading && !lead?.global.totalPedidos && (
          <Alert>
            <Activity className="h-4 w-4" />
            <AlertDescription>
              Nenhum dado de rastreabilidade intra-hospitalar encontrado para este cliente.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </ClientPortalLayout>
  );
}
