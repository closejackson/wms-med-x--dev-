import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePackagingLevels } from "@/hooks/usePackagingLevels";
import { Package, Pencil, Trash2, Search, X, FileSpreadsheet, Loader2, Home } from "lucide-react";
import { CreateProductDialog } from "@/components/CreateProductDialog";
import { ImportProductsDialog } from "@/components/ImportProductsDialog";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { useBusinessError } from "@/hooks/useBusinessError";
import { useLocation } from "wouter";

export default function Products() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  // Estados dos filtros
  const [filterTenantId, setFilterTenantId] = useState<number | undefined>(undefined);
  const [filterSku, setFilterSku] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [skuDebounced, setSkuDebounced] = useState("");

  // Debounce do SKU
  useEffect(() => {
    const t = setTimeout(() => setSkuDebounced(filterSku), 400);
    return () => clearTimeout(t);
  }, [filterSku]);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const hasFilters = !!filterTenantId || !!skuDebounced || !!filterCategory;

  // Global Admin = tenantId 1; demais usuários usam sempre o próprio tenantId
  const isGlobalAdmin = user?.tenantId === 1;
  const effectiveTenantId = isGlobalAdmin
    ? (filterTenantId ?? undefined)
    : (user?.tenantId ?? undefined);

  const { data: products, isLoading } = trpc.products.list.useQuery({
    tenantId: effectiveTenantId,
    sku: skuDebounced || undefined,
    category: filterCategory || undefined,
  });
  const { data: tenants } = trpc.tenants.list.useQuery();
  const { levels, isLoading: levelsLoading } = usePackagingLevels();
  const utils = trpc.useUtils();

  // Derivar categorias únicas dos produtos carregados (sem filtro de categoria)
  const { data: allProducts } = trpc.products.list.useQuery(
    effectiveTenantId ? { tenantId: effectiveTenantId } : undefined
  );
  const categories = Array.from(
    new Set((allProducts ?? []).map((p: any) => p.category).filter(Boolean))
  ).sort() as string[];
  
  // Hook de erros de negócio
  const businessError = useBusinessError();
  
  // Estados de seleção múltipla
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [editForm, setEditForm] = useState<{
    internalCode: string;
    customerCode: string;
    supplierCode: string;
    gtin: string;
    description: string;
    manufacturer: string;
    tenantId?: number;
    anvisaRegistry: string;
    category: string;
    storageCondition: "ambient" | "climatized_15_30" | "controlled_8_25" | "refrigerated_2_8" | "frozen_minus_20" | "controlled";
    specialTransportCategory: "none" | "thermoLabile_2_8" | "thermoLabile_extended_2_25" | "thermoStable_15_30";
    requiresBatchControl: boolean;
    requiresExpiryControl: boolean;
    unitOfMeasure: string;
    unitsPerBox?: number;
    unitsPerPallet?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    minQuantity: number;
    minOrderQty: number;
    dispensingQuantity: number;
    status: "active" | "inactive" | "discontinued";
    // legado
    sku: string;
    therapeuticClass: string;
    isControlledSubstance: boolean;
  }>({
    internalCode: "",
    customerCode: "",
    supplierCode: "",
    gtin: "",
    description: "",
    manufacturer: "",
    tenantId: undefined,
    anvisaRegistry: "",
    category: "",
    storageCondition: "ambient",
    specialTransportCategory: "none",
    requiresBatchControl: true,
    requiresExpiryControl: true,
    unitOfMeasure: "UN",
    unitsPerBox: undefined,
    unitsPerPallet: undefined,
    lengthCm: undefined,
    widthCm: undefined,
    heightCm: undefined,
    minQuantity: 0,
    minOrderQty: 0,
    dispensingQuantity: 1,
    status: "active",
    sku: "",
    therapeuticClass: "",
    isControlledSubstance: false,
  });

  const updateMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("Produto atualizado com sucesso!");
      utils.products.list.invalidate();
      setEditDialogOpen(false);
    },
    onError: (error) => {
      const message = error.message;
      
      if (message.includes("SKU já existe") || message.includes("duplicado")) {
        businessError.showDuplicateEntry("SKU", editForm.sku);
      } else if (message.includes("não tem permissão") || message.includes("FORBIDDEN")) {
        businessError.showPermissionDenied("atualizar produtos");
      } else {
        businessError.showGenericError(message);
      }
    },
  });

  const deleteMutation = trpc.products.delete.useMutation({
    onSuccess: () => {
      toast.success("Produto excluído com sucesso!");
      utils.products.list.invalidate();
      setDeleteDialogOpen(false);
    },
    onError: (error) => {
      const message = error.message;
      
      if (message.includes("não tem permissão") || message.includes("FORBIDDEN")) {
        businessError.showPermissionDenied("excluir produtos");
      } else if (message.includes("em uso") || message.includes("referência")) {
        businessError.showError({
          type: "invalid_data",
          title: "Produto em uso",
          message: "Este produto não pode ser excluído pois está sendo referenciado em pedidos ou estoque.",
          details: [
            {
              label: "Sugestão",
              value: "Altere o status do produto para 'Inativo' ao invés de excluí-lo.",
              variant: "default",
            },
          ],
        });
      } else {
        businessError.showGenericError(message);
      }
    },
  });

  const deleteManyMutation = trpc.products.deleteMany.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.deletedCount} produto(s) excluído(s) com sucesso!`);
      utils.products.list.invalidate();
      setSelectedIds([]);
      setBulkDeleteDialogOpen(false);
    },
    onError: (error) => {
      const message = error.message;
      
      if (message.includes("não tem permissão") || message.includes("FORBIDDEN")) {
        businessError.showPermissionDenied("excluir produtos em lote");
      } else {
        businessError.showGenericError(message);
      }
    },
  });

  const handleEdit = (product: any) => {
    setSelectedProduct(product);
    setEditForm({
      internalCode: product.internalCode || "",
      customerCode: product.customerCode || "",
      supplierCode: product.supplierCode || "",
      gtin: product.gtin || "",
      description: product.description || "",
      manufacturer: product.manufacturer || "",
      tenantId: product.tenantId || undefined,
      anvisaRegistry: product.anvisaRegistry || "",
      category: product.category || "",
      storageCondition: product.storageCondition || "ambient",
      specialTransportCategory: product.specialTransportCategory || "none",
      requiresBatchControl: product.requiresBatchControl ?? true,
      requiresExpiryControl: product.requiresExpiryControl ?? true,
      unitOfMeasure: product.unitOfMeasure || "UN",
      unitsPerBox: product.unitsPerBox || undefined,
      unitsPerPallet: product.unitsPerPallet || undefined,
      lengthCm: product.lengthCm ? parseFloat(product.lengthCm) : undefined,
      widthCm: product.widthCm ? parseFloat(product.widthCm) : undefined,
      heightCm: product.heightCm ? parseFloat(product.heightCm) : undefined,
      minQuantity: product.minQuantity || 0,
      minOrderQty: product.minOrderQty || 0,
      dispensingQuantity: product.dispensingQuantity || 1,
      status: product.status || "active",
      sku: product.sku || "",
      therapeuticClass: product.therapeuticClass || "",
      isControlledSubstance: product.isControlledSubstance ?? false,
    });
    setEditDialogOpen(true);
  };

  const handleDelete = (product: any) => {
    setSelectedProduct(product);
    setDeleteDialogOpen(true);
  };

  const handleUpdateSubmit = () => {
    if (!selectedProduct) return;
    if (!editForm.internalCode.trim()) {
      toast.error("Cód. Interno é obrigatório");
      return;
    }
    updateMutation.mutate({
      id: selectedProduct.id,
      internalCode: editForm.internalCode,
      // customerCode e supplierCode são preenchidos automaticamente no servidor:
      // customerCode = internalCode, supplierCode = sku
      gtin: editForm.gtin || undefined,
      description: editForm.description,
      manufacturer: editForm.manufacturer || undefined,
      tenantId: editForm.tenantId ?? null,
      anvisaRegistry: editForm.anvisaRegistry || undefined,
      category: (editForm.category as any) || undefined,
      storageCondition: editForm.storageCondition,
      specialTransportCategory: editForm.specialTransportCategory,
      requiresBatchControl: editForm.requiresBatchControl,
      requiresExpiryControl: editForm.requiresExpiryControl,
      unitOfMeasure: editForm.unitOfMeasure,
      unitsPerBox: editForm.unitsPerBox || undefined,
      unitsPerPallet: editForm.unitsPerPallet || undefined,
      lengthCm: editForm.lengthCm || undefined,
      widthCm: editForm.widthCm || undefined,
      heightCm: editForm.heightCm || undefined,
      minQuantity: editForm.minQuantity,
      minOrderQty: editForm.minOrderQty,
      dispensingQuantity: editForm.dispensingQuantity,
      status: editForm.status,
      sku: editForm.sku || editForm.internalCode,
      therapeuticClass: editForm.therapeuticClass || undefined,
    });
  };

  const handleDeleteConfirm = () => {
    if (!selectedProduct) return;
    deleteMutation.mutate({ id: selectedProduct.id });
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked && products) {
      setSelectedIds(products.map((p: any) => p.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id]);
    } else {
      setSelectedIds(selectedIds.filter(selectedId => selectedId !== id));
    }
  };

  const handleBulkDelete = () => {
    setBulkDeleteDialogOpen(true);
  };

  const handleBulkDeleteConfirm = () => {
    deleteManyMutation.mutate({ ids: selectedIds });
  };

  const getStorageConditionBadge = (condition: string) => {
    const colors: Record<string, string> = {
      ambient:          "bg-green-100 text-green-800",
      climatized_15_30: "bg-lime-100 text-lime-800",
      controlled_8_25:  "bg-yellow-100 text-yellow-800",
      refrigerated_2_8: "bg-blue-100 text-blue-800",
      frozen_minus_20:  "bg-cyan-100 text-cyan-800",
      controlled:       "bg-purple-100 text-purple-800",
    };
    const labels: Record<string, string> = {
      ambient:          "Ambiente",
      climatized_15_30: "Climatizada 15-30°C",
      controlled_8_25:  "Amb. Controlada 8-25°C",
      refrigerated_2_8: "Refrigerado 2-8°C",
      frozen_minus_20:  "Congelado -20°C",
      controlled:       "Controlado",
    };
    return (
      <Badge className={colors[condition] || "bg-gray-100 text-gray-800"}>
        {labels[condition] || condition}
      </Badge>
    );
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      active: "bg-green-100 text-green-800",
      inactive: "bg-gray-100 text-gray-800",
      discontinued: "bg-red-100 text-red-800",
    };
    const labels = {
      active: "Ativo",
      inactive: "Inativo",
      discontinued: "Descontinuado",
    };
    return (
      <Badge className={colors[status as keyof typeof colors] || colors.active}>
        {labels[status as keyof typeof labels] || status}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen">
      <PageHeader
        icon={<Package className="w-8 h-8" />}
        title="Produtos"
        description="Gestão de produtos e medicamentos"
        actions={
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setLocation("/home")}>
            <Home className="h-4 w-4 mr-2" />
            Início
          </Button>
        }
      />

      <div className="container mx-auto py-8">
        <Card>
          <CardContent className="p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-2xl font-bold">Produtos Cadastrados</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {products?.length || 0} produto(s)
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedIds.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleBulkDelete}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Excluir Selecionados ({selectedIds.length})
                  </Button>
                )}
                <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" size="sm" onClick={() => setImportDialogOpen(true)}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Importar Excel
                  </Button>
                <CreateProductDialog />
              </div>
            </div>

            {/* Barra de Filtros */}
            <div className="flex flex-wrap gap-3 mb-5 p-4 bg-muted/40 rounded-lg border">
              {/* Filtro: Cliente — visível apenas para Global Admin (tenantId=1) */}
              {isGlobalAdmin && (
              <div className="flex flex-col gap-1 min-w-[180px]">
                <span className="text-xs font-medium text-muted-foreground">Cliente</span>
                <Select
                  value={filterTenantId ? String(filterTenantId) : "all"}
                  onValueChange={(v) => {
                    setFilterTenantId(v === "all" ? undefined : Number(v));
                    setFilterCategory(""); // resetar categoria ao trocar cliente
                  }}
                >
                  <SelectTrigger className="h-9 bg-background">
                    <SelectValue placeholder="Todos os clientes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os clientes</SelectItem>
                    {(tenants ?? []).map((t: any) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              )}

              {/* Filtro: SKU */}
              <div className="flex flex-col gap-1 min-w-[180px]">
                <span className="text-xs font-medium text-muted-foreground">SKU</span>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="h-9 pl-8 bg-background"
                    placeholder="Buscar por SKU..."
                    value={filterSku}
                    onChange={(e) => setFilterSku(e.target.value)}
                  />
                  {filterSku && (
                    <button
                      className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                      onClick={() => setFilterSku("")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Filtro: Categoria */}
              <div className="flex flex-col gap-1 min-w-[180px]">
                <span className="text-xs font-medium text-muted-foreground">Categoria</span>
                <Select
                  value={filterCategory || "all"}
                  onValueChange={(v) => setFilterCategory(v === "all" ? "" : v)}
                >
                  <SelectTrigger className="h-9 bg-background">
                    <SelectValue placeholder="Todas as categorias" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas as categorias</SelectItem>
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Limpar filtros */}
              {hasFilters && (
                <div className="flex items-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setFilterTenantId(undefined);
                      setFilterSku("");
                      setFilterCategory("");
                    }}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Limpar filtros
                  </Button>
                </div>
              )}
            </div>

            {isLoading ? (
              <div className="text-center py-8">Carregando...</div>
            ) : !products || products.length === 0 ? (
              <div className="text-center py-12">
                <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  Nenhum produto cadastrado
                </h3>
                <p className="text-gray-600 mb-4">
                  Comece criando seu primeiro produto
                </p>
                <CreateProductDialog />
              </div>
            ) : (
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedIds.length === products?.length && products.length > 0}
                          onCheckedChange={handleSelectAll}
                        />
                      </TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Descrição</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead>Unidade</TableHead>
                      <TableHead>Qtd. Mínima</TableHead>
                      <TableHead>Armazenagem</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((product: any) => (
                      <TableRow key={product.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.includes(product.id)}
                            onCheckedChange={(checked) => handleSelectOne(product.id, checked as boolean)}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{product.sku}</TableCell>
                        <TableCell className="max-w-xs truncate">{product.description}</TableCell>
                        <TableCell>{product.category || "-"}</TableCell>
                        <TableCell>{product.unitOfMeasure}</TableCell>
                        <TableCell>{product.minQuantity || 0}</TableCell>
                        <TableCell>{getStorageConditionBadge(product.storageCondition)}</TableCell>
                        <TableCell>{getStatusBadge(product.status)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(product)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(product)}
                            >
                              <Trash2 className="h-4 w-4 text-red-600" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Modal de Edição */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Produto</DialogTitle>
            <DialogDescription>
              Atualize as informações do produto {selectedProduct?.sku || selectedProduct?.internalCode}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">

            {/* ── Grupo 1: Identificação e Vínculos ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">1. Identificação e Vínculos</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-internalCode">Cód. Interno (Cliente) *</Label>
                  <Input id="edit-internalCode" value={editForm.internalCode}
                    onChange={(e) => setEditForm({ ...editForm, internalCode: e.target.value })}
                    placeholder="Ex: CLI-441000" />
                </div>
                <div>
                  <Label htmlFor="edit-sku">Cód. Externo (Fornecedor / SKU)</Label>
                  <Input id="edit-sku" value={editForm.sku}
                    onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })}
                    placeholder="Ex: 834207" />
                </div>
                <div>
                  <Label htmlFor="edit-gtin">GTIN / EAN</Label>
                  <Input id="edit-gtin" value={editForm.gtin}
                    onChange={(e) => setEditForm({ ...editForm, gtin: e.target.value })}
                    placeholder="Ex: 7891234567890" maxLength={14} />
                </div>
                <div>
                  <Label htmlFor="edit-manufacturer">Fabricante</Label>
                  <Input id="edit-manufacturer" value={editForm.manufacturer}
                    onChange={(e) => setEditForm({ ...editForm, manufacturer: e.target.value })}
                    placeholder="Ex: EMS Pharma" />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="edit-description">Descrição *</Label>
                  <Textarea id="edit-description" value={editForm.description}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    placeholder="Descrição completa do produto" rows={2} />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="edit-tenantId">Cliente (Tenant)</Label>
                  <Select
                    value={editForm.tenantId ? String(editForm.tenantId) : "none"}
                    onValueChange={(v) => setEditForm({ ...editForm, tenantId: v === "none" ? undefined : Number(v) })}
                  >
                    <SelectTrigger id="edit-tenantId"><SelectValue placeholder="Selecione o cliente dono do item" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Sem cliente específico —</SelectItem>
                      {(tenants ?? []).map((t: any) => (
                        <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Grupo 2: Atributos de Saúde (Regulatórios) ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">2. Atributos de Saúde (Regulatórios)</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-anvisa">Registro ANVISA</Label>
                  <Input id="edit-anvisa" value={editForm.anvisaRegistry}
                    onChange={(e) => setEditForm({ ...editForm, anvisaRegistry: e.target.value })}
                    placeholder="Ex: 1.0000.0000" />
                </div>
                <div>
                  <Label htmlFor="edit-category">Categoria</Label>
                  <Select value={editForm.category || "none"}
                    onValueChange={(v) => setEditForm({ ...editForm, category: v === "none" ? "" : v })}>
                    <SelectTrigger id="edit-category"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Sem categoria —</SelectItem>
                      {["Medicamento","Equipo","Saneante","Inflamável","Outros"].map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label htmlFor="edit-storage">Condição de Armazenagem</Label>
                  <Select value={editForm.storageCondition}
                    onValueChange={(v: any) => setEditForm({ ...editForm, storageCondition: v })}>
                    <SelectTrigger id="edit-storage"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ambient">Ambiente (sem controle de temperatura)</SelectItem>
                      <SelectItem value="climatized_15_30">Climatizada (15°C a 30°C)</SelectItem>
                      <SelectItem value="controlled_8_25">Ambiente Controlada (8°C a 25°C)</SelectItem>
                      <SelectItem value="refrigerated_2_8">Refrigerado (2°C a 8°C)</SelectItem>
                      <SelectItem value="frozen_minus_20">Congelado (-20°C a -10°C)</SelectItem>
                      <SelectItem value="controlled">Controlado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label htmlFor="edit-transport">Categoria Especial / Transporte</Label>
                  <Select value={editForm.specialTransportCategory}
                    onValueChange={(v: any) => setEditForm({ ...editForm, specialTransportCategory: v })}>
                    <SelectTrigger id="edit-transport"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sem categoria especial</SelectItem>
                      <SelectItem value="thermoLabile_2_8">Termolábil (2°C a 8°C)</SelectItem>
                      <SelectItem value="thermoLabile_extended_2_25">Termolábil faixa ampliada (2°C a 25°C)</SelectItem>
                      <SelectItem value="thermoStable_15_30">Termoestável (15°C a 30°C)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label className="font-medium">Controle de Lote</Label>
                    <p className="text-xs text-muted-foreground">Rastrear por número de lote</p>
                  </div>
                  <Switch checked={editForm.requiresBatchControl}
                    onCheckedChange={(v) => setEditForm({ ...editForm, requiresBatchControl: v })} />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label className="font-medium">Controle de Validade</Label>
                    <p className="text-xs text-muted-foreground">Rastrear data de vencimento</p>
                  </div>
                  <Switch checked={editForm.requiresExpiryControl}
                    onCheckedChange={(v) => setEditForm({ ...editForm, requiresExpiryControl: v })} />
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Grupo 3: Dados Logísticos e Cubagem ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">3. Dados Logísticos e Cubagem</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-unit">Unidade de Medida (Base)</Label>
                  <Select value={editForm.unitOfMeasure}
                    onValueChange={(v) => setEditForm({ ...editForm, unitOfMeasure: v })}>
                    <SelectTrigger id="edit-unit"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {levelsLoading ? (
                        <div className="flex items-center justify-center py-2 text-sm text-muted-foreground gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />Carregando...
                        </div>
                      ) : levels.map((level) => (
                        <SelectItem key={level.code} value={level.code}>{level.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="edit-unitsPerBox">Unidades por Caixa (Fator)</Label>
                  <Input id="edit-unitsPerBox" type="number" min="1"
                    value={editForm.unitsPerBox || ""}
                    onChange={(e) => setEditForm({ ...editForm, unitsPerBox: parseInt(e.target.value) || undefined })}
                    placeholder="Ex: 12" />
                </div>
                <div>
                  <Label htmlFor="edit-unitsPerPallet">Unidades por Palete</Label>
                  <Input id="edit-unitsPerPallet" type="number" min="1"
                    value={editForm.unitsPerPallet || ""}
                    onChange={(e) => setEditForm({ ...editForm, unitsPerPallet: parseInt(e.target.value) || undefined })}
                    placeholder="Ex: 120" />
                </div>
                <div>
                  <Label>Dimensões (cm)</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <Input type="number" min="0" step="0.01"
                      value={editForm.lengthCm || ""}
                      onChange={(e) => setEditForm({ ...editForm, lengthCm: parseFloat(e.target.value) || undefined })}
                      placeholder="Comp." />
                    <Input type="number" min="0" step="0.01"
                      value={editForm.widthCm || ""}
                      onChange={(e) => setEditForm({ ...editForm, widthCm: parseFloat(e.target.value) || undefined })}
                      placeholder="Larg." />
                    <Input type="number" min="0" step="0.01"
                      value={editForm.heightCm || ""}
                      onChange={(e) => setEditForm({ ...editForm, heightCm: parseFloat(e.target.value) || undefined })}
                      placeholder="Alt." />
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Grupo 4: Regras Operacionais ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">4. Regras Operacionais</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="edit-minqty">Quantidade Mínima (Estoque de Segurança)</Label>
                  <Input id="edit-minqty" type="number" min="0"
                    value={editForm.minQuantity}
                    onChange={(e) => setEditForm({ ...editForm, minQuantity: parseInt(e.target.value) || 0 })} />
                </div>
                <div>
                  <Label htmlFor="edit-minOrderQty">Pedido Mínimo (Trava de Separação)</Label>
                  <Input id="edit-minOrderQty" type="number" min="0"
                    value={editForm.minOrderQty}
                    onChange={(e) => setEditForm({ ...editForm, minOrderQty: parseInt(e.target.value) || 0 })}
                    placeholder="Ex: 10" />
                </div>
                <div>
                  <Label htmlFor="edit-dispensing">Quantidade de Dispensação (Múltiplos)</Label>
                  <Input id="edit-dispensing" type="number" min="1"
                    value={editForm.dispensingQuantity}
                    onChange={(e) => setEditForm({ ...editForm, dispensingQuantity: parseInt(e.target.value) || 1 })}
                    placeholder="Ex: 1" />
                </div>
                <div>
                  <Label htmlFor="edit-status">Status</Label>
                  <Select value={editForm.status}
                    onValueChange={(v: any) => setEditForm({ ...editForm, status: v })}>
                    <SelectTrigger id="edit-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Ativo</SelectItem>
                      <SelectItem value="inactive">Inativo</SelectItem>
                      <SelectItem value="discontinued">Descontinuado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

          </div>

          <DialogFooter>
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setEditDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleUpdateSubmit} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Salvando..." : "Salvar Alterações"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal de Confirmação de Exclusão */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar Exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o produto "{selectedProduct?.sku}"?
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteMutation.isPending ? "Excluindo..." : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Modal de Confirmação de Exclusão em Massa */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar Exclusão em Massa</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Você está prestes a excluir <strong>{selectedIds.length} produto(s)</strong> permanentemente.
                </p>
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                  <p className="text-sm text-amber-800 font-medium">
                    ⚠️ Atenção: Esta é uma exclusão PERMANENTE (hard delete)
                  </p>
                  <p className="text-sm text-amber-700 mt-1">
                    Os registros serão removidos completamente do banco de dados e não poderão ser recuperados.
                  </p>
                </div>
                <p className="text-sm">
                  A exclusão só será permitida se os produtos não tiverem inventário, pedidos ou movimentações associadas.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteManyMutation.isPending ? "Excluindo..." : `Excluir ${selectedIds.length} Produto(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Modal de Erros de Negócio */}
      {businessError.ErrorModal}

      {/* Dialog de Importação de Produtos */}
      <ImportProductsDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        tenants={(tenants ?? []) as { id: number; name: string }[]}
        defaultTenantId={filterTenantId}
        onSuccess={() => utils.products.list.invalidate()}
      />
    </div>
  );
}
