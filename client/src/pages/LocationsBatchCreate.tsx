/**
 * LocationsBatchCreate.tsx
 *
 * Gerador de Endereços em Lote (Matriz de Localizações).
 * Permite criar múltiplas localizações de estoque via definição de
 * intervalos alfanuméricos para Rua, Prédio, Andar e Quadrante.
 */

import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
  ArrowLeft,
  Grid3X3,
  Eye,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Info,
} from "lucide-react";

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface FormState {
  tenantId: string;
  zoneId: string;
  aisle: string;
  rackStart: string;
  rackEnd: string;
  levelStart: string;
  levelEnd: string;
  positionStart: string;
  positionEnd: string;
  rackSide: "all" | "odd" | "even";
  locationType: "whole" | "fraction";
  storageRule: "single" | "multi";
}

const INITIAL_FORM: FormState = {
  tenantId: "",
  zoneId: "",
  aisle: "",
  rackStart: "1",
  rackEnd: "1",
  levelStart: "1",
  levelEnd: "1",
  positionStart: "",
  positionEnd: "",
  rackSide: "all",
  locationType: "whole",
  storageRule: "single",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(n: number) {
  return String(n).padStart(2, "0");
}

function generateCodes(form: FormState): string[] {
  const rackS = parseInt(form.rackStart) || 1;
  const rackE = parseInt(form.rackEnd) || 1;
  const lvlS = parseInt(form.levelStart) || 1;
  const lvlE = parseInt(form.levelEnd) || 1;
  if (!form.aisle || rackE < rackS || lvlE < lvlS) return [];

  const positions: string[] = [];
  if (form.positionStart && form.positionEnd) {
    const s = form.positionStart.toUpperCase().charCodeAt(0);
    const e = form.positionEnd.toUpperCase().charCodeAt(0);
    if (e >= s) for (let c = s; c <= e; c++) positions.push(String.fromCharCode(c));
  }

  const codes: string[] = [];
  for (let rack = rackS; rack <= rackE; rack++) {
    // Filtrar por lado
    if (form.rackSide === "odd" && rack % 2 === 0) continue;
    if (form.rackSide === "even" && rack % 2 !== 0) continue;
    for (let lvl = lvlS; lvl <= lvlE; lvl++) {
      const base = `${form.aisle}-${pad(rack)}-${pad(lvl)}`;
      if (positions.length > 0) {
        for (const pos of positions) codes.push(`${base}${pos}`);
      } else {
        codes.push(base);
      }
    }
  }
  return codes;
}

// ─── Componente Principal ─────────────────────────────────────────────────────
export default function LocationsBatchCreate() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const isGlobalAdmin = (user as any)?.tenantId === 1;

  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [conflictDialog, setConflictDialog] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });

  // Preencher tenantId automaticamente para não-admins
  useEffect(() => {
    if (!isGlobalAdmin && (user as any)?.tenantId) {
      setForm((f) => ({ ...f, tenantId: String((user as any).tenantId) }));
    }
  }, [isGlobalAdmin, user]);

  // ── Queries ────────────────────────────────────────────────────────────────
  const tenantsQuery = trpc.tenants.list.useQuery(undefined, { enabled: isGlobalAdmin });
  const zonesQuery = trpc.zones?.list?.useQuery(undefined, { enabled: false }) as any;

  // Preview local (calculado no cliente)
  const previewCodes = useMemo(() => generateCodes(form), [form]);
  const previewExceeds = previewCodes.length > 500;

  // ── Mutation ───────────────────────────────────────────────────────────────
  const batchCreate = trpc.locations.batchCreate.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Sucesso! ${data.created} endereço(s) gerado(s) na Rua ${form.aisle}.${
          data.skipped > 0 ? ` (${data.skipped} já existiam e foram pulados)` : ""
        }`
      );
      navigate("/locations");
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT") {
        setConflictDialog({ open: true, message: err.message });
      } else {
        toast.error(err.message || "Erro ao criar endereços");
      }
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  function set(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate(): string | null {
    if (!form.tenantId) return "Selecione o cliente";
    if (!form.zoneId) return "Selecione a zona";
    if (!form.aisle.trim()) return "Informe a Rua/Corredor";
    const rS = parseInt(form.rackStart);
    const rE = parseInt(form.rackEnd);
    const lS = parseInt(form.levelStart);
    const lE = parseInt(form.levelEnd);
    if (isNaN(rS) || rS < 1) return "Prédio inicial inválido";
    if (isNaN(rE) || rE < rS) return "Prédio final deve ser ≥ Prédio inicial";
    if (isNaN(lS) || lS < 1) return "Andar inicial inválido";
    if (isNaN(lE) || lE < lS) return "Andar final deve ser ≥ Andar inicial";
    if (form.positionStart && form.positionEnd) {
      const s = form.positionStart.toUpperCase().charCodeAt(0);
      const e = form.positionEnd.toUpperCase().charCodeAt(0);
      if (e < s) return "Quadrante final deve ser ≥ Quadrante inicial";
    }
    if (previewExceeds) return `Limite de 500 endereços por vez (matriz geraria ${previewCodes.length})`;
    if (previewCodes.length === 0) return "Nenhum endereço seria gerado com esses parâmetros";
    return null;
  }

  function handleSubmit(skipExisting = false) {
    const err = validate();
    if (err) { toast.error(err); return; }
    batchCreate.mutate({
      tenantId: parseInt(form.tenantId),
      zoneId: parseInt(form.zoneId),
      aisle: form.aisle.trim(),
      rackStart: parseInt(form.rackStart),
      rackEnd: parseInt(form.rackEnd),
      levelStart: parseInt(form.levelStart),
      levelEnd: parseInt(form.levelEnd),
      positionStart: form.positionStart || undefined,
      positionEnd: form.positionEnd || undefined,
      rackSide: form.rackSide,
      locationType: form.locationType,
      storageRule: form.storageRule,
      skipExisting,
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/locations")}
          className="h-9 w-9"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Grid3X3 className="h-6 w-6 text-primary" />
            Gerador de Endereços em Lote
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Crie múltiplos endereços simultaneamente definindo intervalos de Prédio, Andar e Quadrante.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Formulário ─────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Configuração da Matriz</CardTitle>
              <CardDescription>
                Defina os intervalos para gerar os endereços automaticamente.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Cliente (Global Admin apenas) */}
              {isGlobalAdmin && (
                <div className="space-y-1.5">
                  <Label>
                    Cliente <span className="text-destructive">*</span>
                  </Label>
                  <Select value={form.tenantId} onValueChange={(v) => set("tenantId", v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o cliente..." />
                    </SelectTrigger>
                    <SelectContent>
                      {tenantsQuery.data?.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.tradeName ?? t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Zona */}
              <ZoneSelector
                tenantId={form.tenantId ? parseInt(form.tenantId) : undefined}
                value={form.zoneId}
                onChange={(v) => set("zoneId", v)}
              />

              {/* Rua/Corredor */}
              <div className="space-y-1.5">
                <Label>
                  Rua / Corredor <span className="text-destructive">*</span>
                </Label>
                <Input
                  placeholder="Ex: M01, A01, RUA-B"
                  value={form.aisle}
                  onChange={(e) => set("aisle", e.target.value.toUpperCase())}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Prefixo usado em todos os endereços gerados.
                </p>
              </div>

              {/* Prédio */}
              <div className="space-y-1.5">
                <Label>Prédio (intervalo)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Inicial</p>
                    <Input
                      type="number"
                      min={1}
                      value={form.rackStart}
                      onChange={(e) => set("rackStart", e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Final</p>
                    <Input
                      type="number"
                      min={1}
                      value={form.rackEnd}
                      onChange={(e) => set("rackEnd", e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Lado do Prédio */}
              <div className="space-y-1.5">
                <Label>Lado</Label>
                <Select
                  value={form.rackSide}
                  onValueChange={(v) => set("rackSide", v as "all" | "odd" | "even")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Ambos (par e ímpar)</SelectItem>
                    <SelectItem value="odd">Ímpar (1, 3, 5...)</SelectItem>
                    <SelectItem value="even">Par (2, 4, 6...)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Gera apenas prédios ímpares, pares ou ambos dentro do intervalo.
                </p>
              </div>

              {/* Andar */}
              <div className="space-y-1.5">
                <Label>Andar / Nível (intervalo)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Inicial</p>
                    <Input
                      type="number"
                      min={1}
                      value={form.levelStart}
                      onChange={(e) => set("levelStart", e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Final</p>
                    <Input
                      type="number"
                      min={1}
                      value={form.levelEnd}
                      onChange={(e) => set("levelEnd", e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Quadrante (opcional) */}
              <div className="space-y-1.5">
                <Label>
                  Quadrante{" "}
                  <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Inicial (letra)</p>
                    <Input
                      placeholder="Ex: A"
                      maxLength={1}
                      value={form.positionStart}
                      onChange={(e) => set("positionStart", e.target.value.toUpperCase())}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Final (letra)</p>
                    <Input
                      placeholder="Ex: D"
                      maxLength={1}
                      value={form.positionEnd}
                      onChange={(e) => set("positionEnd", e.target.value.toUpperCase())}
                      className="font-mono"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Deixe em branco se não houver subdivisão por quadrante.
                </p>
              </div>

              {/* Tipo e Regra */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Tipo de Endereço</Label>
                  <Select
                    value={form.locationType}
                    onValueChange={(v) => set("locationType", v as "whole" | "fraction")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="whole">Inteira</SelectItem>
                      <SelectItem value="fraction">Fração</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Regra de Armazenagem</Label>
                  <Select
                    value={form.storageRule}
                    onValueChange={(v) => set("storageRule", v as "single" | "multi")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">Único Item/Lote</SelectItem>
                      <SelectItem value="multi">Multi-Item</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Botões de ação */}
          <div className="flex gap-3 justify-end">
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => navigate("/locations")}>
              Cancelar
            </Button>
            <Button
              onClick={() => handleSubmit(false)}
              disabled={batchCreate.isPending || previewCodes.length === 0 || previewExceeds}
              className="min-w-[160px]"
            >
              {batchCreate.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Criando...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Criar {previewCodes.length > 0 ? `${previewCodes.length} ` : ""}Endereços
                </>
              )}
            </Button>
          </div>
        </div>

        {/* ── Preview ────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="sticky top-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Preview
              </CardTitle>
            </CardHeader>
            <CardContent>
              {previewCodes.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Grid3X3 className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">
                    Preencha os campos para visualizar os endereços que serão gerados.
                  </p>
                </div>
              ) : previewExceeds ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Limite excedido</AlertTitle>
                  <AlertDescription>
                    Sua matriz geraria <strong>{previewCodes.length}</strong> endereços.
                    O limite é de 500 por vez. Reduza os intervalos.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-muted-foreground">
                      Serão criados
                    </span>
                    <Badge variant="secondary" className="text-base font-bold px-3">
                      {previewCodes.length}
                    </Badge>
                  </div>

                  {/* Exemplo de formato */}
                  <Alert className="mb-3">
                    <Info className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      Formato: <code className="font-mono bg-muted px-1 rounded">
                        {previewCodes[0]}
                      </code>
                    </AlertDescription>
                  </Alert>

                  {/* Lista de preview (máx 20) */}
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {previewCodes.slice(0, 20).map((code) => (
                      <div
                        key={code}
                        className="font-mono text-xs bg-muted/50 rounded px-2 py-1 text-foreground"
                      >
                        {code}
                      </div>
                    ))}
                    {previewCodes.length > 20 && (
                      <p className="text-xs text-muted-foreground text-center pt-1">
                        ... e mais {previewCodes.length - 20} endereços
                      </p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Dica de formatação */}
          <Card className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">
                Formatação automática
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400">
                Números são preenchidos com zeros à esquerda:{" "}
                <code className="font-mono bg-blue-100 dark:bg-blue-900 px-1 rounded">
                  M01-01-01
                </code>{" "}
                em vez de{" "}
                <code className="font-mono bg-blue-100 dark:bg-blue-900 px-1 rounded">
                  M01-1-1
                </code>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Dialog de conflito ─────────────────────────────────────────────── */}
      <Dialog
        open={conflictDialog.open}
        onOpenChange={(o) => setConflictDialog((s) => ({ ...s, open: o }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Endereços já existentes
            </DialogTitle>
            <DialogDescription className="pt-2">
              {conflictDialog.message}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setConflictDialog((s) => ({ ...s, open: false }))}
            >
              Abortar operação
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setConflictDialog((s) => ({ ...s, open: false }));
                handleSubmit(true);
              }}
              disabled={batchCreate.isPending}
            >
              {batchCreate.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Pular existentes e continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-componente: ZoneSelector ─────────────────────────────────────────────
function ZoneSelector({
  value,
  onChange,
}: {
  tenantId?: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const zonesQuery = trpc.zones.list.useQuery();

  return (
    <div className="space-y-1.5">
      <Label>
        Zona <span className="text-destructive">*</span>
      </Label>
      <Select value={value} onValueChange={onChange} disabled={zonesQuery.isLoading}>
        <SelectTrigger>
          <SelectValue placeholder={zonesQuery.isLoading ? "Carregando zonas..." : "Selecione a zona..."} />
        </SelectTrigger>
        <SelectContent>
          {zonesQuery.data?.map((z: any) => (
            <SelectItem key={z.id} value={String(z.id)}>
              <span className="font-mono font-medium">{z.code}</span>
              {z.name && z.name !== z.code && (
                <span className="text-muted-foreground ml-2 text-xs">— {z.name}</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
