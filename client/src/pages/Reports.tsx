import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileText, Download, Printer, Star, Filter, BarChart3, Package, TruckIcon, Shield, ArrowLeft } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { exportToCSV, exportToExcel, exportToPDF } from "@/lib/reportExport";
import { StockByZoneChart } from "@/components/charts/StockByZoneChart";
import { TopProductsChart } from "@/components/charts/TopProductsChart";
import { MovementsTimelineChart } from "@/components/charts/MovementsTimelineChart";
import { OperatorProductivityChart } from "@/components/charts/OperatorProductivityChart";

type ReportCategory = 'stock' | 'operational' | 'shipping' | 'audit';

interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  category: ReportCategory;
  icon: React.ReactNode;
}

const AVAILABLE_REPORTS: ReportDefinition[] = [
  // Relatórios de Estoque
  {
    id: 'stockPosition',
    name: 'Posição de Estoque',
    description: 'Visão detalhada do estoque por produto, lote, endereço e cliente',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  {
    id: 'stockByTenant',
    name: 'Estoque por Cliente',
    description: 'Totalização de estoque agrupado por cliente',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  {
    id: 'stockByLocation',
    name: 'Estoque por Endereço',
    description: 'Ocupação e utilização de endereços de armazenagem',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  {
    id: 'expiringProducts',
    name: 'Produtos Próximos ao Vencimento',
    description: 'Alerta de produtos com validade próxima (FEFO)',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  {
    id: 'productAvailability',
    name: 'Disponibilidade de Produtos',
    description: 'Análise de disponibilidade vs reservas',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  {
    id: 'inventoryMovements',
    name: 'Movimentações de Estoque',
    description: 'Histórico detalhado de movimentações',
    category: 'stock',
    icon: <Package className="h-4 w-4" />,
  },
  // Relatórios Operacionais
  {
    id: 'pickingProductivity',
    name: 'Produtividade de Separação',
    description: 'Itens separados por hora, por operador',
    category: 'operational',
    icon: <BarChart3 className="h-4 w-4" />,
  },
  {
    id: 'pickingAccuracy',
    name: 'Acuracidade de Picking',
    description: 'Taxa de acerto nas conferências (divergências vs total)',
    category: 'operational',
    icon: <BarChart3 className="h-4 w-4" />,
  },
  {
    id: 'averageCycleTime',
    name: 'Tempo Médio de Ciclo',
    description: 'Tempo entre criação e finalização de pedidos',
    category: 'operational',
    icon: <BarChart3 className="h-4 w-4" />,
  },
  {
    id: 'ordersByStatus',
    name: 'Pedidos por Status',
    description: 'Distribuição de pedidos por status',
    category: 'operational',
    icon: <BarChart3 className="h-4 w-4" />,
  },
  {
    id: 'operatorPerformance',
    name: 'Performance de Operadores',
    description: 'Métricas individuais de produtividade',
    category: 'operational',
    icon: <BarChart3 className="h-4 w-4" />,
  },
];

export default function Reports() {
  const { user } = useAuth();
  const isGlobalAdmin = user?.role === 'admin' && user?.tenantId === 1;
  const [selectedCategory, setSelectedCategory] = useState<ReportCategory>('stock');
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, any>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedTenantId, setSelectedTenantId] = useState<number | undefined>(undefined);

  const { data: tenantsList } = trpc.tenants.list.useQuery(undefined, { enabled: isGlobalAdmin });

  // Filtrar relatórios por categoria
  const categoryReports = AVAILABLE_REPORTS.filter(r => r.category === selectedCategory);
  const currentReport = AVAILABLE_REPORTS.find(r => r.id === selectedReport);

  // Queries de todos os relatórios (sempre chamadas, mas habilitadas condicionalmente)
  const defaultDateFilters = {
    startDate: filters.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: filters.endDate || new Date().toISOString().split('T')[0],
  };

  const tenantFilter = isGlobalAdmin && selectedTenantId ? { tenantId: selectedTenantId } : {};

  const stockPositionQuery = trpc.reports.stockPosition.useQuery(
    { ...filters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'stockPosition' }
  );
  const stockByTenantQuery = trpc.reports.stockByTenant.useQuery(
    { ...filters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'stockByTenant' }
  );
  const stockByLocationQuery = trpc.reports.stockByLocation.useQuery(
    { ...filters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'stockByLocation' }
  );
  const expiringProductsQuery = trpc.reports.expiringProducts.useQuery(
    { ...filters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'expiringProducts' }
  );
  const productAvailabilityQuery = trpc.reports.productAvailability.useQuery(
    { ...filters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'productAvailability' }
  );
  const inventoryMovementsQuery = trpc.reports.inventoryMovements.useQuery(
    { ...filters, ...defaultDateFilters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'inventoryMovements' }
  );
  const pickingProductivityQuery = trpc.reports.pickingProductivity.useQuery(
    { ...filters, ...defaultDateFilters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'pickingProductivity' }
  );
  const pickingAccuracyQuery = trpc.reports.pickingAccuracy.useQuery(
    { ...filters, ...defaultDateFilters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'pickingAccuracy' }
  );
  const averageCycleTimeQuery = trpc.reports.averageCycleTime.useQuery(
    { ...filters, ...defaultDateFilters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'averageCycleTime' }
  );
  const ordersByStatusQuery = trpc.reports.ordersByStatus.useQuery(
    { ...filters, ...tenantFilter },
    { enabled: selectedReport === 'ordersByStatus' }
  );
  const operatorPerformanceQuery = trpc.reports.operatorPerformance.useQuery(
    { ...filters, ...defaultDateFilters, ...tenantFilter, page: currentPage },
    { enabled: selectedReport === 'operatorPerformance' }
  );

  // Selecionar query ativa baseado no relatório selecionado
  const reportQuery = 
    selectedReport === 'stockPosition' ? stockPositionQuery :
    selectedReport === 'stockByTenant' ? stockByTenantQuery :
    selectedReport === 'stockByLocation' ? stockByLocationQuery :
    selectedReport === 'expiringProducts' ? expiringProductsQuery :
    selectedReport === 'productAvailability' ? productAvailabilityQuery :
    selectedReport === 'inventoryMovements' ? inventoryMovementsQuery :
    selectedReport === 'pickingProductivity' ? pickingProductivityQuery :
    selectedReport === 'pickingAccuracy' ? pickingAccuracyQuery :
    selectedReport === 'averageCycleTime' ? averageCycleTimeQuery :
    selectedReport === 'ordersByStatus' ? ordersByStatusQuery :
    selectedReport === 'operatorPerformance' ? operatorPerformanceQuery :
    { data: null, isLoading: false, error: null };

  const handleFilterChange = (key: string, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setCurrentPage(1); // Reset para primeira página ao mudar filtros
  };

  const handleGenerateReport = (reportId: string) => {
    setSelectedReport(reportId);
    setFilters({});
    setCurrentPage(1);
  };

  const handleExport = (format: 'excel' | 'pdf' | 'csv') => {
    if (!reportQuery.data?.data || reportQuery.data.data.length === 0) {
      alert('Nenhum dado para exportar');
      return;
    }

    const reportTitle = currentReport?.name || 'Relatório';
    const filename = selectedReport || 'relatorio';

    switch (format) {
      case 'csv':
        exportToCSV(reportQuery.data.data, filename);
        break;
      case 'excel':
        exportToExcel(reportQuery.data.data, filename, reportTitle);
        break;
      case 'pdf':
        exportToPDF(reportQuery.data.data, filename, reportTitle);
        break;
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.history.back()}
            className="flex items-center gap-2 text-white hover:text-white hover:bg-white/20"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-lg">Relatórios</h1>
            <p className="text-white/80 drop-shadow">
              Análises e relatórios gerenciais do WMS
            </p>
          </div>
        </div>
      </div>

      <Tabs value={selectedCategory} onValueChange={(v) => setSelectedCategory(v as ReportCategory)}>
        <TabsList className="bg-white/10 grid w-full grid-cols-4">
          <TabsTrigger value="stock" className="text-white data-[state=active]:bg-white data-[state=active]:text-black flex items-center gap-2">
            <Package className="h-4 w-4" />
            Estoque
          </TabsTrigger>
          <TabsTrigger value="operational" className="text-white data-[state=active]:bg-white data-[state=active]:text-black flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Operacionais
          </TabsTrigger>
          <TabsTrigger value="shipping" className="text-white data-[state=active]:bg-white data-[state=active]:text-black flex items-center gap-2">
            <TruckIcon className="h-4 w-4" />
            Expedição
          </TabsTrigger>
          <TabsTrigger value="audit" className="text-white data-[state=active]:bg-white data-[state=active]:text-black flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Auditoria
          </TabsTrigger>
        </TabsList>

        <TabsContent value={selectedCategory} className="space-y-4">
          {!selectedReport ? (
            <>
              <Alert>
                <FileText className="h-4 w-4" />
                <AlertDescription>
                  Selecione um relatório abaixo para visualizar os dados
                </AlertDescription>
              </Alert>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {categoryReports.map((report) => (
                  <Card key={report.id} className="cursor-pointer hover:border-primary transition-colors" onClick={() => handleGenerateReport(report.id)}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        {report.icon}
                        <CardTitle className="text-lg">{report.name}</CardTitle>
                      </div>
                      <CardDescription>{report.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white w-full" variant="outline">
                        <FileText className="mr-2 h-4 w-4" />
                        Gerar Relatório
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* Cabeçalho do Relatório */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>{currentReport?.name}</CardTitle>
                      <CardDescription>{currentReport?.description}</CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={() => setSelectedReport(null)}>
                        Voltar
                      </Button>
                      <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={handlePrint}>
                        <Printer className="mr-2 h-4 w-4" />
                        Imprimir
                      </Button>
                      <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={() => handleExport('excel')}>
                        <Download className="mr-2 h-4 w-4" />
                        Excel
                      </Button>
                    </div>
                  </div>
                </CardHeader>
              </Card>

              {/* Filtros Dinâmicos */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Filter className="h-4 w-4" />
                    Filtros
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">

                    {/* ── Seletor de Cliente (Global Admin) ── */}
                    {isGlobalAdmin && (
                      <div className="space-y-2">
                        <Label htmlFor="tenantSelect">Cliente</Label>
                        <Select
                          value={selectedTenantId ? String(selectedTenantId) : 'all'}
                          onValueChange={(v) => {
                            setSelectedTenantId(v === 'all' ? undefined : Number(v));
                            setCurrentPage(1);
                          }}
                        >
                          <SelectTrigger id="tenantSelect">
                            <SelectValue placeholder="Todos os clientes" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todos os clientes</SelectItem>
                            {tenantsList?.map((t) => (
                              <SelectItem key={t.id} value={String(t.id)}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* ── Filtros de DATA (relatórios operacionais e movimentações) ── */}
                    {['inventoryMovements','pickingProductivity','pickingAccuracy','averageCycleTime','operatorPerformance','ordersByStatus'].includes(selectedReport!) && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="startDate">Data Inicial</Label>
                          <Input
                            id="startDate"
                            type="date"
                            value={filters.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                            onChange={(e) => handleFilterChange('startDate', e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="endDate">Data Final</Label>
                          <Input
                            id="endDate"
                            type="date"
                            value={filters.endDate || new Date().toISOString().split('T')[0]}
                            onChange={(e) => handleFilterChange('endDate', e.target.value)}
                          />
                        </div>
                      </>
                    )}

                    {/* ── Filtros de DATA DE VALIDADE (posição de estoque) ── */}
                    {selectedReport === 'stockPosition' && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="expiryDateStart">Validade De</Label>
                          <Input
                            id="expiryDateStart"
                            type="date"
                            value={filters.expiryDateStart || ''}
                            onChange={(e) => handleFilterChange('expiryDateStart', e.target.value || undefined)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="expiryDateEnd">Validade Até</Label>
                          <Input
                            id="expiryDateEnd"
                            type="date"
                            value={filters.expiryDateEnd || ''}
                            onChange={(e) => handleFilterChange('expiryDateEnd', e.target.value || undefined)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="batchNumber">Lote</Label>
                          <Input
                            id="batchNumber"
                            type="text"
                            placeholder="Ex: LOT001"
                            value={filters.batchNumber || ''}
                            onChange={(e) => handleFilterChange('batchNumber', e.target.value || undefined)}
                          />
                        </div>
                      </>
                    )}

                    {/* ── Dias até vencimento (expiringProducts) ── */}
                    {selectedReport === 'expiringProducts' && (
                      <div className="space-y-2">
                        <Label htmlFor="daysUntilExpiry">Dias até Vencimento</Label>
                        <Input
                          id="daysUntilExpiry"
                          type="number"
                          min={1}
                          placeholder="90"
                          value={filters.daysUntilExpiry ?? 90}
                          onChange={(e) => handleFilterChange('daysUntilExpiry', parseInt(e.target.value) || 90)}
                        />
                      </div>
                    )}

                    {/* ── Tipo de endereço (stockByLocation) ── */}
                    {selectedReport === 'stockByLocation' && (
                      <div className="space-y-2">
                        <Label htmlFor="locationType">Tipo de Endereço</Label>
                        <Select value={filters.locationType || 'all'} onValueChange={(v) => handleFilterChange('locationType', v === 'all' ? undefined : v)}>
                          <SelectTrigger id="locationType">
                            <SelectValue placeholder="Todos" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todos</SelectItem>
                            <SelectItem value="whole">Inteiro</SelectItem>
                            <SelectItem value="fraction">Fração</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* ── Tipo de movimentação (inventoryMovements) ── */}
                    {selectedReport === 'inventoryMovements' && (
                      <div className="space-y-2">
                        <Label htmlFor="movementType">Tipo de Movimentação</Label>
                        <Select value={filters.movementType || 'all'} onValueChange={(v) => handleFilterChange('movementType', v === 'all' ? undefined : v)}>
                          <SelectTrigger id="movementType">
                            <SelectValue placeholder="Todos" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todos</SelectItem>
                            <SelectItem value="receiving">Recebimento</SelectItem>
                            <SelectItem value="put_away">Endereçamento</SelectItem>
                            <SelectItem value="picking">Separação</SelectItem>
                            <SelectItem value="transfer">Transferência</SelectItem>
                            <SelectItem value="adjustment">Ajuste</SelectItem>
                            <SelectItem value="return">Devolução</SelectItem>
                            <SelectItem value="disposal">Descarte</SelectItem>
                            <SelectItem value="quality">Qualidade</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* ── Botão Aplicar Filtros ── */}
                    <div className="flex items-end">
                      <Button
                        variant="default"
                        size="sm"
                        className="w-full"
                        onClick={() => setCurrentPage(1)}
                      >
                        <Filter className="mr-2 h-4 w-4" />
                        Aplicar Filtros
                      </Button>
                    </div>

                  </div>
                </CardContent>
              </Card>

              {/* Gráficos Visuais */}
              {!reportQuery.isLoading && reportQuery.data?.data && reportQuery.data.data.length > 0 && (
                <div className="space-y-4">
                  {/* Gráficos de Estoque */}
                  {selectedReport === 'stockByLocation' && (
                    <StockByZoneChart data={reportQuery.data.data} />
                  )}
                  {selectedReport === 'stockPosition' && (
                    <TopProductsChart data={reportQuery.data.data} limit={10} />
                  )}
                  
                  {/* Gráficos Operacionais */}
                  {selectedReport === 'inventoryMovements' && (
                    <MovementsTimelineChart data={reportQuery.data.data} />
                  )}
                  {(selectedReport === 'pickingProductivity' || selectedReport === 'operatorPerformance') && (
                    <OperatorProductivityChart data={reportQuery.data.data} />
                  )}
                </div>
              )}

              {/* Tabela de Resultados */}
              <Card>
                <CardContent className="pt-6">
                  {reportQuery.isLoading ? (
                    <div className="text-center py-8">Carregando dados...</div>
                  ) : reportQuery.error ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        Erro ao carregar relatório: {reportQuery.error.message}
                      </AlertDescription>
                    </Alert>
                  ) : reportQuery.data?.data && reportQuery.data.data.length > 0 ? (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {Object.keys(reportQuery.data.data[0]).map((key) => (
                              <TableHead key={key}>{key}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {reportQuery.data.data.map((row: any, idx: number) => (
                            <TableRow key={idx}>
                              {Object.values(row).map((value: any, cellIdx: number) => (
                                <TableCell key={cellIdx}>
                                  {typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
                                    ? value.substring(0, 10).split('-').reverse().join('/')
                                    : value?.toString() || '-'}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>

                      {/* Paginação */}
                      {'total' in reportQuery.data && reportQuery.data.total && (
                        <div className="flex items-center justify-between mt-4">
                          <div className="text-sm text-muted-foreground">
                            Mostrando {((currentPage - 1) * ('pageSize' in reportQuery.data ? reportQuery.data.pageSize : 50)) + 1} a{' '}
                            {Math.min(currentPage * ('pageSize' in reportQuery.data ? reportQuery.data.pageSize : 50), 'total' in reportQuery.data ? reportQuery.data.total : 0)} de{' '}
                            {'total' in reportQuery.data ? reportQuery.data.total : 0} registros
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={currentPage === 1}
                              onClick={() => setCurrentPage(p => p - 1)}
                            >
                              Anterior
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={currentPage * ('pageSize' in reportQuery.data ? reportQuery.data.pageSize : 50) >= ('total' in reportQuery.data ? reportQuery.data.total : 0)}
                              onClick={() => setCurrentPage(p => p + 1)}
                            >
                              Próxima
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      Nenhum dado encontrado para os filtros selecionados
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
