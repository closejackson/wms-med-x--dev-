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
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { Plus, Activity } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function CreateTenantDialog() {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    cnpj: "",
    intraHospitalEnabled: false,
  });

  const utils = trpc.useUtils();
  const createMutation = trpc.tenants.create.useMutation({
    onSuccess: () => {
      toast.success("Cliente cadastrado com sucesso!");
      utils.tenants.list.invalidate();
      setOpen(false);
      setFormData({ name: "", cnpj: "", intraHospitalEnabled: false });
    },
    onError: (error) => {
      toast.error("Erro ao cadastrar cliente: " + error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      toast.error("Nome é obrigatório");
      return;
    }
    
    if (!formData.cnpj.trim()) {
      toast.error("CNPJ é obrigatório");
      return;
    }

    // Validação básica de CNPJ (14 dígitos)
    const cnpjDigits = formData.cnpj.replace(/\D/g, "");
    if (cnpjDigits.length !== 14) {
      toast.error("CNPJ deve conter 14 dígitos");
      return;
    }

    createMutation.mutate({
      name: formData.name,
      cnpj: cnpjDigits,
      intraHospitalEnabled: formData.intraHospitalEnabled,
    });
  };

  const formatCNPJ = (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length <= 14) {
      return digits
        .replace(/(\d{2})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d)/, "$1/$2")
        .replace(/(\d{4})(\d)/, "$1-$2");
    }
    return value;
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
          <Plus className="h-4 w-4" />
          Novo Cliente
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Cadastrar Novo Cliente</DialogTitle>
            <DialogDescription>
              Preencha os dados do cliente para cadastrá-lo no sistema
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">
                Nome / Razão Social <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Ex: Laboratórios B.Braun S/A"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cnpj">
                CNPJ <span className="text-red-500">*</span>
              </Label>
              <Input
                id="cnpj"
                value={formData.cnpj}
                onChange={(e) => setFormData({ ...formData, cnpj: formatCNPJ(e.target.value) })}
                placeholder="00.000.000/0000-00"
                maxLength={18}
                required
              />
              <p className="text-xs text-gray-500">Formato: 00.000.000/0000-00</p>
            </div>

            {/* Módulos habilitados */}
            <div className="border rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium text-gray-700">Módulos</p>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-pink-500" />
                  <div>
                    <p className="text-sm font-medium">Intra-Hospitalar</p>
                    <p className="text-xs text-gray-500">
                      Rastreabilidade pós-expedição em ambiente hospitalar
                    </p>
                  </div>
                </div>
                <Switch
                  id="create-intraHospitalEnabled"
                  checked={formData.intraHospitalEnabled}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, intraHospitalEnabled: checked })
                  }
                />
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
              {createMutation.isPending ? "Cadastrando..." : "Cadastrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
