import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { usePackagingLevels } from "@/hooks/usePackagingLevels";
import { Plus, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const STORAGE_CONDITIONS = [
  { value: "ambient",          label: "Ambiente (sem controle de temperatura)" },
  { value: "climatized_15_30", label: "Climatizada (15°C a 30°C)" },
  { value: "controlled_8_25",  label: "Ambiente Controlada (8°C a 25°C)" },
  { value: "refrigerated_2_8", label: "Refrigerado (2°C a 8°C)" },
  { value: "frozen_minus_20",  label: "Congelado (-20°C a -10°C)" },
  { value: "controlled",       label: "Controlado" },
];

const TRANSPORT_CATEGORIES = [
  { value: "none",                        label: "Sem categoria especial" },
  { value: "thermoLabile_2_8",            label: "Termolábil (2°C a 8°C)" },
  { value: "thermoLabile_extended_2_25",  label: "Termolábil faixa ampliada (2°C a 25°C)" },
  { value: "thermoStable_15_30",          label: "Termoestável (15°C a 30°C)" },
];

const PRODUCT_CATEGORIES = ["Medicamento", "Equipo", "Saneante", "Inflamável", "Outros"];

type StorageCondition = "ambient" | "climatized_15_30" | "controlled_8_25" | "refrigerated_2_8" | "frozen_minus_20" | "controlled";
type TransportCategory = "none" | "thermoLabile_2_8" | "thermoLabile_extended_2_25" | "thermoStable_15_30";
type ProductCategory = "Medicamento" | "Equipo" | "Saneante" | "Inflamável" | "Outros";

const EMPTY_FORM = {
  // Grupo 1: Identificação e Vínculos
  internalCode: "",
  customerCode: "",
  supplierCode: "",
  gtin: "",
  description: "",
  manufacturer: "",
  tenantId: "" as string,
  // Grupo 2: Atributos de Saúde
  anvisaRegistry: "",
  category: "" as ProductCategory | "",
  storageCondition: "ambient" as StorageCondition,
  specialTransportCategory: "none" as TransportCategory,
  requiresBatchControl: true,
  requiresExpiryControl: true,
  // Grupo 3: Dados Logísticos
  unitOfMeasure: "UN",
  unitsPerBox: "",
  unitsPerPallet: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  // Grupo 4: Regras Operacionais
  minQuantity: "0",
  minOrderQty: "0",
  dispensingQuantity: "1",
  status: "active" as "active" | "inactive" | "discontinued",
};

export function CreateProductDialog() {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);

  const { levels, isLoading: levelsLoading } = usePackagingLevels();
  const { data: tenants } = trpc.tenants.list.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.products.create.useMutation({
    onSuccess: () => {
      toast.success("Produto cadastrado com sucesso!");
      utils.products.list.invalidate();
      setOpen(false);
      setFormData(EMPTY_FORM);
    },
    onError: (error) => {
      toast.error("Erro ao cadastrar produto: " + error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.internalCode.trim()) {
      toast.error("Cód. Interno é obrigatório");
      return;
    }

    if (!formData.description.trim()) {
      toast.error("Descrição é obrigatória");
      return;
    }

    createMutation.mutate({
      internalCode: formData.internalCode,
      customerCode: formData.customerCode || undefined,
      supplierCode: formData.supplierCode || undefined,
      gtin: formData.gtin || undefined,
      description: formData.description,
      manufacturer: formData.manufacturer || undefined,
      tenantId: formData.tenantId ? parseInt(formData.tenantId) : undefined,
      anvisaRegistry: formData.anvisaRegistry || undefined,
      category: (formData.category as ProductCategory) || undefined,
      storageCondition: formData.storageCondition,
      specialTransportCategory: formData.specialTransportCategory,
      requiresBatchControl: formData.requiresBatchControl,
      requiresExpiryControl: formData.requiresExpiryControl,
      unitOfMeasure: formData.unitOfMeasure,
      unitsPerBox: formData.unitsPerBox ? parseInt(formData.unitsPerBox) : undefined,
      unitsPerPallet: formData.unitsPerPallet ? parseInt(formData.unitsPerPallet) : undefined,
      lengthCm: formData.lengthCm ? parseFloat(formData.lengthCm) : undefined,
      widthCm: formData.widthCm ? parseFloat(formData.widthCm) : undefined,
      heightCm: formData.heightCm ? parseFloat(formData.heightCm) : undefined,
      minQuantity: parseInt(formData.minQuantity) || 0,
      minOrderQty: parseInt(formData.minOrderQty) || 0,
      dispensingQuantity: parseInt(formData.dispensingQuantity) || 1,
      status: formData.status,
    });
  };

  const set = (field: keyof typeof EMPTY_FORM) => (value: string | boolean) =>
    setFormData((prev) => ({ ...prev, [field]: value }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
          <Plus className="h-4 w-4" />
          Novo Produto
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[680px] max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Cadastrar Novo Produto</DialogTitle>
            <DialogDescription>
              Preencha os dados do produto. O campo <strong>Cód. Externo</strong> pode ser preenchido depois via fluxo DE/PARA na importação de NF-e.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">

            {/* ── Grupo 1: Identificação e Vínculos ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                1. Identificação e Vínculos
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="internalCode">
                    Cód. Interno (Cliente) <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="internalCode"
                    value={formData.internalCode}
                    onChange={(e) => set("internalCode")(e.target.value)}
                    placeholder="Ex: CLI-441000"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="customerCode">Cód. Externo (Fornecedor)</Label>
                  <Input
                    id="customerCode"
                    value={formData.customerCode}
                    onChange={(e) => set("customerCode")(e.target.value)}
                    placeholder="Preenchido via DE/PARA"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="gtin">GTIN / EAN</Label>
                  <Input
                    id="gtin"
                    value={formData.gtin}
                    onChange={(e) => set("gtin")(e.target.value)}
                    placeholder="Ex: 7891234567890"
                    maxLength={14}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="manufacturer">Fabricante</Label>
                  <Input
                    id="manufacturer"
                    value={formData.manufacturer}
                    onChange={(e) => set("manufacturer")(e.target.value)}
                    placeholder="Ex: EMS Pharma"
                  />
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="description">
                    Descrição <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="description"
                    value={formData.description}
                    onChange={(e) => set("description")(e.target.value)}
                    placeholder="Ex: DIPIRONA SÓDICA 500MG COM 10 COMPRIMIDOS"
                    required
                  />
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="tenantId">Cliente (Tenant)</Label>
                  <Select
                    value={formData.tenantId || "none"}
                    onValueChange={(v) => set("tenantId")(v === "none" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o cliente dono do item" />
                    </SelectTrigger>
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
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                2. Atributos de Saúde (Regulatórios)
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="anvisaRegistry">Registro ANVISA</Label>
                  <Input
                    id="anvisaRegistry"
                    value={formData.anvisaRegistry}
                    onChange={(e) => set("anvisaRegistry")(e.target.value)}
                    placeholder="Ex: 1.0000.0000"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="category">Categoria</Label>
                  <Select
                    value={formData.category || "none"}
                    onValueChange={(v) => set("category")(v === "none" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione a categoria" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Sem categoria —</SelectItem>
                      {PRODUCT_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="storageCondition">Condição de Armazenagem</Label>
                  <Select
                    value={formData.storageCondition}
                    onValueChange={(v) => set("storageCondition")(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STORAGE_CONDITIONS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="specialTransportCategory">Categoria Especial / Transporte</Label>
                  <Select
                    value={formData.specialTransportCategory}
                    onValueChange={(v) => set("specialTransportCategory")(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRANSPORT_CATEGORIES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label className="font-medium">Controle de Lote</Label>
                    <p className="text-xs text-muted-foreground">Rastrear por número de lote</p>
                  </div>
                  <Switch
                    checked={formData.requiresBatchControl}
                    onCheckedChange={(v) => set("requiresBatchControl")(v)}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label className="font-medium">Controle de Validade</Label>
                    <p className="text-xs text-muted-foreground">Rastrear data de vencimento</p>
                  </div>
                  <Switch
                    checked={formData.requiresExpiryControl}
                    onCheckedChange={(v) => set("requiresExpiryControl")(v)}
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Grupo 3: Dados Logísticos e Cubagem ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                3. Dados Logísticos e Cubagem
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="unitOfMeasure">Unidade de Medida (Base)</Label>
                  <Select
                    value={formData.unitOfMeasure}
                    onValueChange={(v) => set("unitOfMeasure")(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {levelsLoading ? (
                        <div className="flex items-center justify-center py-2 text-sm text-muted-foreground gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Carregando...
                        </div>
                      ) : (
                        levels.map((level) => (
                          <SelectItem key={level.code} value={level.code}>
                            {level.label}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="unitsPerBox">Unidades por Caixa (Fator)</Label>
                  <Input
                    id="unitsPerBox"
                    type="number"
                    value={formData.unitsPerBox}
                    onChange={(e) => set("unitsPerBox")(e.target.value)}
                    placeholder="Ex: 12"
                    min="1"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="unitsPerPallet">Unidades por Palete</Label>
                  <Input
                    id="unitsPerPallet"
                    type="number"
                    value={formData.unitsPerPallet}
                    onChange={(e) => set("unitsPerPallet")(e.target.value)}
                    placeholder="Ex: 120"
                    min="1"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Dimensões (cm)</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <Input
                      type="number"
                      value={formData.lengthCm}
                      onChange={(e) => set("lengthCm")(e.target.value)}
                      placeholder="Comp."
                      min="0"
                      step="0.01"
                    />
                    <Input
                      type="number"
                      value={formData.widthCm}
                      onChange={(e) => set("widthCm")(e.target.value)}
                      placeholder="Larg."
                      min="0"
                      step="0.01"
                    />
                    <Input
                      type="number"
                      value={formData.heightCm}
                      onChange={(e) => set("heightCm")(e.target.value)}
                      placeholder="Alt."
                      min="0"
                      step="0.01"
                    />
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* ── Grupo 4: Regras Operacionais ── */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                4. Regras Operacionais
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="minQuantity">Quantidade Mínima (Estoque de Segurança)</Label>
                  <Input
                    id="minQuantity"
                    type="number"
                    value={formData.minQuantity}
                    onChange={(e) => set("minQuantity")(e.target.value)}
                    placeholder="Ex: 100"
                    min="0"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="minOrderQty">Pedido Mínimo (Trava de Separação)</Label>
                  <Input
                    id="minOrderQty"
                    type="number"
                    value={formData.minOrderQty}
                    onChange={(e) => set("minOrderQty")(e.target.value)}
                    placeholder="Ex: 10"
                    min="0"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="dispensingQuantity">Quantidade de Dispensação (Múltiplos)</Label>
                  <Input
                    id="dispensingQuantity"
                    type="number"
                    value={formData.dispensingQuantity}
                    onChange={(e) => set("dispensingQuantity")(e.target.value)}
                    placeholder="Ex: 1"
                    min="1"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(v: any) => set("status")(v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
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
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={createMutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Cadastrando...
                </>
              ) : "Cadastrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
