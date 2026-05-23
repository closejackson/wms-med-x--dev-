import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, CheckCircle2, Package, AlertTriangle, XCircle, PlusCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface SummaryItem {
  productId: number;
  productSku: string;
  productDescription: string;
  batch: string | null;
  expectedQuantity: number | null;
  receivedQuantity: number | null;
  blockedQuantity: number | null;
  addressedQuantity: number;
}

interface ConfirmFinishModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  summary: SummaryItem[];
  receivingOrderCode: string;
  isLoading?: boolean;
}

export function ConfirmFinishModal({
  open,
  onClose,
  onConfirm,
  summary,
  receivingOrderCode,
  isLoading = false
}: ConfirmFinishModalProps) {
  const items = summary || [];

  // Classificar itens em 3 grupos
  const okItems = items.filter(i => {
    const exp = i.expectedQuantity || 0;
    const rec = i.receivedQuantity || 0;
    return exp > 0 && rec > 0 && rec === exp;
  });
  const divergentItems = items.filter(i => {
    const exp = i.expectedQuantity || 0;
    const rec = i.receivedQuantity || 0;
    return exp > 0 && rec !== exp;
  });
  const extraItems = items.filter(i => {
    const exp = i.expectedQuantity || 0;
    const rec = i.receivedQuantity || 0;
    return exp === 0 && rec > 0;
  });

  const totalExpected = items.reduce((s, i) => s + (i.expectedQuantity || 0), 0);
  const totalReceived = items.reduce((s, i) => s + (i.receivedQuantity || 0), 0);
  const totalBlocked = items.reduce((s, i) => s + (i.blockedQuantity || 0), 0);
  const totalAddressed = items.reduce((s, i) => s + i.addressedQuantity, 0);

  const hasIssues = divergentItems.length > 0 || extraItems.length > 0;

  const ItemRow = ({ item, variant }: { item: SummaryItem; variant: "ok" | "divergent" | "extra" }) => {
    const exp = item.expectedQuantity || 0;
    const rec = item.receivedQuantity || 0;
    const rowClass =
      variant === "ok" ? "" :
      variant === "divergent" ? "bg-red-50/60" :
      "bg-amber-50/60";

    return (
      <TableRow className={rowClass}>
        <TableCell className="font-mono text-xs">{item.productSku}</TableCell>
        <TableCell className="max-w-[200px]">
          <div className="truncate text-sm">{item.productDescription}</div>
        </TableCell>
        <TableCell className="font-mono text-xs">{item.batch || <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-right tabular-nums">{exp > 0 ? exp : <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className={`text-right tabular-nums font-medium ${
          variant === "ok" ? "text-green-700" :
          variant === "divergent" ? "text-red-700" :
          "text-amber-700"
        }`}>{rec}</TableCell>
        <TableCell className={`text-right tabular-nums ${(item.blockedQuantity || 0) > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
          {item.blockedQuantity || 0}
        </TableCell>
        <TableCell className="text-right tabular-nums font-bold text-green-700">
          {item.addressedQuantity}
        </TableCell>
      </TableRow>
    );
  };

  const SectionHeader = ({ label, count, color }: { label: string; count: number; color: string }) => (
    <TableRow className={`${color} border-b`}>
      <TableCell colSpan={7} className="py-1.5 px-3">
        <span className="text-xs font-semibold uppercase tracking-wide">{label} ({count})</span>
      </TableCell>
    </TableRow>
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Confirmar Finalização — {receivingOrderCode}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Resumo em cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="rounded-lg border bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Esperado</div>
              <div className="text-2xl font-bold">{totalExpected}</div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Recebido</div>
              <div className={`text-2xl font-bold ${totalReceived === totalExpected ? "text-green-700" : "text-red-600"}`}>
                {totalReceived}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Bloqueado</div>
              <div className={`text-2xl font-bold ${totalBlocked > 0 ? "text-red-600" : "text-muted-foreground"}`}>
                {totalBlocked}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Endereçável</div>
              <div className="text-2xl font-bold text-green-700">{totalAddressed}</div>
            </div>
          </div>

          {/* Alertas contextuais */}
          {divergentItems.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                <strong>{divergentItems.length} item(ns) com divergência</strong> — quantidade recebida difere da esperada na NF-e.
              </span>
            </div>
          )}
          {extraItems.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <PlusCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                <strong>{extraItems.length} lote(s) extra(s)</strong> — bipados mas não constam na NF-e. Serão registrados como recebimento adicional.
              </span>
            </div>
          )}


          {/* Tabela agrupada */}
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/60">
                  <TableHead className="text-xs">SKU</TableHead>
                  <TableHead className="text-xs">Produto</TableHead>
                  <TableHead className="text-xs">Lote</TableHead>
                  <TableHead className="text-xs text-right">Esperado</TableHead>
                  <TableHead className="text-xs text-right">Recebido</TableHead>
                  <TableHead className="text-xs text-right">Bloqueado</TableHead>
                  <TableHead className="text-xs text-right">Endereçável</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Grupo 1: Conferidos corretamente */}
                {okItems.length > 0 && (
                  <>
                    <SectionHeader label="Conferidos" count={okItems.length} color="bg-green-50 text-green-800" />
                    {okItems.map((item, i) => <ItemRow key={`ok-${i}`} item={item} variant="ok" />)}
                  </>
                )}

                {/* Grupo 2: Divergentes (esperado > 0, recebido ≠ esperado) */}
                {divergentItems.length > 0 && (
                  <>
                    <SectionHeader label="Divergentes" count={divergentItems.length} color="bg-red-100 text-red-800" />
                    {divergentItems.map((item, i) => <ItemRow key={`div-${i}`} item={item} variant="divergent" />)}
                  </>
                )}

                {/* Grupo 3: Lotes extras (esperado = 0, recebido > 0) */}
                {extraItems.length > 0 && (
                  <>
                    <SectionHeader label="Lotes extras (não constam na NF-e)" count={extraItems.length} color="bg-amber-100 text-amber-800" />
                    {extraItems.map((item, i) => <ItemRow key={`ext-${i}`} item={item} variant="extra" />)}
                  </>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Legenda */}
          <div className="text-xs text-muted-foreground px-1">
            <strong>Endereçável</strong> = Recebido − Bloqueado. Ao confirmar, o sistema criará registros de estoque com essas quantidades.
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={onClose} disabled={isLoading}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={isLoading} className="gap-2">
            {isLoading ? "Finalizando..." : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Confirmar e Finalizar
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
