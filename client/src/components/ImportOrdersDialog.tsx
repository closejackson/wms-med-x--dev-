import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Upload, Download, CheckCircle2, XCircle, AlertCircle, Zap } from "lucide-react";
import { toast } from "sonner";

interface ImportOrdersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Mode = "normal" | "legacy";

export function ImportOrdersDialog({ open, onOpenChange }: ImportOrdersDialogProps) {
  const [mode, setMode] = useState<Mode>("normal");
  const [file, setFile] = useState<File | null>(null);
  const [results, setResults] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const importMutation = trpc.picking.importOrders.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setIsProcessing(false);
      if (data.success.length > 0) toast.success(`${data.success.length} pedido(s) importado(s) com sucesso!`);
      if (data.errors.length > 0) toast.error(`${data.errors.length} erro(s) encontrado(s)`);
    },
    onError: (error) => { setIsProcessing(false); toast.error(error.message || "Erro ao importar pedidos"); },
  });

  const importLegacyMutation = trpc.picking.importLegacy.useMutation({
    onSuccess: (data) => {
      setResults(data);
      setIsProcessing(false);
      if (data.success.length > 0) toast.success(`${data.success.length} pedido(s) de migração importado(s)!`);
      if (data.errors.length > 0) toast.error(`${data.errors.length} divergência(s) encontrada(s)`);
    },
    onError: (error) => { setIsProcessing(false); toast.error(error.message || "Erro ao importar pedidos de migração"); },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.xlsx') && !selectedFile.name.endsWith('.xls')) {
        toast.error("Por favor, selecione um arquivo Excel (.xlsx ou .xls)");
        return;
      }
      setFile(selectedFile);
      setResults(null);
    }
  };

  const handleImport = async () => {
    if (!file) { toast.error("Selecione um arquivo para importar"); return; }
    setIsProcessing(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        const base64Data = base64.split(',')[1];
        if (mode === "legacy") {
          await importLegacyMutation.mutateAsync({ fileData: base64Data });
        } else {
          await importMutation.mutateAsync({ fileData: base64Data });
        }
      };
      reader.readAsDataURL(file);
    } catch {
      setIsProcessing(false);
      toast.error("Erro ao ler arquivo");
    }
  };

  const handleDownloadTemplate = () => {
    if (mode === "legacy") {
      // Gerar template de migração via XLSX no browser
      import("xlsx").then((xlsx) => {
        const ws = xlsx.utils.aoa_to_sheet([
          ["Nº do Pedido", "Cliente", "Destinatário", "Cód. do Produto", "Quantidade", "Unidade de Medida", "Endereço", "Lote"],
          ["PED-001", "AESC - Mãe de Deus", "Farmácia Central", "59188", "10", "Unidade", "M03-01-39", "0633930225"],
          ["PED-001", "AESC - Mãe de Deus", "Farmácia Central", "12345", "2", "Caixa", "A01-01-01", "LOTE2024"],
        ]);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Pedidos Migração");
        xlsx.writeFile(wb, "template-importacao-migracao.xlsx");
        toast.success("Template de migração baixado!");
      }).catch(() => toast.error("Erro ao gerar template"));
    } else {
      const link = document.createElement('a');
      link.href = '/templates/template-importacao-pedidos.xlsx';
      link.download = 'template-importacao-pedidos.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success("Template baixado com sucesso!");
    }
  };

  const handleClose = () => {
    setFile(null);
    setResults(null);
    setIsProcessing(false);
    onOpenChange(false);
  };

  const isLegacy = mode === "legacy";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar Pedidos via Excel</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Seletor de modo */}
          <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
            <button
              onClick={() => { setMode("normal"); setFile(null); setResults(null); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                !isLegacy ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Upload className="h-4 w-4" />
              Importação Normal
            </button>
            <button
              onClick={() => { setMode("legacy"); setFile(null); setResults(null); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                isLegacy ? "bg-white shadow text-amber-700" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Zap className="h-4 w-4" />
              Modo Migração
            </button>
          </div>

          {/* Aviso do modo */}
          <div className={`border rounded-lg p-4 ${isLegacy ? "bg-amber-50 border-amber-200" : "bg-blue-50 border-blue-200"}`}>
            <div className="flex items-start gap-3">
              <AlertCircle className={`h-5 w-5 mt-0.5 flex-shrink-0 ${isLegacy ? "text-amber-600" : "text-blue-600"}`} />
              <div className="flex-1">
                {isLegacy ? (
                  <>
                    <p className="text-sm text-amber-900 font-medium mb-1">
                      Modo Migração — Alocação Forçada (Bypass FEFO/FIFO)
                    </p>
                    <p className="text-xs text-amber-700 mb-2">
                      Os campos <strong>Endereço</strong> e <strong>Lote</strong> determinam exatamente onde o estoque será reservado,
                      ignorando as regras automáticas. Use apenas para migração do sistema legado.
                      Colunas obrigatórias: <em>Nº do Pedido, Cliente, Destinatário, Cód. do Produto, Quantidade, Unidade de Medida, Endereço</em>.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-blue-900 font-medium mb-2">
                    Baixe o template para preencher os dados dos pedidos
                  </p>
                )}
                <Button type="button" variant="outline" size="sm" onClick={handleDownloadTemplate} className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white gap-2">
                  <Download className="h-4 w-4" />
                  {isLegacy ? "Baixar Template de Migração" : "Baixar Template Excel"}
                </Button>
              </div>
            </div>
          </div>

          {/* Upload de arquivo */}
          {!results && (
            <div className="space-y-4">
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                <Upload className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-sm text-gray-600 mb-4">
                  {file ? file.name : "Selecione o arquivo Excel com os pedidos"}
                </p>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                  className="hidden"
                  id="file-upload"
                />
                <label htmlFor="file-upload">
                  <Button type="button" variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" asChild>
                    <span>Selecionar Arquivo</span>
                  </Button>
                </label>
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={handleClose}>Cancelar</Button>
                <Button
                  type="button"
                  onClick={handleImport}
                  disabled={!file || isProcessing}
                  className={isLegacy ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
                >
                  {isProcessing ? "Processando..." : isLegacy ? "Importar (Modo Migração)" : "Importar Pedidos"}
                </Button>
              </div>
            </div>
          )}

          {/* Resultados */}
          {results && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <span className="font-semibold text-green-900">Sucesso</span>
                  </div>
                  <p className="text-2xl font-bold text-green-700">{results.success.length}</p>
                  <p className="text-sm text-green-600">pedidos importados</p>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <XCircle className="h-5 w-5 text-red-600" />
                    <span className="font-semibold text-red-900">{isLegacy ? "Divergências" : "Erros"}</span>
                  </div>
                  <p className="text-2xl font-bold text-red-700">{results.errors.length}</p>
                  <p className="text-sm text-red-600">{isLegacy ? "divergências de migração" : "erros encontrados"}</p>
                </div>
              </div>

              {results.success.length > 0 && (
                <div>
                  <h3 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5" />
                    Pedidos Importados
                  </h3>
                  <div className="border border-green-200 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-green-50">
                        <tr>
                          <th className="px-4 py-2 text-left">Nº Pedido</th>
                          <th className="px-4 py-2 text-left">Nº Sistema</th>
                          <th className="px-4 py-2 text-left">Cliente</th>
                          <th className="px-4 py-2 text-left">Destinatário</th>
                          <th className="px-4 py-2 text-right">Itens</th>
                          {isLegacy && <th className="px-4 py-2 text-left">Modo</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {results.success.map((item: any, idx: number) => (
                          <tr key={idx} className="border-t border-green-100">
                            <td className="px-4 py-2">{item.pedido}</td>
                            <td className="px-4 py-2 font-mono text-xs">{item.numeroSistema}</td>
                            <td className="px-4 py-2">{item.cliente}</td>
                            <td className="px-4 py-2">{item.destinatario}</td>
                            <td className="px-4 py-2 text-right">{item.itens}</td>
                            {isLegacy && (
                              <td className="px-4 py-2">
                                <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                                  <Zap className="h-3 w-3" />
                                  {item.modo ?? "Migração"}
                                </span>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {results.errors.length > 0 && (
                <div>
                  <h3 className="font-semibold text-red-900 mb-2 flex items-center gap-2">
                    <XCircle className="h-5 w-5" />
                    {isLegacy ? "Divergências de Migração" : "Erros Encontrados"}
                  </h3>
                  <div className="border border-red-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-red-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-2 text-left">Pedido/Linha</th>
                          <th className="px-4 py-2 text-left">Erro</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.errors.map((error: any, idx: number) => (
                          <tr key={idx} className="border-t border-red-100">
                            <td className="px-4 py-2">
                              {error.pedido && <span className="font-medium">{error.pedido}</span>}
                              {error.linha && <span className="text-gray-500 ml-2">(linha {error.linha})</span>}
                              {!error.pedido && error.linha && <span>Linha {error.linha}</span>}
                            </td>
                            <td className="px-4 py-2 text-red-700">{error.erro}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={handleClose}>Fechar</Button>
                <Button type="button" onClick={() => { setFile(null); setResults(null); }}>
                  Importar Outro Arquivo
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
