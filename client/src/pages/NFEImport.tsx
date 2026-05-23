import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Upload, FileText, CheckCircle2, XCircle, AlertCircle, Link2, Search, X, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PreallocationDialog } from "@/components/PreallocationDialog";
import { toast } from "sonner";

// ─── Tipos ───────────────────────────────────────────────────────────────────

type PendingSkuLink = {
  xmlSku: string;
  xmlDescription: string;
  quantity: number;
  unit: string;
};

// ─── Componente de seletor de produto com busca integrada ─────────────────────

function ProductSearchSelect({
  value,
  onValueChange,
  products,
}: {
  value: string;
  onValueChange: (value: string) => void;
  products: Array<{ id: number; description: string; internalCode: string | null }> | undefined;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.description.toLowerCase().includes(q) ||
        (p.internalCode ?? "").toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedProduct = products?.find((p) => p.id.toString() === value);

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        onValueChange(v);
        setSearch("");
      }}
    >
      <SelectTrigger className="w-full min-w-[220px]">
        <SelectValue placeholder="Selecionar produto...">
          {selectedProduct ? (
            <span className="truncate">
              {selectedProduct.internalCode && (
                <span className="font-mono text-xs text-muted-foreground mr-1">
                  {selectedProduct.internalCode}
                </span>
              )}
              {selectedProduct.description}
            </span>
          ) : (
            "Selecionar produto..."
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="p-0">
        {/* Campo de busca fixo no topo */}
        <div className="flex items-center gap-1 px-2 py-2 border-b sticky top-0 bg-popover z-10">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por descrição ou cód. interno..."
            className="h-7 text-sm border-0 shadow-none focus-visible:ring-0 px-1"
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            autoFocus={false}
          />
          {search && (
            <button
              onClick={(e) => { e.stopPropagation(); setSearch(""); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Lista filtrada */}
        <div className="max-h-52 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-3 px-3 text-sm text-muted-foreground text-center">
              {search ? "Nenhum produto encontrado" : "Nenhum produto sem Cód. Externo cadastrado"}
            </div>
          ) : (
            filtered.map((product) => (
              <SelectItem key={product.id} value={product.id.toString()}>
                <div className="flex items-center gap-2 min-w-0">
                  {product.internalCode && (
                    <span className="font-mono text-xs text-muted-foreground shrink-0 bg-muted px-1 rounded">
                      {product.internalCode}
                    </span>
                  )}
                  <span className="truncate">{product.description}</span>
                </div>
              </SelectItem>
            ))
          )}
        </div>

        {/* Contador de resultados */}
        {search && filtered.length > 0 && (
          <div className="px-3 py-1.5 border-t text-xs text-muted-foreground">
            {filtered.length} de {products?.length ?? 0} produto(s)
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function NFEImport() {
  const [, setLocation] = useLocation();
  const [tenantId, setTenantId] = useState("");
  const [tipo, setTipo] = useState<"entrada" | "saida">("entrada");
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [xmlContent, setXmlContent] = useState<string>("");
  const [importResult, setImportResult] = useState<any>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [showPreallocation, setShowPreallocation] = useState(false);

  // Estado para o Modal DE/PARA
  const [showSkuLinkDialog, setShowSkuLinkDialog] = useState(false);
  const [pendingSkuLinks, setPendingSkuLinks] = useState<PendingSkuLink[]>([]);
  // xmlSku → productId (mapeamento do usuário)
  const [skuMappings, setSkuMappings] = useState<Record<string, number>>({});
  const [isLinkingSkus, setIsLinkingSkus] = useState(false);

  const { data: tenants } = trpc.tenants.list.useQuery();

  // Busca produtos com internalCode mas sem customerCode (Cód. Externo) para o tenant selecionado
  const { data: productsWithoutCustomerCode } = trpc.products.listWithoutCustomerCode.useQuery(
    { tenantId: tenantId ? parseInt(tenantId) : 0 },
    { enabled: showSkuLinkDialog && !!tenantId }
  );

  const linkCustomerCodeMutation = trpc.products.linkCustomerCode.useMutation();

  const importMutation = trpc.nfe.import.useMutation({
    onSuccess: (result) => {
      setIsUploading(false);

      // Verificar se há vínculos DE/PARA pendentes (saída com Cód. Externo não encontrado)
      if ((result as any).requiresSkuLinking && result.pendingSkuLinks && result.pendingSkuLinks.length > 0) {
        setPendingSkuLinks(result.pendingSkuLinks as PendingSkuLink[]);
        setSkuMappings({});
        setShowSkuLinkDialog(true);
        toast.warning(
          `${result.pendingSkuLinks.length} produto(s) sem Cód. Externo vinculado. Use o Modal DE/PARA para continuar.`
        );
        return;
      }

      setImportResult(result);
      toast.success("NF-e importada com sucesso!");
    },
    onError: (error) => {
      toast.error("Erro ao importar NF-e: " + error.message);
      setIsUploading(false);
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xml")) {
      toast.error("Por favor, selecione um arquivo XML válido");
      return;
    }
    setXmlFile(file);
    setXmlContent("");
    setImportResult(null);
  };

  const readXmlFile = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const buffer = event.target?.result as ArrayBuffer;
          if (!buffer || buffer.byteLength === 0) {
            reject(new Error("Arquivo vazio ou corrompido"));
            return;
          }
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          } catch {
            content = new TextDecoder("iso-8859-1").decode(buffer);
          }
          if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
          resolve(content);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  };

  const handleImport = async () => {
    if (!tenantId) { toast.error("Selecione um cliente"); return; }
    if (!xmlFile) { toast.error("Selecione um arquivo XML"); return; }

    setIsUploading(true);
    setImportResult(null);

    try {
      const content = await readXmlFile(xmlFile);
      setXmlContent(content);
      importMutation.mutate({ tenantId: parseInt(tenantId), xmlContent: content, tipo });
    } catch (err: any) {
      toast.error("Erro ao ler o arquivo XML: " + (err?.message || "erro desconhecido"));
      setIsUploading(false);
    }
  };

  /**
   * Confirmar vínculos DE/PARA:
   * 1. Para cada mapeamento, salva o customerCode (cProd do XML) no produto selecionado
   * 2. Reimporta o XML automaticamente
   */
  const handleConfirmSkuLinks = async () => {
    const unmapped = pendingSkuLinks.filter((p) => !skuMappings[p.xmlSku]);
    if (unmapped.length > 0) {
      toast.error(`Ainda há ${unmapped.length} produto(s) sem vínculo definido.`);
      return;
    }

    setIsLinkingSkus(true);
    try {
      // Salvar customerCode em cada produto selecionado (transação atômica por produto)
      for (const [xmlSku, productId] of Object.entries(skuMappings)) {
        await linkCustomerCodeMutation.mutateAsync({
          productId,
          customerCode: xmlSku,
          tenantId: parseInt(tenantId),
        });
      }

      toast.success("Vínculos DE/PARA salvos! Reimportando NF-e...");
      setShowSkuLinkDialog(false);

      if (!xmlContent) {
        toast.error("Conteúdo do XML não encontrado. Por favor, reimporte manualmente.");
        setIsLinkingSkus(false);
        return;
      }

      setIsUploading(true);
      importMutation.mutate({ tenantId: parseInt(tenantId), xmlContent, tipo });
    } catch (err: any) {
      toast.error("Erro ao salvar vínculo: " + (err?.message || "erro desconhecido"));
    } finally {
      setIsLinkingSkus(false);
    }
  };

  return (
    <>
      <PageHeader
        icon={<Upload className="w-8 h-8" />}
        title="Importação de NF-e"
        description="Importe notas fiscais eletrônicas de entrada (recebimento) ou saída (separação)"
      />
      <div className="container mx-auto px-6 py-8">
        <div className="max-w-4xl mx-auto">

          {/* Formulário de Upload */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Upload de XML da NF-e</CardTitle>
              <CardDescription>
                Selecione o cliente e faça upload do arquivo XML da nota fiscal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Tipo de Movimento */}
              <div className="grid gap-2">
                <Label htmlFor="tipo">
                  Tipo de Movimento <span className="text-red-500">*</span>
                </Label>
                <Select value={tipo} onValueChange={(value: "entrada" | "saida") => setTipo(value)}>
                  <SelectTrigger className="bg-white text-gray-800">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="entrada">Entrada (Recebimento)</SelectItem>
                    <SelectItem value="saida">Saída (Separação)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Cliente */}
              <div className="grid gap-2">
                <Label htmlFor="tenant">
                  {tipo === "entrada" ? "Fornecedor" : "Armazém/Cliente"} <span className="text-red-500">*</span>
                </Label>
                <p className="text-xs text-muted-foreground mb-2">
                  {tipo === "entrada"
                    ? "Selecione o fornecedor que está enviando a mercadoria"
                    : "Selecione o armazém/cliente que está expedindo (ex: Hapvida)"}
                </p>
                <Select value={tenantId} onValueChange={setTenantId}>
                  <SelectTrigger className="bg-white text-gray-800">
                    <SelectValue placeholder="Selecione o cliente" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants?.map((tenant) => (
                      <SelectItem key={tenant.id} value={tenant.id.toString()}>
                        {tenant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Upload de Arquivo */}
              <div className="grid gap-2">
                <Label htmlFor="xml-file">
                  Arquivo XML <span className="text-red-500">*</span>
                </Label>
                <div className="flex items-center gap-4">
                  <label
                    htmlFor="xml-file"
                    className="flex items-center justify-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors bg-white"
                  >
                    <Upload className="h-5 w-5 text-gray-500" />
                    <span className="text-sm text-gray-600">
                      {xmlFile ? xmlFile.name : "Selecionar arquivo XML"}
                    </span>
                    <input
                      id="xml-file"
                      type="file"
                      accept=".xml,text/xml,application/xml"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>
                  {xmlFile && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setXmlFile(null); setXmlContent(""); setImportResult(null); }}
                    >
                      Limpar
                    </Button>
                  )}
                </div>
                {xmlFile && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Arquivo selecionado: {xmlFile.name} ({(xmlFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>

              <Button
                onClick={handleImport}
                disabled={!tenantId || !xmlFile || isUploading}
                className="w-full"
              >
                {isUploading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                    Importando...
                  </>
                ) : (
                  <>
                    <FileText className="h-4 w-4 mr-2" />
                    Importar NF-e
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Resultado da Importação */}
          {importResult && (
            <Card>
              <CardHeader>
                <CardTitle>Resultado da Importação</CardTitle>
                <CardDescription>
                  NF-e {importResult.nfeNumero} - Série {importResult.nfeSerie}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm text-gray-600">Fornecedor</p>
                    <p className="font-medium">{importResult.fornecedor}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Total de Produtos</p>
                    <p className="font-medium">{importResult.totalProdutos}</p>
                  </div>
                </div>

                {importResult.produtosNovos?.length > 0 && (
                  <Alert className="border-green-200 bg-green-50">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription>
                      <p className="font-medium text-green-900 mb-2">
                        {importResult.produtosNovos.length} produto(s) cadastrado(s) automaticamente:
                      </p>
                      <ul className="list-disc list-inside space-y-1 text-sm text-green-800">
                        {importResult.produtosNovos.map((produto: string, index: number) => (
                          <li key={index}>{produto}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {importResult.produtosExistentes?.length > 0 && (
                  <Alert className="border-blue-200 bg-blue-50">
                    <AlertCircle className="h-4 w-4 text-blue-600" />
                    <AlertDescription>
                      <p className="font-medium text-blue-900 mb-2">
                        {importResult.produtosExistentes.length} produto(s) já cadastrado(s):
                      </p>
                      <ul className="list-disc list-inside space-y-1 text-sm text-blue-800">
                        {importResult.produtosExistentes.map((produto: string, index: number) => (
                          <li key={index}>{produto}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {importResult.erros?.length > 0 && (
                  <Alert className="border-red-200 bg-red-50">
                    <XCircle className="h-4 w-4 text-red-600" />
                    <AlertDescription>
                      <p className="font-medium text-red-900 mb-2">
                        {importResult.erros.length} erro(s) encontrado(s):
                      </p>
                      <ul className="list-disc list-inside space-y-1 text-sm text-red-800">
                        {importResult.erros.map((erro: string, index: number) => (
                          <li key={index}>{erro}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setXmlFile(null);
                      setXmlContent("");
                      setImportResult(null);
                      setTenantId("");
                    }}
                  >
                    Importar Outra NF-e
                  </Button>
                  {importResult.orderType === "entrada" && (
                    <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setShowPreallocation(true)}>
                      Pré-definir Endereços
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      if (importResult.orderType === "entrada") {
                        setLocation("/recebimento");
                      } else {
                        setLocation("/picking");
                      }
                    }}
                  >
                    {importResult.orderType === "entrada" ? "Ver Recebimentos" : "Ver Separações"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Dialog de Pré-Alocação (apenas para entrada) */}
      {importResult && importResult.orderType === "entrada" && (
        <PreallocationDialog
          open={showPreallocation}
          onOpenChange={setShowPreallocation}
          receivingOrderId={importResult.orderId}
          onSuccess={() => {
            toast.success("Pré-alocações salvas! Agora você pode iniciar a conferência.");
          }}
        />
      )}

      {/* ── Modal DE/PARA ─────────────────────────────────────────────────────── */}
      {/* Disparado quando o XML de saída traz um cProd sem Cód. Externo vinculado */}
      <Dialog
        open={showSkuLinkDialog}
        onOpenChange={(open) => {
          if (!open && !isLinkingSkus) setShowSkuLinkDialog(false);
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-amber-500" />
              Vínculo DE/PARA — Cód. Externo
            </DialogTitle>
            <DialogDescription>
              Os produtos abaixo estão no XML de saída mas não possuem <strong>Cód. Externo</strong> vinculado
              no cadastro. Selecione o produto correspondente (pelo <em>Cód. Interno</em>) para cada código
              do XML. Após confirmar, o vínculo será salvo permanentemente e a NF-e será reimportada.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            {/* Instrução contextual */}
            <Alert className="border-amber-200 bg-amber-50">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 text-sm">
                <strong>Como funciona:</strong> O código do XML (<em>Cód. Externo / cProd</em>) será salvo
                como referência do cliente no cadastro do produto selecionado. Isso permite que futuras
                importações deste cliente sejam identificadas automaticamente.
              </AlertDescription>
            </Alert>

            {/* Tabela DE/PARA */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">
                    <div className="flex items-center gap-1">
                      <span className="text-amber-600">DE</span>
                      <span className="text-xs text-muted-foreground">(XML / Cód. Externo)</span>
                    </div>
                  </TableHead>
                  <TableHead>Descrição no XML</TableHead>
                  <TableHead className="w-[80px]">Qtd.</TableHead>
                  <TableHead className="w-[16px] text-center">
                    <ArrowRight className="h-4 w-4 mx-auto text-muted-foreground" />
                  </TableHead>
                  <TableHead>
                    <div className="flex items-center gap-1">
                      <span className="text-blue-600">PARA</span>
                      <span className="text-xs text-muted-foreground">(Produto no Cadastro)</span>
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingSkuLinks.map((item) => (
                  <TableRow key={item.xmlSku}>
                    {/* Cód. Externo do XML */}
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs border-amber-300 text-amber-700 bg-amber-50">
                        {item.xmlSku}
                      </Badge>
                    </TableCell>
                    {/* Descrição do XML */}
                    <TableCell className="text-sm text-muted-foreground italic">
                      {item.xmlDescription}
                    </TableCell>
                    {/* Quantidade */}
                    <TableCell className="text-sm whitespace-nowrap">
                      {item.quantity} {item.unit}
                    </TableCell>
                    {/* Seta */}
                    <TableCell className="text-center">
                      <ArrowRight className="h-4 w-4 text-muted-foreground mx-auto" />
                    </TableCell>
                    {/* Seletor de produto (Cód. Interno) */}
                    <TableCell>
                      <ProductSearchSelect
                        value={skuMappings[item.xmlSku]?.toString() || ""}
                        onValueChange={(value) => {
                          setSkuMappings((prev) => ({
                            ...prev,
                            [item.xmlSku]: parseInt(value),
                          }));
                        }}
                        products={productsWithoutCustomerCode as any}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Barra de progresso */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-300"
                  style={{
                    width: pendingSkuLinks.length > 0
                      ? `${(Object.keys(skuMappings).length / pendingSkuLinks.length) * 100}%`
                      : "0%",
                  }}
                />
              </div>
              <span className="shrink-0">
                {Object.keys(skuMappings).length} de {pendingSkuLinks.length} vinculado(s)
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSkuLinkDialog(false)}
              disabled={isLinkingSkus}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmSkuLinks}
              disabled={isLinkingSkus || Object.keys(skuMappings).length < pendingSkuLinks.length}
            >
              {isLinkingSkus ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                  Salvando vínculos...
                </>
              ) : (
                <>
                  <Link2 className="h-4 w-4 mr-2" />
                  Confirmar DE/PARA e Reimportar
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
