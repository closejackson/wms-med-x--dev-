/**
 * InventoryModule.tsx
 * Módulo de Inventário — Fase 1
 * Telas: Dashboard, Inventários, Detalhes, OMs de Sobra, Ondas de Movimentação
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  ClipboardList,
  Home,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  BarChart3,
  Package,
  Waves,
  Eye,
  Ban,
  Play,
  Check,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    pending:     { label: "Pendente",    variant: "secondary" },
    in_progress: { label: "Em Andamento", variant: "default" },
    completed:   { label: "Concluído",   variant: "outline" },
    cancelled:   { label: "Cancelado",   variant: "destructive" },
  };
  const s = map[status] ?? { label: status, variant: "secondary" };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function omStatusBadge(status: string) {
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    pending:     { label: "Pendente",    variant: "secondary" },
    in_wave:     { label: "Em Onda",     variant: "default" },
    in_progress: { label: "Em Andamento", variant: "default" },
    picked:      { label: "Separado",    variant: "outline" },
    cancelled:   { label: "Cancelado",   variant: "destructive" },
  };
  const s = map[status] ?? { label: status, variant: "secondary" };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

function fmtDate(d: any) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR");
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function InventoryModule() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedInventoryId, setSelectedInventoryId] = useState<number | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [waveDialogOpen, setWaveDialogOpen] = useState(false);
  const [selectedOmIds, setSelectedOmIds] = useState<number[]>([]);

  const isGlobalAdmin = user?.tenantId === 1;
  const canManage = ["admin", "manager", "supervisor"].includes(user?.role ?? "");
  const canCancel = ["admin", "supervisor"].includes(user?.role ?? "");
  // Tenants (só Global Admin precisa selecionar)
  const { data: tenantsList } = trpc.tenants.list.useQuery(undefined, { enabled: isGlobalAdmin });

  // ── Queries ────────────────────────────────────────────────────────────────
  const dashboardQ = trpc.inventoryMgmt.dashboard.useQuery(undefined, { refetchInterval: 30000 });
  const listQ = trpc.inventoryMgmt.list.useQuery({ page: 1, pageSize: 50 });
  const detailQ = trpc.inventoryMgmt.getById.useQuery(
    { id: selectedInventoryId! },
    { enabled: !!selectedInventoryId }
  );
  const omListQ = trpc.inventoryMgmt.listMovementOrders.useQuery({ page: 1, pageSize: 50 });
  const wavesQ = trpc.inventoryMgmt.listMovementWaves.useQuery({ page: 1, pageSize: 50 });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const utils = trpc.useUtils();

  const createMut = trpc.inventoryMgmt.create.useMutation({
    onSuccess: (data) => {
      toast.success(`Inventário ${data.inventoryNumber} criado com ${data.totalLocations} endereços`);
      setCreateDialogOpen(false);
      utils.inventoryMgmt.list.invalidate();
      utils.inventoryMgmt.dashboard.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const startMut = trpc.inventoryMgmt.start.useMutation({
    onSuccess: () => {
      toast.success("Inventário iniciado");
      utils.inventoryMgmt.list.invalidate();
      utils.inventoryMgmt.getById.invalidate({ id: selectedInventoryId! });
    },
    onError: (e) => toast.error(e.message),
  });

  const completeMut = trpc.inventoryMgmt.complete.useMutation({
    onSuccess: (data) => {
      toast.success(`Inventário concluído. Acuracidade: ${data.accuracy}%`);
      utils.inventoryMgmt.list.invalidate();
      utils.inventoryMgmt.dashboard.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const cancelMut = trpc.inventoryMgmt.cancel.useMutation({
    onSuccess: () => {
      toast.success("Inventário cancelado");
      setCancelDialogOpen(false);
      setCancelReason("");
      utils.inventoryMgmt.list.invalidate();
      utils.inventoryMgmt.dashboard.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const createWaveMut = trpc.inventoryMgmt.createMovementWave.useMutation({
    onSuccess: (data) => {
      toast.success(`Onda ${data.waveNumber} criada`);
      setWaveDialogOpen(false);
      setSelectedOmIds([]);
      utils.inventoryMgmt.listMovementOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Create Form State ──────────────────────────────────────────────────────
  const [createForm, setCreateForm] = useState({
    inventoryType: "cyclic" as "cyclic" | "general",
    referenceDate: (() => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
      const y = parts.find(p => p.type === "year")!.value;
      const m = parts.find(p => p.type === "month")!.value;
      const d = parts.find(p => p.type === "day")!.value;
      return `${y}-${m}-${d}`;
    })(),
    startDate: (() => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
      const y = parts.find(p => p.type === "year")!.value;
      const mo = parts.find(p => p.type === "month")!.value;
      const d = parts.find(p => p.type === "day")!.value;
      const h = parts.find(p => p.type === "hour")!.value;
      const min = parts.find(p => p.type === "minute")!.value;
      return `${y}-${mo}-${d}T${h}:${min}`;
    })(),
    notes: "",
    tenantId: undefined as number | undefined,
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen">
      <PageHeader
        icon={<ClipboardList className="h-8 w-8" />}
        title="Módulo de Inventário"
        description="Gestão de inventários cíclicos e gerais"
        actions={
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setLocation("/home")}>
            <Home className="h-4 w-4 mr-2" />
            Início
          </Button>
        }
      />

      <main className="container mx-auto px-6 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 bg-white/10">
            <TabsTrigger value="dashboard" className="text-white data-[state=active]:bg-white data-[state=active]:text-black"><BarChart3 className="h-4 w-4 mr-1" />Dashboard</TabsTrigger>
            <TabsTrigger value="inventarios" className="text-white data-[state=active]:bg-white data-[state=active]:text-black"><ClipboardList className="h-4 w-4 mr-1" />Inventários</TabsTrigger>
            <TabsTrigger value="oms" className="text-white data-[state=active]:bg-white data-[state=active]:text-black"><Package className="h-4 w-4 mr-1" />OMs de Sobra</TabsTrigger>
            <TabsTrigger value="ondas" className="text-white data-[state=active]:bg-white data-[state=active]:text-black"><Waves className="h-4 w-4 mr-1" />Ondas</TabsTrigger>
          </TabsList>

          {/* ── DASHBOARD ── */}
          <TabsContent value="dashboard">
            {dashboardQ.isLoading ? (
              <div className="text-center py-16 text-muted-foreground">Carregando...</div>
            ) : (
              <div className="space-y-6">
                {/* KPIs */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: "Total", value: dashboardQ.data?.inventoryStats?.total ?? 0, icon: <ClipboardList className="h-5 w-5" />, color: "text-blue-400" },
                    { label: "Em Andamento", value: dashboardQ.data?.inventoryStats?.inProgress ?? 0, icon: <Clock className="h-5 w-5" />, color: "text-yellow-400" },
                    { label: "Concluídos", value: dashboardQ.data?.inventoryStats?.completed ?? 0, icon: <CheckCircle2 className="h-5 w-5" />, color: "text-green-400" },
                    { label: "OMs Pendentes", value: dashboardQ.data?.pendingMovementOrders ?? 0, icon: <AlertTriangle className="h-5 w-5" />, color: "text-orange-400" },
                  ].map((kpi) => (
                    <Card key={kpi.label}>
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm text-muted-foreground">{kpi.label}</p>
                            <p className="text-3xl font-bold">{kpi.value}</p>
                          </div>
                          <div className={kpi.color}>{kpi.icon}</div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Últimos concluídos */}
                <Card>
                  <CardHeader><CardTitle className="text-base">Últimos Inventários Concluídos</CardTitle></CardHeader>
                  <CardContent>
                    {(dashboardQ.data?.recentCompleted ?? []).length === 0 ? (
                      <p className="text-muted-foreground text-sm">Nenhum inventário concluído ainda.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Número</TableHead>
                            <TableHead>Tipo</TableHead>
                            <TableHead>Endereços</TableHead>
                            <TableHead>Divergentes</TableHead>
                            <TableHead>Acuracidade</TableHead>
                            <TableHead>Conclusão</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dashboardQ.data?.recentCompleted.map((inv: any) => (
                            <TableRow key={inv.inventoryNumber}>
                              <TableCell className="font-mono">{inv.inventoryNumber}</TableCell>
                              <TableCell>{inv.inventoryType === "cyclic" ? "Cíclico" : "Geral"}</TableCell>
                              <TableCell>{inv.totalLocations}</TableCell>
                              <TableCell className={inv.divergentLocations > 0 ? "text-orange-400" : ""}>{inv.divergentLocations}</TableCell>
                              <TableCell>
                                <span className={parseFloat(inv.accuracy ?? "0") >= 98 ? "text-green-400 font-semibold" : "text-orange-400 font-semibold"}>
                                  {inv.accuracy ?? "—"}%
                                </span>
                              </TableCell>
                              <TableCell>{fmtDate(inv.endDate)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* ── INVENTÁRIOS ── */}
          <TabsContent value="inventarios">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-white">Lista de Inventários</h2>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => utils.inventoryMgmt.list.invalidate()}>
                  <RefreshCw className="h-4 w-4 mr-1" />Atualizar
                </Button>
                {canManage && (
                  <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm"><Plus className="h-4 w-4 mr-1" />Novo Inventário</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-md">
                      <DialogHeader><DialogTitle>Criar Novo Inventário</DialogTitle></DialogHeader>
                      <div className="space-y-4 py-2">
                        {isGlobalAdmin && (
                          <div>
                            <Label>Cliente <span className="text-destructive">*</span></Label>
                            <Select
                              value={createForm.tenantId ? String(createForm.tenantId) : ""}
                              onValueChange={(v) => setCreateForm(f => ({ ...f, tenantId: Number(v) }))}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Selecione o cliente" />
                              </SelectTrigger>
                              <SelectContent>
                                {(tenantsList ?? []).filter((t: any) => t.id !== 1).map((t: any) => (
                                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div>
                          <Label>Tipo de Inventário</Label>
                          <Select
                            value={createForm.inventoryType}
                            onValueChange={(v) => setCreateForm(f => ({ ...f, inventoryType: v as any }))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cyclic">Cíclico (por data de movimentação)</SelectItem>
                              <SelectItem value="general">Geral (todos os endereços)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {createForm.inventoryType === "cyclic" && (
                          <div>
                            <Label>Data de Referência</Label>
                            <Input
                              type="date"
                              value={createForm.referenceDate}
                              onChange={(e) => setCreateForm(f => ({ ...f, referenceDate: e.target.value }))}
                            />
                          </div>
                        )}
                        <div>
                          <Label>Data/Hora de Início</Label>
                          <Input
                            type="datetime-local"
                            value={createForm.startDate.slice(0, 16)}
                            onChange={(e) => setCreateForm(f => ({ ...f, startDate: e.target.value }))}
                          />
                        </div>
                        <div>
                          <Label>Observações</Label>
                          <Textarea
                            value={createForm.notes}
                            onChange={(e) => setCreateForm(f => ({ ...f, notes: e.target.value }))}
                            placeholder="Opcional"
                            rows={2}
                          />
                        </div>
                        {isGlobalAdmin && !createForm.tenantId && (
                          <p className="text-sm text-destructive">Selecione um cliente antes de continuar.</p>
                        )}
                        <Button
                          className="w-full"
                          onClick={() => createMut.mutate(createForm)}
                          disabled={createMut.isPending || (isGlobalAdmin && !createForm.tenantId)}
                        >
                          {createMut.isPending ? "Criando..." : "Criar Inventário"}
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            </div>

            {listQ.isLoading ? (
              <div className="text-center py-16 text-muted-foreground">Carregando...</div>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Número</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Endereços</TableHead>
                      <TableHead>Contados</TableHead>
                      <TableHead>Divergentes</TableHead>
                      <TableHead>Acuracidade</TableHead>
                      <TableHead>Início</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(listQ.data?.rows ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          Nenhum inventário encontrado
                        </TableCell>
                      </TableRow>
                    ) : (
                      listQ.data?.rows.map((inv: any) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono">{inv.inventoryNumber}</TableCell>
                          <TableCell>{inv.inventoryType === "cyclic" ? "Cíclico" : "Geral"}</TableCell>
                          <TableCell>{statusBadge(inv.status)}</TableCell>
                          <TableCell>{inv.totalLocations}</TableCell>
                          <TableCell>{inv.countedLocations}</TableCell>
                          <TableCell className={inv.divergentLocations > 0 ? "text-orange-400" : ""}>{inv.divergentLocations}</TableCell>
                          <TableCell>{inv.accuracy ? `${inv.accuracy}%` : "—"}</TableCell>
                          <TableCell>{fmtDate(inv.startDate)}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Ver detalhes"
                                onClick={() => {
                                  setSelectedInventoryId(inv.id);
                                  setActiveTab("detalhe");
                                }}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              {canManage && inv.status === "pending" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  title="Iniciar"
                                  onClick={() => startMut.mutate({ id: inv.id })}
                                >
                                  <Play className="h-4 w-4 text-green-400" />
                                </Button>
                              )}
                              {canManage && inv.status === "in_progress" && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  title="Concluir"
                                  onClick={() => completeMut.mutate({ id: inv.id })}
                                >
                                  <Check className="h-4 w-4 text-blue-400" />
                                </Button>
                              )}
                              {canCancel && ["pending", "in_progress"].includes(inv.status) && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  title="Cancelar"
                                  onClick={() => {
                                    setCancelTargetId(inv.id);
                                    setCancelDialogOpen(true);
                                  }}
                                >
                                  <Ban className="h-4 w-4 text-red-400" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>

          {/* ── DETALHE ── */}
          <TabsContent value="detalhe">
            {!selectedInventoryId ? (
              <div className="text-center py-16 text-muted-foreground">Selecione um inventário na aba "Inventários"</div>
            ) : detailQ.isLoading ? (
              <div className="text-center py-16 text-muted-foreground">Carregando...</div>
            ) : detailQ.data ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setActiveTab("inventarios")}>← Voltar</Button>
                  <h2 className="text-lg font-semibold font-mono text-white">{detailQ.data.inventoryNumber}</h2>
                  {statusBadge(detailQ.data.status)}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: "Total de Endereços", value: detailQ.data.totalLocations },
                    { label: "Contados", value: detailQ.data.countedLocations },
                    { label: "Divergentes", value: detailQ.data.divergentLocations },
                    { label: "Acuracidade", value: detailQ.data.accuracy ? `${detailQ.data.accuracy}%` : "—" },
                  ].map((kpi) => (
                    <Card key={kpi.label}>
                      <CardContent className="pt-4 pb-4">
                        <p className="text-sm text-muted-foreground">{kpi.label}</p>
                        <p className="text-2xl font-bold">{kpi.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <Tabs defaultValue="locations">
                  <TabsList className="bg-white/10">
                    <TabsTrigger className="text-white data-[state=active]:bg-white data-[state=active]:text-black" value="locations">Endereços ({detailQ.data.locations?.length ?? 0})</TabsTrigger>
                    <TabsTrigger className="text-white data-[state=active]:bg-white data-[state=active]:text-black" value="divergences">Divergências ({detailQ.data.divergences?.length ?? 0})</TabsTrigger>
                  </TabsList>
                  <TabsContent value="locations">
                    <Card>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Endereço</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Tentativas</TableHead>
                            <TableHead>Bloqueado</TableHead>
                            <TableHead>Contado em</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(detailQ.data.locations ?? []).map((loc: any) => (
                            <TableRow key={loc.id}>
                              <TableCell className="font-mono">{loc.locationCode}</TableCell>
                              <TableCell>{statusBadge(loc.status)}</TableCell>
                              <TableCell>{loc.countAttempts}</TableCell>
                              <TableCell>{loc.isBlocked ? <Badge variant="destructive">Bloqueado</Badge> : "—"}</TableCell>
                              <TableCell>{fmtDate(loc.countedAt)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  </TabsContent>
                  <TabsContent value="divergences">
                    <Card>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Endereço</TableHead>
                            <TableHead>Produto</TableHead>
                            <TableHead>Lote</TableHead>
                            <TableHead>Esperado</TableHead>
                            <TableHead>Contado</TableHead>
                            <TableHead>Variação</TableHead>
                            <TableHead>Tipo</TableHead>
                            <TableHead>Resolução</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(detailQ.data.divergences ?? []).length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={8} className="text-center text-muted-foreground py-4">
                                Nenhuma divergência registrada
                              </TableCell>
                            </TableRow>
                          ) : (
                            detailQ.data.divergences.map((div: any) => (
                              <TableRow key={div.id}>
                                <TableCell className="font-mono">{div.locationCode}</TableCell>
                                <TableCell>{div.productDescription ?? div.productSku ?? div.productId}</TableCell>
                                <TableCell>{div.batch ?? "—"}</TableCell>
                                <TableCell>{div.expectedQuantity}</TableCell>
                                <TableCell>{div.countedQuantity}</TableCell>
                                <TableCell className={div.variance > 0 ? "text-orange-400" : "text-red-400"}>
                                  {div.variance > 0 ? `+${div.variance}` : div.variance}
                                </TableCell>
                                <TableCell>
                                  <Badge variant={div.divergenceType === "surplus" ? "default" : "destructive"}>
                                    {div.divergenceType === "surplus" ? "Sobra" : "Falta"}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  {div.resolution === "pending" && <Badge variant="secondary">Pendente</Badge>}
                                  {div.resolution === "movement_order_created" && <Badge variant="default">OM Criada</Badge>}
                                  {div.resolution === "adjusted" && <Badge variant="outline">Ajustado</Badge>}
                                  {div.resolution === "cancelled" && <Badge variant="destructive">Cancelado</Badge>}
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </Card>
                  </TabsContent>
                </Tabs>
              </div>
            ) : null}
          </TabsContent>

          {/* ── OMs DE SOBRA ── */}
          <TabsContent value="oms">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-white">Ordens de Movimentação de Sobra</h2>
              <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => utils.inventoryMgmt.listMovementOrders.invalidate()}>
                <RefreshCw className="h-4 w-4 mr-1" />Atualizar
              </Button>
            </div>

            {omListQ.isLoading ? (
              <div className="text-center py-16 text-muted-foreground">Carregando...</div>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          onChange={(e) => {
                            const pendingIds = (omListQ.data?.rows ?? [])
                              .filter((o: any) => o.status === "pending")
                              .map((o: any) => o.id);
                            setSelectedOmIds(e.target.checked ? pendingIds : []);
                          }}
                        />
                      </TableHead>
                      <TableHead>Número</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Inventário</TableHead>
                      <TableHead>Qtd. Itens</TableHead>
                      <TableHead>Onda</TableHead>
                      <TableHead>Criado em</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(omListQ.data?.rows ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                          Nenhuma OM de sobra encontrada
                        </TableCell>
                      </TableRow>
                    ) : (
                      omListQ.data?.rows.map((om: any) => (
                        <TableRow key={om.id}>
                          <TableCell>
                            {om.status === "pending" && (
                              <input
                                type="checkbox"
                                checked={selectedOmIds.includes(om.id)}
                                onChange={(e) => {
                                  setSelectedOmIds(prev =>
                                    e.target.checked ? [...prev, om.id] : prev.filter(id => id !== om.id)
                                  );
                                }}
                              />
                            )}
                          </TableCell>
                          <TableCell className="font-mono">{om.orderNumber}</TableCell>
                          <TableCell>{omStatusBadge(om.status)}</TableCell>
                          <TableCell>{om.inventoryId ? `INV #${om.inventoryId}` : "—"}</TableCell>
                          <TableCell>{om.totalItems}</TableCell>
                          <TableCell>{om.waveId ? `Onda #${om.waveId}` : "—"}</TableCell>
                          <TableCell>{fmtDate(om.createdAt)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </Card>
            )}

            {selectedOmIds.length > 0 && (
              <div className="mt-4 flex items-center gap-3 p-3 bg-muted rounded-lg">
                <span className="text-sm">{selectedOmIds.length} OM(s) selecionada(s)</span>
                <Dialog open={waveDialogOpen} onOpenChange={setWaveDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Waves className="h-4 w-4 mr-1" />Criar Onda de Movimentação</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>Criar Onda de Movimentação</DialogTitle></DialogHeader>
                    <div className="space-y-4 py-2">
                      <p className="text-sm text-muted-foreground">
                        Serão agrupadas <strong>{selectedOmIds.length}</strong> OMs nesta onda.
                      </p>
                      <Button
                        className="w-full"
                        onClick={() => createWaveMut.mutate({ orderIds: selectedOmIds })}
                        disabled={createWaveMut.isPending}
                      >
                        {createWaveMut.isPending ? "Criando..." : "Confirmar Onda"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
                <Button variant="ghost" size="sm" onClick={() => setSelectedOmIds([])}>
                  <XCircle className="h-4 w-4 mr-1" />Limpar seleção
                </Button>
              </div>
            )}
          </TabsContent>

          {/* ── ONDAS ── */}
          <TabsContent value="ondas">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-white">Ondas de Movimentação</h2>
              <Button variant="outline" size="sm" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => utils.inventoryMgmt.listMovementWaves.invalidate()}>
                <RefreshCw className="h-4 w-4 mr-1" />Atualizar
              </Button>
            </div>
            <Card className="bg-white/5 border-white/10">
              <CardContent className="pt-4">
                {wavesQ.isLoading ? (
                  <p className="text-center py-8 text-white/60 text-sm">Carregando ondas...</p>
                ) : !wavesQ.data?.waves?.length ? (
                  <p className="text-white/60 text-sm text-center py-8">
                    Nenhuma onda de movimentação criada. Selecione OMs na aba "OMs de Sobra" e crie uma onda.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left">
                        <th className="py-2 px-3 text-white/70 font-medium">Número</th>
                        <th className="py-2 px-3 text-white/70 font-medium">Status</th>
                        <th className="py-2 px-3 text-white/70 font-medium">OMs</th>
                        <th className="py-2 px-3 text-white/70 font-medium">Itens</th>
                        <th className="py-2 px-3 text-white/70 font-medium">Qtd. Total</th>
                        <th className="py-2 px-3 text-white/70 font-medium">Criada em</th>
                        <th className="py-2 px-3 text-white/70 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {wavesQ.data.waves.map((w) => (
                        <tr key={w.id} className="border-b border-white/5 hover:bg-white/5">
                          <td className="py-2 px-3 font-mono text-white">{w.waveNumber}</td>
                          <td className="py-2 px-3">
                            <Badge variant="outline" className="text-xs capitalize bg-white/10 text-white border-white/30">{w.status}</Badge>
                          </td>
                          <td className="py-2 px-3 text-white">{w.totalOrders}</td>
                          <td className="py-2 px-3 text-white">{w.totalItems}</td>
                          <td className="py-2 px-3 text-white">{w.totalQuantity}</td>
                          <td className="py-2 px-3 text-white/70">{new Date(w.createdAt).toLocaleString("pt-BR")}</td>
                          <td className="py-2 px-3">
                            <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white text-xs" onClick={() => window.location.href = '/collector/picking'}>
                              Executar
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Dialog de cancelamento */}
      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancelar Inventário</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Esta ação é irreversível. Todos os endereços serão desbloqueados.
            </p>
            <div>
              <Label>Justificativa (obrigatória)</Label>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Descreva o motivo do cancelamento..."
                rows={3}
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                className="flex-1"
                disabled={cancelReason.length < 5 || cancelMut.isPending}
                onClick={() => {
                  if (cancelTargetId) {
                    cancelMut.mutate({ id: cancelTargetId, reason: cancelReason });
                  }
                }}
              >
                {cancelMut.isPending ? "Cancelando..." : "Confirmar Cancelamento"}
              </Button>
              <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setCancelDialogOpen(false)}>Voltar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}


