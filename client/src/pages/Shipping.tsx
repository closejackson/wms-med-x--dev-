import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Package, FileText, Truck, ArrowLeft, Trash2, AlertTriangle, Link2, X } from "lucide-react";
import { Link } from "wouter";
import { ManifestPrint } from "@/components/ManifestPrint";

export default function Shipping() {
  const toast = ({ title, description, variant }: { title: string; description?: string; variant?: string }) => {
    alert(`${title}${description ? '\n' + description : ''}`);
  };
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]);
  const [selectedManifests, setSelectedManifests] = useState<number[]>([]);
  const [printManifestId, setPrintManifestId] = useState<number | null>(null);
  const printRef = useRef<{ print: () => void }>(null);
  
  // Query para dados de impressão
  const { data: printData } = trpc.shipping.generateManifestPDF.useQuery(
    { manifestId: printManifestId! },
    { enabled: printManifestId !== null }
  );
  
  // Disparar impressão quando dados estiverem prontos
  useEffect(() => {
    if (printData && printRef.current) {
      printRef.current.print();
      setPrintManifestId(null); // Limpar após imprimir
    }
  }, [printData]);
  
  // Queries
  const { data: orders, refetch: refetchOrders, isLoading: loadingOrders } = trpc.shipping.listOrders.useQuery();
  const { data: invoices, refetch: refetchInvoices, isLoading: loadingInvoices } = trpc.shipping.listInvoices.useQuery();
  const { data: manifests, refetch: refetchManifests, isLoading: loadingManifests } = trpc.shipping.listManifests.useQuery();

  // Mutations
  const importInvoice = trpc.shipping.importInvoice.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchInvoices();
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  // Nova mutation: vincular NF a múltiplos pedidos
  const linkInvoiceToOrders = trpc.shipping.linkInvoiceToOrders.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchInvoices();
      refetchOrders();
      setLinkForm({ invoiceNumber: '', orderNumbers: [] });
    },
    onError: (error) => {
      try {
        const parsed = JSON.parse(error.message);
        if (parsed.type === "SKU_MAPPING_REQUIRED") {
          setSkuMappingModal({
            open: true,
            invoiceNumber: linkForm.invoiceNumber,
            orderNumber: linkForm.orderNumbers[0] || '',
            unresolvedItems: parsed.unresolvedItems,
            orderItems: parsed.orderItems,
            selections: {},
          });
          return;
        }
        if (parsed.type === "UOM_CONVERSION_REQUIRED") {
          setUomConversionModal({
            open: true,
            sku: parsed.sku,
            productId: parsed.productId,
            nfeUnit: parsed.nfeUnit,
            nfeQty: parsed.nfeQty,
            orderQty: parsed.orderQty,
            invoiceNumber: linkForm.invoiceNumber,
            orderNumber: linkForm.orderNumbers[0] || '',
            factor: "",
          });
          return;
        }
      } catch { /* não é JSON */ }
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const linkInvoice = trpc.shipping.linkInvoiceToOrder.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchInvoices();
      refetchOrders();
    },
    onError: (error) => {
      // Verificar se é um erro estruturado
      try {
        const parsed = JSON.parse(error.message);
        if (parsed.type === "SKU_MAPPING_REQUIRED") {
          // Abrir modal De/Para com os itens não identificados
          setSkuMappingModal({
            open: true,
            invoiceNumber: linkForm.invoiceNumber,
            orderNumber: linkForm.orderNumbers[0] || '',
            orderTenantId: parsed.orderTenantId,
            unresolvedItems: parsed.unresolvedItems,
            orderItems: parsed.orderItems,
            selections: {},
          });
          return;
        }
        if (parsed.type === "UOM_CONVERSION_REQUIRED") {
          // Abrir modal de Fator de Conversão Pendente
          setUomConversionModal({
            open: true,
            sku: parsed.sku,
            productId: parsed.productId,
            nfeUnit: parsed.nfeUnit,
            nfeQty: parsed.nfeQty,
            orderQty: parsed.orderQty,
            invoiceNumber: linkForm.invoiceNumber,
            orderNumber: linkForm.orderNumbers[0] || '',
            factor: "",
          });
          return;
        }
      } catch {
        // Não é JSON — erro comum
      }
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const createManifest = trpc.shipping.createManifest.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchManifests();
      refetchOrders();
      refetchInvoices();
      setSelectedOrders([]);
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const finalizeManifest = trpc.shipping.finalizeManifest.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchManifests();
      refetchOrders();
      refetchInvoices();
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const unlinkInvoice = trpc.shipping.unlinkInvoice.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchInvoices();
      refetchOrders();
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const deleteInvoice = trpc.shipping.deleteInvoice.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchInvoices();
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const deleteManifests = trpc.shipping.deleteMany.useMutation({
    onSuccess: (data) => {
      toast({ 
        title: "Sucesso", 
        description: `${data.deletedCount} romaneio(s) excluído(s). ${data.releasedOrders} pedido(s) liberado(s).` 
      });
      refetchManifests();
      refetchOrders();
      setSelectedManifests([]);
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const cancelShipping = trpc.shipping.cancelShipping.useMutation({
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: data.message });
      refetchOrders();
      refetchInvoices();
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  // ── Estado do Modal De/Para ────────────────────────────────────────────────
  const [skuMappingModal, setSkuMappingModal] = useState<{
    open: boolean;
    invoiceNumber: string;
    orderNumber: string;
    orderTenantId?: number;
    unresolvedItems: { nfeCodigo: string; nfeDescricao: string }[];
    orderItems: { productId: number; sku: string; description: string | null; batch: string | null }[];
    // Mapeamento atual: nfeCodigo -> productId selecionado
    selections: Record<string, string>;
  }>({
    open: false,
    invoiceNumber: "",
    orderNumber: "",
    orderTenantId: undefined,
    unresolvedItems: [],
    orderItems: [],
    selections: {},
  });

  // 📦 Estado do Modal de Fator de Conversão Pendente (UOM)
  const [uomConversionModal, setUomConversionModal] = useState<{
    open: boolean;
    sku: string;
    productId: number;
    nfeUnit: string;
    nfeQty: number;
    orderQty: number;
    invoiceNumber: string;
    orderNumber: string;
    factor: string;
  }>({
    open: false,
    sku: "",
    productId: 0,
    nfeUnit: "",
    nfeQty: 0,
    orderQty: 0,
    invoiceNumber: "",
    orderNumber: "",
    factor: "",
  });

  // 📦 Mutation para salvar fator de conversão UOM diretamente do modal de Shipping
  const saveUomFactor = trpc.unitConversion.upsertConversion.useMutation({
    onSuccess: () => {
      const { invoiceNumber, orderNumber, nfeUnit, sku, factor } = uomConversionModal;
      toast({ title: "Fator salvo", description: `1 ${nfeUnit} = ${factor} UN para ${sku}` });
      setUomConversionModal(prev => ({ ...prev, open: false }));
      // Retentar o vínculo automaticamente
      linkInvoice.mutate({ invoiceNumber, orderNumber });
    },
    onError: (error) => {
      toast({ title: "Erro ao salvar fator", description: error.message, variant: "destructive" });
    },
  });

  const confirmSkuMapping = trpc.shipping.confirmSkuMapping.useMutation({
    onSuccess: (data) => {
      toast({ title: "De/Para salvo", description: data.message });
      // Fechar modal e retentar o vínculo automaticamente
      const { invoiceNumber, orderNumber } = skuMappingModal;
      setSkuMappingModal(prev => ({ ...prev, open: false }));
      linkInvoice.mutate({ invoiceNumber, orderNumber });
    },
    onError: (error) => {
      toast({ title: "Erro ao salvar De/Para", description: error.message, variant: "destructive" });
    },
  });

  const handleConfirmSkuMapping = () => {
    const { invoiceNumber, orderNumber, orderTenantId, unresolvedItems, selections } = skuMappingModal;
    // Validar que todos os itens foram mapeados
    const unmapped = unresolvedItems.filter(item => !selections[item.nfeCodigo]);
    if (unmapped.length > 0) {
      toast({ title: "Mapeamento incompleto", description: `Selecione o produto do pedido para: ${unmapped.map(u => u.nfeCodigo).join(", ")}`, variant: "destructive" });
      return;
    }
    const mappings = unresolvedItems.map(item => ({
      productId: parseInt(selections[item.nfeCodigo]),
      nfeCodigo: item.nfeCodigo,
    }));
    confirmSkuMapping.mutate({ mappings, orderNumber, invoiceNumber, orderTenantId });
  };

  // Form states
  const [invoiceForm, setInvoiceForm] = useState({
    xmlContent: '',
    invoiceNumber: '',
    series: '1',
    invoiceKey: '',
    customerId: 1,
    customerName: 'Hapvida',
    volumes: 1,
    totalValue: '0.00',
    issueDate: new Date().toISOString().split('T')[0],
  });

  const [linkForm, setLinkForm] = useState({
    invoiceNumber: '',
    orderNumbers: [] as string[],
  });
  // Estado para o input de busca de pedidos no multi-select
  const [orderSearchInput, setOrderSearchInput] = useState('');

  const [manifestForm, setManifestForm] = useState({
    carrierName: '',
  });

  const handleImportInvoice = () => {
    importInvoice.mutate(invoiceForm);
  };

  const handleLinkInvoice = () => {
    if (linkForm.orderNumbers.length === 0) {
      toast({ title: "Erro", description: "Selecione ao menos um pedido", variant: "destructive" });
      return;
    }
    linkInvoiceToOrders.mutate({
      invoiceNumber: linkForm.invoiceNumber,
      orderNumbers: linkForm.orderNumbers,
    });
  };

  const handleToggleLinkOrder = (orderNumber: string) => {
    setLinkForm(prev => ({
      ...prev,
      orderNumbers: prev.orderNumbers.includes(orderNumber)
        ? prev.orderNumbers.filter(n => n !== orderNumber)
        : [...prev.orderNumbers, orderNumber],
    }));
  };

  const handleCreateManifest = () => {
    if (selectedOrders.length === 0) {
      toast({ title: "Erro", description: "Selecione pelo menos um pedido", variant: "destructive" });
      return;
    }
    createManifest.mutate({
      carrierName: manifestForm.carrierName,
      orderIds: selectedOrders,
    });
  };

  const handleDeleteManifests = () => {
    if (selectedManifests.length === 0) {
      toast({ title: "Erro", description: "Selecione pelo menos um romaneio", variant: "destructive" });
      return;
    }
    
    const confirmed = confirm(
      `Tem certeza que deseja excluir ${selectedManifests.length} romaneio(s)?\n\n` +
      `Os pedidos serão liberados e voltarão para a fila de expedição.`
    );
    
    if (confirmed) {
      deleteManifests.mutate({ ids: selectedManifests });
    }
  };

  const handleToggleManifest = (manifestId: number) => {
    setSelectedManifests(prev => 
      prev.includes(manifestId)
        ? prev.filter(id => id !== manifestId)
        : [...prev, manifestId]
    );
  };

  const handleToggleAllManifests = () => {
    if (!manifests) return;
    
    // Filtrar apenas romaneios que não foram expedidos
    const selectableManifests = manifests.filter(m => m.status !== "shipped");
    
    if (selectedManifests.length === selectableManifests.length) {
      setSelectedManifests([]);
    } else {
      setSelectedManifests(selectableManifests.map(m => m.id));
    }
  };

  const toggleOrderSelection = (orderId: number) => {
    setSelectedOrders(prev =>
      prev.includes(orderId)
        ? prev.filter(id => id !== orderId)
        : [...prev, orderId]
    );
  };

  const handleUnlinkInvoice = (invoiceNumber: string) => {
    if (confirm(`Deseja realmente desvincular a NF ${invoiceNumber}?`)) {
      unlinkInvoice.mutate({ invoiceNumber });
    }
  };

  const handleDeleteInvoice = (invoiceNumber: string) => {
    if (confirm(`Deseja realmente excluir a NF ${invoiceNumber}? Esta ação não pode ser desfeita.`)) {
      deleteInvoice.mutate({ invoiceNumber });
    }
  };

  const getShippingStatusBadge = (status: string | null) => {
    const variants: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
      awaiting_invoice: { label: "Aguardando NF", variant: "secondary" },
      invoice_linked: { label: "NF Vinculada", variant: "default" },
      in_manifest: { label: "Em Romaneio", variant: "outline" },
      shipped: { label: "Expedido", variant: "destructive" },
    };
    const config = variants[status || 'awaiting_invoice'] || variants.awaiting_invoice;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getInvoiceStatusBadge = (status: string) => {
    const variants: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
      imported: { label: "Importada", variant: "secondary" },
      linked: { label: "Vinculada", variant: "default" },
      in_manifest: { label: "Em Romaneio", variant: "outline" },
      shipped: { label: "Expedida", variant: "destructive" },
    };
    const config = variants[status] || variants.imported;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getManifestStatusBadge = (status: string) => {
    const variants: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
      draft: { label: "Rascunho", variant: "secondary" },
      ready: { label: "Pronto", variant: "default" },
      collected: { label: "Coletado", variant: "outline" },
      shipped: { label: "Expedido", variant: "destructive" },
    };
    const config = variants[status] || variants.draft;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/home">
          <Button variant="ghost" size="icon" className="text-white hover:text-white hover:bg-white/20">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-white drop-shadow-lg">Módulo de Expedição</h1>
          <p className="text-white/80 drop-shadow">Gerencie pedidos prontos para expedição</p>
        </div>
      </div>

      <Tabs defaultValue="orders" className="space-y-4">
        <TabsList className="bg-white/10">
          <TabsTrigger className="text-white data-[state=active]:bg-white data-[state=active]:text-black" value="orders">
            <Package className="h-4 w-4 mr-2" />
            Pedidos
          </TabsTrigger>
          <TabsTrigger className="text-white data-[state=active]:bg-white data-[state=active]:text-black" value="invoices">
            <FileText className="h-4 w-4 mr-2" />
            Notas Fiscais
          </TabsTrigger>
          <TabsTrigger className="text-white data-[state=active]:bg-white data-[state=active]:text-black" value="manifests">
            <Truck className="h-4 w-4 mr-2" />
            Romaneios
          </TabsTrigger>
        </TabsList>

        {/* ABA PEDIDOS */}
        <TabsContent value="orders" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Pedidos Prontos para Expedição</CardTitle>
              <CardDescription>
                Pedidos conferidos no Stage (aguardando NF ou com NF vinculada, fora de romaneio)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingOrders ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : orders && orders.length > 0 ? (
                <div className="space-y-2">
                  {orders.map((order) => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="flex items-center gap-4 flex-1 cursor-pointer" onClick={() => toggleOrderSelection(order.id)}>
                        <input
                          type="checkbox"
                          checked={selectedOrders.includes(order.id)}
                          onChange={() => toggleOrderSelection(order.id)}
                          className="h-4 w-4"
                        />
                        <div>
                          <p className="font-medium">{order.customerOrderNumber}</p>
                          <p className="text-sm text-muted-foreground">
                            {order.customerName} • ID: {order.id}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {getShippingStatusBadge(order.shippingStatus)}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Deseja cancelar a expedição do pedido ${order.customerOrderNumber}?\n\nO pedido retornará para o Stage para nova conferência.`)) {
                              cancelShipping.mutate({ orderId: order.id });
                            }
                          }}
                          disabled={cancelShipping.isPending}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  Nenhum pedido pronto para expedição
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA NOTAS FISCAIS */}
        <TabsContent value="invoices" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Importar Nota Fiscal (XML)</CardTitle>
              <CardDescription>Simular importação de XML de NF-e</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Número da NF</Label>
                  <Input
                    value={invoiceForm.invoiceNumber}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, invoiceNumber: e.target.value })}
                    placeholder="12345"
                  />
                </div>
                <div>
                  <Label>Série</Label>
                  <Input
                    value={invoiceForm.series}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, series: e.target.value })}
                    placeholder="1"
                  />
                </div>
                <div>
                  <Label>Chave de Acesso (44 dígitos)</Label>
                  <Input
                    value={invoiceForm.invoiceKey}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, invoiceKey: e.target.value })}
                    placeholder="35210712345678901234567890123456789012345678"
                    maxLength={44}
                  />
                </div>
                <div>
                  <Label>Cliente</Label>
                  <Input
                    value={invoiceForm.customerName}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, customerName: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Volumes</Label>
                  <Input
                    type="number"
                    value={invoiceForm.volumes}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, volumes: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Valor Total</Label>
                  <Input
                    value={invoiceForm.totalValue}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, totalValue: e.target.value })}
                    placeholder="1500.00"
                  />
                </div>
                <div>
                  <Label>Data de Emissão</Label>
                  <Input
                    type="date"
                    value={invoiceForm.issueDate}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, issueDate: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Conteúdo XML (simplificado)</Label>
                <Textarea
                  value={invoiceForm.xmlContent}
                  onChange={(e) => setInvoiceForm({ ...invoiceForm, xmlContent: e.target.value })}
                  placeholder="<nfeProc>...</nfeProc>"
                  rows={3}
                />
              </div>
              <Button onClick={handleImportInvoice} disabled={importInvoice.isPending}>
                {importInvoice.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Importar NF
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Vincular NF a Pedido(s)</CardTitle>
              <CardDescription>Associe uma nota fiscal a um ou mais pedidos de separação. A validação é feita contra o conjunto consolidado dos pedidos selecionados.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Nº da NF</Label>
                <Input
                  type="text"
                  value={linkForm.invoiceNumber}
                  onChange={(e) => setLinkForm({ ...linkForm, invoiceNumber: e.target.value })}
                  placeholder="12345"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Pedidos a Vincular</Label>
                {/* Pedidos já selecionados */}
                {linkForm.orderNumbers.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2 mb-2">
                    {linkForm.orderNumbers.map(num => (
                      <Badge key={num} variant="default" className="flex items-center gap-1 pr-1">
                        {num}
                        <button
                          type="button"
                          onClick={() => handleToggleLinkOrder(num)}
                          className="ml-1 rounded-full hover:bg-white/20 p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                {/* Campo de busca + lista de pedidos disponíveis */}
                <Input
                  placeholder="Buscar pedido por número..."
                  value={orderSearchInput}
                  onChange={(e) => setOrderSearchInput(e.target.value)}
                  className="mt-1"
                />
                <div className="border rounded-md mt-1 max-h-48 overflow-y-auto">
                  {loadingOrders ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  ) : (
                    (orders || [])
                      .filter(o =>
                        // Aceitar pedidos aguardando NF: shippingStatus null ou 'awaiting_invoice'
                        (o.shippingStatus === 'awaiting_invoice' || o.shippingStatus === null) &&
                        (!orderSearchInput || o.customerOrderNumber?.toLowerCase().includes(orderSearchInput.toLowerCase()) || o.customerName?.toLowerCase().includes(orderSearchInput.toLowerCase()))
                      )
                      .map(order => (
                        <div
                          key={order.id}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-muted cursor-pointer border-b last:border-b-0"
                          onClick={() => handleToggleLinkOrder(order.customerOrderNumber || '')}
                        >
                          <Checkbox
                            checked={linkForm.orderNumbers.includes(order.customerOrderNumber || '')}
                            onCheckedChange={() => handleToggleLinkOrder(order.customerOrderNumber || '')}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{order.customerOrderNumber}</p>
                            <p className="text-xs text-muted-foreground truncate">{order.customerName}</p>
                          </div>
                          {getShippingStatusBadge(order.shippingStatus)}
                        </div>
                      ))
                  )}
                  {!loadingOrders && (orders || []).filter(o => o.shippingStatus === 'awaiting_invoice' || o.shippingStatus === null).length === 0 && (
                    <p className="text-center text-muted-foreground py-4 text-sm">Nenhum pedido aguardando NF</p>
                  )}
                </div>
              </div>

              <Button
                onClick={handleLinkInvoice}
                disabled={linkInvoiceToOrders.isPending || !linkForm.invoiceNumber || linkForm.orderNumbers.length === 0}
              >
                {linkInvoiceToOrders.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Vincular {linkForm.orderNumbers.length > 1 ? `(${linkForm.orderNumbers.length} pedidos)` : 'Pedido'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notas Fiscais Importadas</CardTitle>
              <CardDescription>Listagem de todas as NFs no sistema</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingInvoices ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : invoices && invoices.length > 0 ? (
                <div className="space-y-2">
                  {invoices.map((invoice) => (
                    <div key={invoice.id} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex-1">
                        <p className="font-medium">NF {invoice.invoiceNumber}-{invoice.series}</p>
                        <p className="text-sm text-muted-foreground">
                          {invoice.customerName} • Pedido: {invoice.orderNumber || 'Não vinculado'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Volumes: {invoice.volumes} • Valor: R$ {invoice.totalValue}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {getInvoiceStatusBadge(invoice.status)}
                        {invoice.status === 'linked' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleUnlinkInvoice(invoice.invoiceNumber)}
                          >
                            Desvincular
                          </Button>
                        )}
                        {invoice.status === 'imported' && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDeleteInvoice(invoice.invoiceNumber)}
                          >
                            Excluir
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  Nenhuma nota fiscal importada
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ABA ROMANEIOS */}
        <TabsContent value="manifests" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Criar Romaneio</CardTitle>
              <CardDescription>
                Selecione pedidos na aba "Pedidos" e informe a transportadora
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Transportadora</Label>
                <Input
                  value={manifestForm.carrierName}
                  onChange={(e) => setManifestForm({ ...manifestForm, carrierName: e.target.value })}
                  placeholder="Transportadora XYZ"
                />
              </div>
              <div>
                <Label>Pedidos Selecionados</Label>
                <p className="text-sm text-muted-foreground">
                  {selectedOrders.length > 0
                    ? `${selectedOrders.length} pedido(s) selecionado(s): ${selectedOrders.join(', ')}`
                    : 'Nenhum pedido selecionado (vá para aba Pedidos)'}
                </p>
              </div>
              <Button 
                onClick={handleCreateManifest} 
                disabled={createManifest.isPending || selectedOrders.length === 0}
              >
                {createManifest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Criar Romaneio
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Romaneios Criados</CardTitle>
                  <CardDescription>Listagem de todos os romaneios</CardDescription>
                </div>
                {selectedManifests.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDeleteManifests}
                    disabled={deleteManifests.isPending}
                  >
                    {deleteManifests.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Excluir Selecionados ({selectedManifests.length})
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {loadingManifests ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : manifests && manifests.length > 0 ? (
                <div className="space-y-2">
                  {/* Checkbox Selecionar Todos */}
                  <div className="flex items-center gap-2 p-2 border-b">
                    <input
                      type="checkbox"
                      checked={selectedManifests.length === manifests.filter(m => m.status !== "shipped").length && manifests.filter(m => m.status !== "shipped").length > 0}
                      onChange={handleToggleAllManifests}
                      className="h-4 w-4 cursor-pointer"
                    />
                    <span className="text-sm font-medium">Selecionar Todos</span>
                  </div>
                  
                  {manifests.map((manifest) => (
                    <div key={manifest.id} className="flex items-center gap-3 p-4 border rounded-lg">
                      {/* Checkbox de seleção */}
                      {manifest.status !== "shipped" && (
                        <input
                          type="checkbox"
                          checked={selectedManifests.includes(manifest.id)}
                          onChange={() => handleToggleManifest(manifest.id)}
                          className="h-4 w-4 cursor-pointer"
                        />
                      )}
                      
                      <div className="flex-1">
                        <p className="font-medium">{manifest.manifestNumber}</p>
                        <p className="text-sm text-muted-foreground">
                          {manifest.carrierName} • {manifest.totalOrders} pedido(s) • {manifest.totalVolumes} volume(s)
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ID: {manifest.id}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {getManifestStatusBadge(manifest.status)}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPrintManifestId(manifest.id)}
                        >
                          Imprimir
                        </Button>
                        {manifest.status === 'draft' && (
                          <Button
                            size="sm"
                            onClick={() => finalizeManifest.mutate({ manifestId: manifest.id })}
                            disabled={finalizeManifest.isPending}
                          >
                            {finalizeManifest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Finalizar
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  Nenhum romaneio criado
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
      {/* Componente de impressão (oculto) */}
      {printData && (
        <div style={{ display: 'none' }}>
          <ManifestPrint ref={printRef} data={printData} />
        </div>
      )}

      {/* ── Modal De/Para: Vínculo Manual de SKU ── */}
      <Dialog open={skuMappingModal.open} onOpenChange={(open) => setSkuMappingModal(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-amber-500" />
              Vínculo Manual de Código (De/Para)
            </DialogTitle>
            <DialogDescription>
              Os itens abaixo da NF <strong>{skuMappingModal.invoiceNumber}</strong> não foram identificados
              automaticamente no pedido <strong>{skuMappingModal.orderNumber}</strong>.
              Selecione o produto correspondente para cada código. O vínculo será salvo e aplicado
              automaticamente nas próximas expedições.
            </DialogDescription>
          </DialogHeader>

          <Alert className="border-amber-500/50 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <AlertDescription className="text-amber-700 dark:text-amber-400">
              Após confirmar, o sistema salvará o De/Para e tentará vincular a NF automaticamente.
            </AlertDescription>
          </Alert>

          <div className="space-y-4 max-h-96 overflow-y-auto py-1">
            {skuMappingModal.unresolvedItems.map((item) => (
              <div key={item.nfeCodigo} className="border rounded-lg p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Código na NF</p>
                    <p className="font-mono font-bold">{item.nfeCodigo}</p>
                    {item.nfeDescricao !== item.nfeCodigo && (
                      <p className="text-xs text-muted-foreground">{item.nfeDescricao}</p>
                    )}
                  </div>
                  <div className="text-muted-foreground text-2xl">→</div>
                  <div className="flex-1 ml-4">
                    <p className="text-sm font-medium text-muted-foreground mb-1">Produto no Pedido</p>
                    <Select
                      value={skuMappingModal.selections[item.nfeCodigo] || ""}
                      onValueChange={(value) =>
                        setSkuMappingModal(prev => ({
                          ...prev,
                          selections: { ...prev.selections, [item.nfeCodigo]: value },
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione o produto..." />
                      </SelectTrigger>
                      <SelectContent>
                        {skuMappingModal.orderItems.map((orderItem) => (
                          <SelectItem key={orderItem.productId} value={String(orderItem.productId)}>
                            <span className="font-mono">{orderItem.sku}</span>
                            {orderItem.description && (
                              <span className="ml-2 text-muted-foreground text-xs">
                                — {orderItem.description.substring(0, 40)}
                              </span>
                            )}
                            {orderItem.batch && (
                              <span className="ml-1 text-xs text-blue-500">Lote: {orderItem.batch}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSkuMappingModal(prev => ({ ...prev, open: false }))}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmSkuMapping}
              disabled={confirmSkuMapping.isPending}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {confirmSkuMapping.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar De/Para e Vincular NF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 📦 Modal de Fator de Conversão Pendente (UOM) */}
      <Dialog open={uomConversionModal.open} onOpenChange={(open) => setUomConversionModal(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              Fator de Conversão Pendente
            </DialogTitle>
            <DialogDescription>
              A NF usa a unidade <strong>{uomConversionModal.nfeUnit}</strong> para o SKU{" "}
              <strong>{uomConversionModal.sku}</strong>, mas não há fator de conversão cadastrado.
              Informe quantas unidades base (UN) correspondem a 1{" "}{uomConversionModal.nfeUnit}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-muted rounded-lg p-3">
                <p className="text-muted-foreground text-xs mb-1">Quantidade na NF</p>
                <p className="font-bold text-lg">{uomConversionModal.nfeQty} <span className="text-muted-foreground text-sm">{uomConversionModal.nfeUnit}</span></p>
              </div>
              <div className="bg-muted rounded-lg p-3">
                <p className="text-muted-foreground text-xs mb-1">Quantidade no Pedido</p>
                <p className="font-bold text-lg">{uomConversionModal.orderQty} <span className="text-muted-foreground text-sm">UN</span></p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="uom-factor">
                Fator de Conversão: 1 {uomConversionModal.nfeUnit} ={" "}
                <span className="text-primary font-semibold">
                  {uomConversionModal.factor ? `${uomConversionModal.factor} UN` : "? UN"}
                </span>
              </Label>
              <Input
                id="uom-factor"
                type="number"
                min="1"
                step="1"
                placeholder={`Ex: ${uomConversionModal.orderQty > 0 && uomConversionModal.nfeQty > 0 ? Math.round(uomConversionModal.orderQty / uomConversionModal.nfeQty) : "6"}`}
                value={uomConversionModal.factor}
                onChange={(e) => setUomConversionModal(prev => ({ ...prev, factor: e.target.value }))}
              />
              {uomConversionModal.factor && parseFloat(uomConversionModal.factor) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Resultado: {uomConversionModal.nfeQty} {uomConversionModal.nfeUnit} ×{" "}
                  {uomConversionModal.factor} ={" "}
                  <strong>{uomConversionModal.nfeQty * parseFloat(uomConversionModal.factor)} UN</strong>
                  {uomConversionModal.nfeQty * parseFloat(uomConversionModal.factor) === uomConversionModal.orderQty
                    ? " ✅ Corresponde ao pedido"
                    : ` ⚠️ Pedido espera ${uomConversionModal.orderQty} UN`}
                </p>
              )}
            </div>

            <Alert>
              <AlertDescription className="text-xs">
                Este fator será salvo para o produto <strong>{uomConversionModal.sku}</strong> e aplicado
                automaticamente nas próximas expedições. Você pode editá-lo em <em>Cadastros &gt; Conversão de Unidades</em>.
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUomConversionModal(prev => ({ ...prev, open: false }))}
            >
              Cancelar
            </Button>
            <Button
              disabled={!uomConversionModal.factor || parseFloat(uomConversionModal.factor) <= 0 || saveUomFactor.isPending}
              className="bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                const factor = parseFloat(uomConversionModal.factor);
                if (!factor || factor <= 0) return;
                saveUomFactor.mutate({
                  productId: uomConversionModal.productId,
                  unitCode: uomConversionModal.nfeUnit,
                  factorToBase: factor,
                  roundingStrategy: "round",
                  notes: `Cadastrado automaticamente ao vincular NF ${uomConversionModal.invoiceNumber}`,
                });
              }}
            >
              {saveUomFactor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar Fator e Vincular NF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
