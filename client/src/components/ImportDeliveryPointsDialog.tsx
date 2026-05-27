import { useCallback, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, FileSpreadsheet, Download, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PointType = "DOCK" | "PHARMACY";

interface ParsedRow {
  type: PointType;
  name: string;
  externalCode: string;
  floor?: string;
  description?: string;
  _rowNum: number;
  _valid: boolean;
  _error?: string;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; code: string; message: string }[];
}

// ─── Column mapping ───────────────────────────────────────────────────────────

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/\*/g, "").trim();

const COL_TYPE: Record<string, true> = {
  "tipo": true, "type": true,
};
const COL_NAME: Record<string, true> = {
  "nome": true, "name": true,
};
const COL_CODE: Record<string, true> = {
  "código externo (qr)": true, "codigo externo (qr)": true,
  "código externo": true, "codigo externo": true,
  "código (qr)": true, "codigo (qr)": true,
  "external code": true, "externalcode": true,
  "código qr": true, "codigo qr": true,
  "qr code": true, "qr": true,
};
const COL_FLOOR: Record<string, true> = {
  "andar / bloco": true, "andar/bloco": true, "andar": true,
  "bloco": true, "floor": true, "localização": true, "localizacao": true,
};
const COL_DESC: Record<string, true> = {
  "descrição": true, "descricao": true, "description": true, "obs": true, "observação": true,
};

function parseRows(ws: XLSX.WorkSheet): ParsedRow[] {
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  return raw.map((row, idx) => {
    // Map header keys
    let type = "";
    let name = "";
    let externalCode = "";
    let floor = "";
    let description = "";

    for (const [key, val] of Object.entries(row)) {
      const k = normalize(key);
      const v = String(val ?? "").trim();
      if (COL_TYPE[k]) type = v.toUpperCase();
      else if (COL_NAME[k]) name = v;
      else if (COL_CODE[k]) externalCode = v.toUpperCase().replace(/\s+/g, "-");
      else if (COL_FLOOR[k]) floor = v;
      else if (COL_DESC[k]) description = v;
    }

    // Skip blank rows
    if (!type && !name && !externalCode) return null;

    // Validate
    let _valid = true;
    let _error: string | undefined;
    if (type !== "DOCK" && type !== "PHARMACY") {
      _valid = false;
      _error = `Tipo inválido: "${type}". Use DOCK ou PHARMACY.`;
    } else if (!name) {
      _valid = false;
      _error = "Nome é obrigatório.";
    } else if (!externalCode) {
      _valid = false;
      _error = "Código Externo é obrigatório.";
    }

    return {
      type: (type || "DOCK") as PointType,
      name,
      externalCode,
      floor: floor || undefined,
      description: description || undefined,
      _rowNum: idx + 2,
      _valid,
      _error,
    } satisfies ParsedRow;
  }).filter(Boolean) as ParsedRow[];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenants?: { id: number; name: string }[];
  defaultTenantId?: number;
  isGlobalAdmin?: boolean;
  onSuccess?: () => void;
}

export function ImportDeliveryPointsDialog({
  open,
  onOpenChange,
  tenants,
  defaultTenantId,
  isGlobalAdmin,
  onSuccess,
}: Props) {
  const [tenantId, setTenantId] = useState<number | undefined>(defaultTenantId);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const importMut = trpc.intraHospital.importDeliveryPoints.useMutation({
    onSuccess: (data) => {
      setImportResult(data);
      setStep("result");
      if (data.errors.length === 0) {
        toast.success(`Importação concluída: ${data.created} criados.`);
      } else {
        toast.warning(`Importação com avisos: ${data.created} criados, ${data.skipped} ignorados.`);
      }
      onSuccess?.();
    },
    onError: (err) => toast.error("Erro na importação: " + err.message),
  });

  const handleFile = useCallback((file: File) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = parseRows(ws);
        if (rows.length === 0) {
          toast.error("Nenhuma linha válida encontrada na planilha.");
          return;
        }
        setParsedRows(rows);
        setStep("preview");
      } catch {
        toast.error("Erro ao ler o arquivo. Verifique se é um .xls ou .xlsx válido.");
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleImport = () => {
    if (isGlobalAdmin && !tenantId) {
      toast.error("Selecione o cliente antes de importar.");
      return;
    }
    const validRows = parsedRows.filter(r => r._valid);
    if (validRows.length === 0) {
      toast.error("Nenhuma linha válida para importar.");
      return;
    }
    importMut.mutate({
      tenantId,
      rows: validRows.map(r => ({
        type: r.type,
        name: r.name,
        externalCode: r.externalCode,
        floor: r.floor,
        description: r.description,
      })),
    });
  };

  const handleReset = () => {
    setParsedRows([]);
    setFileName("");
    setStep("upload");
    setImportResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => {
    handleReset();
    onOpenChange(false);
  };

  const validCount = parsedRows.filter(r => r._valid).length;
  const invalidCount = parsedRows.filter(r => !r._valid).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-blue-600" />
            Importar Pontos de Entrega via Excel
          </DialogTitle>
          <DialogDescription>
            Faça upload de uma planilha .xlsx com docas e farmácias. Códigos já existentes serão ignorados.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2">

          {/* Seleção de cliente (Global Admin) */}
          {isGlobalAdmin && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium whitespace-nowrap">Cliente *</span>
              <select
                value={tenantId ?? ""}
                onChange={e => setTenantId(e.target.value ? Number(e.target.value) : undefined)}
                className="flex-1 h-9 rounded-md border border-slate-200 px-3 text-sm bg-white"
              >
                <option value="">Selecione o cliente...</option>
                {tenants?.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Download template */}
          <div className="flex items-center justify-between bg-blue-50 rounded-lg p-3 border border-blue-100">
            <div className="flex items-center gap-2 text-sm text-blue-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Baixe o template para preencher os dados dos pontos de entrega
            </div>
            <a href="/template-pontos-entrega.xlsx" download>
              <Button variant="outline" size="sm" className="gap-2 border-blue-200 text-blue-700 hover:bg-blue-100 bg-white">
                <Download className="h-4 w-4" /> Baixar Template
              </Button>
            </a>
          </div>

          {/* ── STEP: UPLOAD ── */}
          {step === "upload" && (
            <div
              className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer ${
                dragOver ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-blue-300"
              }`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-10 w-10 mx-auto mb-3 text-slate-300" />
              <p className="text-sm font-medium text-slate-600">Arraste e solte o arquivo aqui</p>
              <p className="text-xs text-slate-400 mt-1">ou clique para selecionar (.xls, .xlsx)</p>
              <input
                ref={fileRef}
                type="file"
                accept=".xls,.xlsx"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </div>
          )}

          {/* ── STEP: PREVIEW ── */}
          {step === "preview" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <FileSpreadsheet className="h-4 w-4 text-green-600" />
                  <span className="font-medium">{fileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className="bg-green-100 text-green-700">{validCount} válidas</Badge>
                  {invalidCount > 0 && <Badge className="bg-red-100 text-red-700">{invalidCount} com erro</Badge>}
                  <Button variant="ghost" size="sm" onClick={handleReset}>Trocar arquivo</Button>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 overflow-auto max-h-64">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Código QR</TableHead>
                      <TableHead>Andar</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedRows.map((row, i) => (
                      <TableRow key={i} className={!row._valid ? "bg-red-50" : ""}>
                        <TableCell className="text-xs text-slate-400">{row._rowNum}</TableCell>
                        <TableCell>
                          <Badge className={row.type === "DOCK" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}>
                            {row.type === "DOCK" ? "Doca" : "Farmácia"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{row.name}</TableCell>
                        <TableCell className="font-mono text-xs">{row.externalCode}</TableCell>
                        <TableCell className="text-xs text-slate-500">{row.floor ?? "—"}</TableCell>
                        <TableCell>
                          {row._valid
                            ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                            : <XCircle className="h-4 w-4 text-red-500" />
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {invalidCount > 0 && (
                <div className="text-xs text-red-600 bg-red-50 rounded-lg p-3 border border-red-100 space-y-1">
                  {parsedRows.filter(r => !r._valid).map((r, i) => (
                    <p key={i}>Linha {r._rowNum}: {r._error}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── STEP: RESULT ── */}
          {step === "result" && importResult && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-green-50 rounded-lg p-3 text-center border border-green-100">
                  <p className="text-2xl font-bold text-green-700">{importResult.created}</p>
                  <p className="text-xs text-green-600 mt-1">Criados</p>
                </div>
                <div className="bg-yellow-50 rounded-lg p-3 text-center border border-yellow-100">
                  <p className="text-2xl font-bold text-yellow-700">{importResult.skipped}</p>
                  <p className="text-xs text-yellow-600 mt-1">Ignorados (duplicados)</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center border border-red-100">
                  <p className="text-2xl font-bold text-red-700">{importResult.errors.length}</p>
                  <p className="text-xs text-red-600 mt-1">Erros</p>
                </div>
              </div>
              {importResult.errors.length > 0 && (
                <div className="rounded-lg border border-red-200 overflow-hidden">
                  <div className="bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 border-b border-red-200">
                    Avisos / Erros
                  </div>
                  <div className="divide-y divide-red-100 max-h-40 overflow-y-auto">
                    {importResult.errors.map((e, i) => (
                      <div key={i} className="px-3 py-2 flex items-start gap-2 text-xs">
                        <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                        <span className="text-slate-600">
                          <span className="font-mono text-red-600">{e.code}</span> (linha {e.row}): {e.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="pt-2 border-t border-slate-100">
          {step === "upload" && (
            <Button variant="outline" onClick={handleClose}>Fechar</Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={handleReset}>Voltar</Button>
              <Button
                onClick={handleImport}
                disabled={importMut.isPending || validCount === 0}
                className="gap-2"
              >
                {importMut.isPending ? "Importando..." : `Importar ${validCount} ponto${validCount !== 1 ? "s" : ""}`}
              </Button>
            </>
          )}
          {step === "result" && (
            <>
              <Button variant="outline" onClick={handleReset}>Importar outro arquivo</Button>
              <Button onClick={handleClose}>Fechar</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
