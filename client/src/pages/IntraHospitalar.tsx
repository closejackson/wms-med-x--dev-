/**
 * IntraHospitalar.tsx
 * Módulo de Rastreabilidade Intra-Hospitalar
 *
 * Telas:
 *  - Pontos de Entrega: cadastro e gestão de docas e farmácias
 *  - Monitorização: lista de pedidos com último status de rastreio
 *  - Relatório: tempo médio de trânsito interno por etapa
 */
import { useState } from "react";
import { Link } from "wouter";
import DashboardLayout from "../components/DashboardLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { trpc } from "../lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import {
  MapPin,
  Building2,
  Truck,
  Plus,
  Edit2,
  Clock,
  BarChart2,
  CheckCircle2,
  AlertTriangle,
  Package,
  QrCode,
  Activity,
  Home,
  FileSpreadsheet,
  Filter,
} from "lucide-react";
import { ImportDeliveryPointsDialog } from "../components/ImportDeliveryPointsDialog";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "points" | "monitoring" | "report";
type PointType = "DOCK" | "PHARMACY";

const STATUS_LABELS: Record<string, string> = {
  ARRIVED_COMPLEX: "Chegou à Doca",
  DEPARTED_TO_UNIT: "Saiu para a Farmácia",
  ARRIVED_UNIT: "Chegou à Farmácia",
  RECEIVING_STARTED: "Recebimento Iniciado",
  RECEIVE_COMPLETE: "Recebimento Concluído",
};

const STATUS_COLORS: Record<string, string> = {
  ARRIVED_COMPLEX: "bg-blue-100 text-blue-700",
  DEPARTED_TO_UNIT: "bg-yellow-100 text-yellow-700",
  ARRIVED_UNIT: "bg-purple-100 text-purple-700",
  RECEIVING_STARTED: "bg-orange-100 text-orange-700",
  RECEIVE_COMPLETE: "bg-green-100 text-green-700",
};

// ─── Componente ───────────────────────────────────────────────────────────────

export function IntraHospitalar() {
  const { user } = useAuth();
  const isGlobalAdmin = user?.tenantId === 1;

  const [activeTab, setActiveTab] = useState<Tab>("points");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<number | undefined>(undefined);
  const [editingPoint, setEditingPoint] = useState<{ id: number; name: string; description?: string; floor?: string; isActive: boolean } | null>(null);

  // Form state
  const [form, setForm] = useState({
    name: "",
    type: "DOCK" as PointType,
    externalCode: "",
    description: "",
    floor: "",
    tenantId: undefined as number | undefined,
  });

  // ─── Queries ────────────────────────────────────────────────────────────────

  const { data: points, refetch: refetchPoints, isLoading: loadingPoints } =
    trpc.intraHospital.listDeliveryPoints.useQuery({
      includeInactive: true,
      tenantId: isGlobalAdmin ? selectedTenantId : undefined,
    });

  const { data: tenantsList } = trpc.tenants.list.useQuery(undefined, {
    enabled: isGlobalAdmin,
  });

  const { data: monitoringData, isLoading: loadingMonitoring } =
    trpc.intraHospital.listOrdersWithStatus.useQuery({
      limit: 100,
      tenantId: isGlobalAdmin ? selectedTenantId : undefined,
    });

  const { data: reportData, isLoading: loadingReport } =
    trpc.intraHospital.getTransitReport.useQuery({
      tenantId: isGlobalAdmin ? selectedTenantId : undefined,
    });

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const createMut = trpc.intraHospital.createDeliveryPoint.useMutation({
    onSuccess: () => {
      toast.success("Ponto de entrega criado com sucesso!");
      setShowCreateForm(false);
      setForm({ name: "", type: "DOCK", externalCode: "", description: "", floor: "", tenantId: undefined });
      refetchPoints();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMut = trpc.intraHospital.updateDeliveryPoint.useMutation({
    onSuccess: () => {
      toast.success("Ponto atualizado!");
      setEditingPoint(null);
      refetchPoints();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleCreate = () => {
    if (!form.name.trim() || !form.externalCode.trim()) {
      toast.error("Nome e código são obrigatórios.");
      return;
    }
    if (isGlobalAdmin && !form.tenantId) {
      toast.error("Selecione o cliente para este ponto de entrega.");
      return;
    }
    createMut.mutate({
      name: form.name.trim(),
      type: form.type,
      externalCode: form.externalCode.trim().toUpperCase(),
      description: form.description.trim() || undefined,
      floor: form.floor.trim() || undefined,
      tenantId: form.tenantId,
    });
  };

  const handleToggleActive = (id: number, isActive: boolean) => {
    updateMut.mutate({ id, isActive: !isActive });
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Activity className="h-6 w-6 text-blue-600" />
              Rastreabilidade Intra-Hospitalar
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Monitorize a jornada dos pedidos dentro do complexo hospitalar.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Filtro de cliente — visível apenas para Global Admin */}
            {isGlobalAdmin && (
              <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm">
                <Filter className="h-4 w-4 text-slate-400" />
                <select
                  value={selectedTenantId ?? ""}
                  onChange={e => setSelectedTenantId(e.target.value ? Number(e.target.value) : undefined)}
                  className="text-sm text-slate-700 bg-transparent outline-none cursor-pointer min-w-[160px]"
                >
                  <option value="">Todos os clientes</option>
                  {tenantsList?.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            <Link href="/home">
              <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white gap-2">
                <Home className="h-4 w-4" /> Home
              </Button>
            </Link>
            <Link href="/intra-hospitalar/rastreabilidade">
              <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white gap-2">
                <Activity className="h-4 w-4" /> Rastreabilidade
              </Button>
            </Link>
            <Link href="/intra-hospitalar/dashboard">
              <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white gap-2 text-indigo-600 border-indigo-200 hover:bg-indigo-50">
                <BarChart2 className="h-4 w-4" /> Performance
              </Button>
            </Link>
            {activeTab === "points" && (
              <>
                <Button variant="outline" onClick={() => setShowImportDialog(true)} className="gap-2 bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white">
                  <FileSpreadsheet className="h-4 w-4" /> Importar Excel
                </Button>
                <Button onClick={() => setShowCreateForm(true)} className="gap-2">
                  <Plus className="h-4 w-4" /> Novo Ponto
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-100 p-1 rounded-lg w-fit">
          {([
            { id: "points", label: "Pontos de Entrega", icon: MapPin },
            { id: "monitoring", label: "Monitorização", icon: Activity },
            { id: "report", label: "Relatório de SLA", icon: BarChart2 },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── ABA: PONTOS DE ENTREGA ── */}
        {activeTab === "points" && (
          <div className="space-y-4">
            {/* Formulário de criação */}
            {showCreateForm && (
              <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <Plus className="h-4 w-4 text-blue-500" /> Novo Ponto de Entrega
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Campo Cliente — visível apenas para Global Admin */}
                  {isGlobalAdmin && (
                    <div className="md:col-span-2">
                      <label className="text-xs font-medium text-slate-500 mb-1 block">
                        Cliente <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={form.tenantId ?? ""}
                        onChange={e => setForm(f => ({ ...f, tenantId: e.target.value ? Number(e.target.value) : undefined }))}
                        className="w-full h-9 rounded-md border border-slate-200 px-3 text-sm bg-white"
                      >
                        <option value="">Selecione o cliente...</option>
                        {tenantsList?.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="text-xs font-medium text-slate-500 mb-1 block">Nome *</label>
                    <Input
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Ex: Doca A, Farmácia Central"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-500 mb-1 block">Tipo *</label>
                    <select
                      value={form.type}
                      onChange={e => setForm(f => ({ ...f, type: e.target.value as PointType }))}
                      className="w-full h-9 rounded-md border border-slate-200 px-3 text-sm bg-white"
                    >
                      <option value="DOCK">Doca de Descarregamento</option>
                      <option value="PHARMACY">Farmácia</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-500 mb-1 block">Código (QR Code) *</label>
                    <Input
                      value={form.externalCode}
                      onChange={e => setForm(f => ({ ...f, externalCode: e.target.value.toUpperCase() }))}
                      placeholder="Ex: DOCA-A, FARM-01"
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-500 mb-1 block">Andar / Localização</label>
                    <Input
                      value={form.floor}
                      onChange={e => setForm(f => ({ ...f, floor: e.target.value }))}
                      placeholder="Ex: Térreo, 2º Andar"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-xs font-medium text-slate-500 mb-1 block">Descrição</label>
                    <Input
                      value={form.description}
                      onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Descrição opcional"
                    />
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setShowCreateForm(false)}>Cancelar</Button>
                  <Button onClick={handleCreate} disabled={createMut.isPending}>
                    {createMut.isPending ? "Criando..." : "Criar Ponto"}
                  </Button>
                </div>
              </div>
            )}

            {/* Lista de pontos */}
            {loadingPoints ? (
              <div className="text-center text-slate-500 py-12">Carregando pontos...</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Docas */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Truck className="h-4 w-4" /> Docas de Descarregamento
                  </h3>
                  {points?.filter(p => p.type === "DOCK").length === 0 && (
                    <div className="text-center text-slate-400 py-8 border border-dashed rounded-lg text-sm">
                      Nenhuma doca cadastrada
                    </div>
                  )}
                  {points?.filter(p => p.type === "DOCK").map(point => (
                    <div key={point.id} className={`bg-white rounded-lg border p-4 mb-3 ${!point.isActive ? "opacity-50" : "border-slate-200"}`}>
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-semibold text-slate-800">{point.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                            <QrCode className="h-3 w-3" /> {point.externalCode}
                            {point.floor && ` · ${point.floor}`}
                          </p>
                          {point.description && <p className="text-xs text-slate-400 mt-1">{point.description}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className={point.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}>
                            {point.isActive ? "Ativo" : "Inativo"}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggleActive(point.id, point.isActive)}
                          >
                            {point.isActive ? "Desativar" : "Ativar"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Farmácias */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Building2 className="h-4 w-4" /> Farmácias
                  </h3>
                  {points?.filter(p => p.type === "PHARMACY").length === 0 && (
                    <div className="text-center text-slate-400 py-8 border border-dashed rounded-lg text-sm">
                      Nenhuma farmácia cadastrada
                    </div>
                  )}
                  {points?.filter(p => p.type === "PHARMACY").map(point => (
                    <div key={point.id} className={`bg-white rounded-lg border p-4 mb-3 ${!point.isActive ? "opacity-50" : "border-slate-200"}`}>
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-semibold text-slate-800">{point.name}</p>
                          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                            <QrCode className="h-3 w-3" /> {point.externalCode}
                            {point.floor && ` · ${point.floor}`}
                          </p>
                          {point.description && <p className="text-xs text-slate-400 mt-1">{point.description}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className={point.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}>
                            {point.isActive ? "Ativo" : "Inativo"}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggleActive(point.id, point.isActive)}
                          >
                            {point.isActive ? "Desativar" : "Ativar"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── ABA: MONITORIZAÇÃO ── */}
        {activeTab === "monitoring" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-100">
                <h3 className="font-semibold text-slate-800">Pedidos em Trânsito</h3>
                <p className="text-xs text-slate-500 mt-0.5">Último status de rastreio por pedido</p>
              </div>
              {loadingMonitoring ? (
                <div className="text-center text-slate-500 py-12">Carregando...</div>
              ) : monitoringData?.length === 0 ? (
                <div className="text-center text-slate-400 py-12">
                  <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>Nenhum pedido com rastreio intra-hospitalar.</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {monitoringData?.map(item => (
                    <div key={item.orderId} className="p-4 flex items-center justify-between hover:bg-slate-50">
                      <div>
                        <p className="font-mono text-sm font-semibold text-slate-800">
                          #{item.customerOrderNumber ?? item.orderId}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {item.lastPointName ?? "—"}
                          {item.lastPointType === "DOCK" && " (Doca)"}
                          {item.lastPointType === "PHARMACY" && " (Farmácia)"}
                        </p>
                      </div>
                      <div className="text-right">
                        <Badge className={STATUS_COLORS[item.lastDeliveryStatus] ?? "bg-slate-100 text-slate-600"}>
                          {item.lastDeliveryStatusLabel}
                        </Badge>
                        <p className="text-xs text-slate-400 mt-1">
                          {item.lastTimestamp
                            ? new Date(item.lastTimestamp).toLocaleString("pt-BR")
                            : "—"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ABA: RELATÓRIO DE SLA ── */}
        {activeTab === "report" && (
          <div className="space-y-4">
            {/* Cards de resumo */}
            {!loadingReport && reportData && (
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-slate-800">{reportData.totalOrders}</p>
                  <p className="text-xs text-slate-500 mt-1">Total de Pedidos</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-green-600">{reportData.completedOrders}</p>
                  <p className="text-xs text-slate-500 mt-1">Concluídos</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
                  <p className="text-2xl font-bold text-blue-600">{reportData.completionRate}%</p>
                  <p className="text-xs text-slate-500 mt-1">Taxa de Conclusão</p>
                </div>
              </div>
            )}

            {/* Tabela de lead-times por transição */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-100">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-blue-500" />
                  Tempo Médio por Etapa
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">Lead-time médio entre cada checkpoint</p>
              </div>
              {loadingReport ? (
                <div className="text-center text-slate-500 py-12">Calculando...</div>
              ) : reportData?.avgByTransition.length === 0 ? (
                <div className="text-center text-slate-400 py-12">
                  <BarChart2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>Dados insuficientes para o relatório.</p>
                  <p className="text-xs mt-1">Registre checkpoints no coletor para gerar o relatório.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="text-left p-3 text-xs font-semibold text-slate-500">De</th>
                      <th className="text-left p-3 text-xs font-semibold text-slate-500">Para</th>
                      <th className="text-right p-3 text-xs font-semibold text-slate-500">Média</th>
                      <th className="text-right p-3 text-xs font-semibold text-slate-500">Mín / Máx</th>
                      <th className="text-right p-3 text-xs font-semibold text-slate-500">Amostras</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportData?.avgByTransition.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="p-3 text-slate-700">{row.fromLabel}</td>
                        <td className="p-3 text-slate-700">{row.toLabel}</td>
                        <td className="p-3 text-right font-semibold text-blue-600">{row.avgFormatted}</td>
                        <td className="p-3 text-right text-slate-500 text-xs">
                          {row.minMinutes}min / {row.maxMinutes}min
                        </td>
                        <td className="p-3 text-right text-slate-500">{row.sampleCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
      <ImportDeliveryPointsDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        tenants={tenantsList ?? []}
        defaultTenantId={!isGlobalAdmin ? (user?.tenantId ?? undefined) : undefined}
        isGlobalAdmin={isGlobalAdmin}
        onSuccess={() => refetchPoints()}
      />
    </DashboardLayout>
  );
}
