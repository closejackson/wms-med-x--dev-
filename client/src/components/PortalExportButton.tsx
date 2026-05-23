/**
 * PortalExportButton.tsx
 *
 * Botão de exportação reutilizável para os módulos do Portal do Cliente.
 * Suporta PDF e XLSX. Recebe uma mutation tRPC e dispara o download.
 *
 * Uso:
 *   <PortalExportButton
 *     onExport={(format) => exportMutation.mutateAsync({ format, ...filtros })}
 *     isLoading={exportMutation.isPending}
 *   />
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, FileText, Sheet, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface PortalExportButtonProps {
  /** Chamado com o formato escolhido. Deve retornar { base64, filename }. */
  onExport: (format: "pdf" | "xlsx") => Promise<{ base64: string; filename: string }>;
  /** Desabilita o botão enquanto outra operação está em curso. */
  disabled?: boolean;
  /** Texto alternativo para o botão. Padrão: "Exportar". */
  label?: string;
  /** Tamanho do botão. Padrão: "sm". */
  size?: "sm" | "default" | "lg";
}

export function PortalExportButton({
  onExport,
  disabled = false,
  label = "Exportar",
  size = "sm",
}: PortalExportButtonProps) {
  const [loadingFormat, setLoadingFormat] = useState<"pdf" | "xlsx" | null>(null);

  async function handleExport(format: "pdf" | "xlsx") {
    if (loadingFormat) return;
    setLoadingFormat(format);
    try {
      const result = await onExport(format);
      // Criar link de download a partir do base64
      const link = document.createElement("a");
      link.href = result.base64;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success(`Relatório ${format.toUpperCase()} gerado com sucesso!`);
    } catch (err: any) {
      toast.error(`Erro ao exportar: ${err?.message ?? "Tente novamente."}`);
    } finally {
      setLoadingFormat(null);
    }
  }

  const isLoading = loadingFormat !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={disabled || isLoading}
          className="gap-2 bg-white border-slate-200 hover:bg-slate-50 text-slate-700"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {isLoading ? "Gerando..." : label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={() => handleExport("pdf")}
          disabled={isLoading}
          className="gap-2 cursor-pointer"
        >
          {loadingFormat === "pdf" ? (
            <Loader2 className="h-4 w-4 animate-spin text-red-500" />
          ) : (
            <FileText className="h-4 w-4 text-red-500" />
          )}
          <span>Exportar PDF</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleExport("xlsx")}
          disabled={isLoading}
          className="gap-2 cursor-pointer"
        >
          {loadingFormat === "xlsx" ? (
            <Loader2 className="h-4 w-4 animate-spin text-green-600" />
          ) : (
            <Sheet className="h-4 w-4 text-green-600" />
          )}
          <span>Exportar XLSX</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
