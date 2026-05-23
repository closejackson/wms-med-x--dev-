import React, { useState, useEffect, useRef } from "react";
import { useBarcodeScan } from "../../hooks/useBarcodeScan";
import { CollectorLayout } from "../../components/CollectorLayout";
import { Card, CardContent } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Checkbox } from "../../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { Camera, Check, Loader2, Undo2, Package, Layers, Scissors, Hash } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../components/ui/dialog";
import { trpc } from "../../lib/trpc";
import { toast } from "sonner";
import { ProductCombobox } from "../../components/ProductCombobox";
import { RegisterNCGModal } from "@/components/RegisterNCGModal";
import { ConfirmFinishModal } from "@/components/ConfirmFinishModal";
import { useLocation } from "wouter";

export function CollectorReceiving() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState<"select" | "conference" | "ncg-scan" | "ncg-register-label">("select");
  const [showScanner, setShowScanner] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  // Seleção múltipla para conferência agrupada
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [conferenceId, setConferenceId] = useState<number | null>(null);
  
  // Conferência cega — auto-submit via hook de barcode
  const [labelCode, setLabelCode] = useState(""); // mantido para compatibilidade com pendingLabelCode
  const [showAssociationDialog, setShowAssociationDialog] = useState(false);
  const [pendingLabelCode, setPendingLabelCode] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [selectedReceivingOrderItemId, setSelectedReceivingOrderItemId] = useState<number | null>(null); // ✅ ID da linha da ordem
  const [selectedUniqueCode, setSelectedUniqueCode] = useState<string>(""); // ✅ SKU+Lote como chave única
  const [batch, setBatch] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [unitsPerBox, setUnitsPerBox] = useState<number>(1);
  const [totalUnitsReceived, setTotalUnitsReceived] = useState<number>(0);

  // Dialog de caixa fracionada
  const [showFractionalDialog, setShowFractionalDialog] = useState(false);
  const [fractionalLabelCode, setFractionalLabelCode] = useState("");
  const [fractionalUnitsPerBox, setFractionalUnitsPerBox] = useState(0);
  const [fractionalQty, setFractionalQty] = useState<string>("");
  
  // Pilha LIFO para desfazer leituras (cada entrada = 1 bipagem)
  const [undoStack, setUndoStack] = useState<Array<{
    productId: number;
    batch: string;
    scannedCode: string;
  }>>([]);
  
  // NCG (Não Conformidade)
  const [ncgLabelCode, setNcgLabelCode] = useState("");
  const [ncgLabelExists, setNcgLabelExists] = useState(false);
  const [isNCGModalOpen, setIsNCGModalOpen] = useState(false);
  const [selectedItemForNCG, setSelectedItemForNCG] = useState<{
    receivingOrderItemId: number;
    labelCode: string;
    maxQuantity: number;
    labelExists: boolean;
  } | null>(null);
  
  // Tela 2: Registro de etiqueta (quando etiqueta não existe)
  const [ncgProductId, setNcgProductId] = useState<number | null>(null);
  const [ncgSelectedItemId, setNcgSelectedItemId] = useState<string>(""); // ✅ ID do item selecionado no combobox
  const [ncgUniqueCode, setNcgUniqueCode] = useState<string>("");
  const [ncgBatch, setNcgBatch] = useState<string>("");
  const [ncgExpiryDate, setNcgExpiryDate] = useState<string>("");
  const [ncgUnitsPerBox, setNcgUnitsPerBox] = useState<number>(1);
  const [ncgQuantity, setNcgQuantity] = useState<number>(0);

  // Estado para entrada manual de quantidade
  const [showManualQtyDialog, setShowManualQtyDialog] = useState(false);
  const [manualQtyItem, setManualQtyItem] = useState<{ productId: number; productName: string; batch: string; receivingOrderItemId: number; currentUnits: number } | null>(null);
  const [manualQtyValue, setManualQtyValue] = useState("");
  const [manualQtyReason, setManualQtyReason] = useState("");
  
  const labelInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  // Buscar ordens de recebimento pendentes
  const { data: orders } = trpc.receiving.list.useQuery();

  // Buscar itens da ordem selecionada
  const { data: orderItems } = trpc.receiving.getItems.useQuery(
    { receivingOrderId: selectedOrderId! },
    { enabled: !!selectedOrderId }
  );

  // Buscar dados do produto selecionado
  const { data: selectedProduct } = trpc.products.getById.useQuery(
    { id: selectedProductId! },
    { enabled: !!selectedProductId }
  );

  // Preencher unitsPerBox automaticamente
  useEffect(() => {
    if (selectedProduct?.unitsPerBox) {
      setUnitsPerBox(selectedProduct.unitsPerBox);
      setTotalUnitsReceived(selectedProduct.unitsPerBox);
    } else {
      setUnitsPerBox(1);
      setTotalUnitsReceived(1);
    }
  }, [selectedProduct]);

  // Iniciar sessão
  const startSessionMutation = trpc.blindConference.start.useMutation({
    onSuccess: (data) => {
      setConferenceId(data.sessionId);
      setStep("conference");
      toast.success("Conferência iniciada");
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Ler etiqueta
  const readLabelMutation = trpc.blindConference.readLabel.useMutation({
    onSuccess: (data) => {
      if (data.isNewLabel) {
        setPendingLabelCode(labelCode);
        setShowAssociationDialog(true);
        
        if (orderItems && orderItems.length === 1) {
          setSelectedProductId(orderItems[0].productId);
          setSelectedReceivingOrderItemId(orderItems[0].id);
          setSelectedUniqueCode(orderItems[0].uniqueCode ?? "");
        }
      } else {
        // ✅ PROPAGAR receivingOrderItemId para o estado (fluxo automático)
        if (data.association) {
          // ✅ Gerar uniqueCode (SKU + Lote)
          const uniqueCode = `${data.association.productSku}-${data.association.batch || ""}`;
          
          console.log("🔍 [readLabel onSuccess] DADOS RECEBIDOS:", {
            receivingOrderItemId: data.association.receivingOrderItemId,
            productId: data.association.productId,
            productName: data.association.productName,
            batch: data.association.batch,
            uniqueCode,
          });
          
          setSelectedReceivingOrderItemId(data.association.receivingOrderItemId || null);
          setSelectedProductId(data.association.productId);
          setSelectedUniqueCode(uniqueCode); // ✅ Seta uniqueCode para sincronizar ProductCombobox
          setBatch(data.association.batch || "");
          
          console.log("🔍 [readLabel onSuccess] ESTADOS SETADOS:", {
            selectedReceivingOrderItemId: data.association.receivingOrderItemId,
            selectedProductId: data.association.productId,
            selectedUniqueCode: uniqueCode,
          });
          
          // Empilhar item bipado na pilha LIFO
          setUndoStack(prev => [...prev, {
            productId: data.association.productId,
            batch: data.association.batch || "",
            scannedCode: labelCode,
          }]);
        }
        
        toast.success("Etiqueta lida!", {
          description: `${data.association?.productName} - ${data.association?.packagesRead} caixas (${data.association?.totalUnits || 0} unidades)`,
        });
        setLabelCode("");
        barcode.clear();
        // Abrir dialog de caixa fracionada APENAS quando a quantidade restante
        // é menor que uma caixa cheia (ou seja, a próxima bipagem causaria over-receiving)
        const assoc = data.association;
        const remaining = assoc?.remainingQuantity ?? null;
        const upb = assoc?.unitsPerBox ?? 1;
        const shouldAskFractional = upb > 1 && remaining !== null && remaining < upb && remaining > 0;
        if (shouldAskFractional && assoc) {
          setFractionalLabelCode(assoc.labelCode || "");
          setFractionalUnitsPerBox(upb);
          setFractionalQty(String(remaining)); // pré-preencher com a quantidade restante
          setShowFractionalDialog(true);
        } else {
          barcode.focus();
        }
        utils.blindConference.getSummary.invalidate({ conferenceId: conferenceId! });
      }
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Hook de auto-submit para o campo de leitura principal (deve vir após readLabelMutation)
  const barcode = useBarcodeScan({
    onSubmit: (code) => {
      if (!conferenceId) { toast.error("Sessão não iniciada"); return; }
      setLabelCode(code); // para compatibilidade com pendingLabelCode
      readLabelMutation.mutate({ conferenceId, labelCode: code });
    },
    disabled: readLabelMutation.isPending,
  });

  // Associar etiqueta
  const associateLabelMutation = trpc.blindConference.associateLabel.useMutation({
    onSuccess: (data) => {
      toast.success("Etiqueta associada!", {
        description: `${data.association.productName} - ${data.association.totalUnits} unidades`,
      });
      
      setShowAssociationDialog(false);
      setPendingLabelCode("");
      setSelectedProductId(null);
      setSelectedReceivingOrderItemId(null);
      setSelectedUniqueCode(""); // ✅ Reset uniqueCode
      setBatch("");
      setExpiryDate("");
      setUnitsPerBox(1);
      setTotalUnitsReceived(0);
      setLabelCode("");
      barcode.clear();
      barcode.focus();
      utils.blindConference.getSummary.invalidate({ conferenceId: conferenceId! });
      // Invalidar getItems para atualizar lote/uniqueCode na lista após associação
      if (selectedOrderId) {
        utils.receiving.getItems.invalidate({ receivingOrderId: selectedOrderId });
      }
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Mutation para definir quantidade manual de unidades
  const setManualUnitsMutation = trpc.blindConference.setManualUnits.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      utils.blindConference.getSummary.invalidate({ conferenceId: conferenceId! });
      setShowManualQtyDialog(false);
      setManualQtyItem(null);
      setManualQtyValue("");
      setManualQtyReason("");
    },
    onError: (error: any) => {
      toast.error("Erro ao definir quantidade", { description: error.message });
    },
  });

  const handleManualQtyOpen = (item: any) => {
    // Usa receivingOrderItemId retornado pelo getSummary (via JOIN com receivingOrderItems)
    // Fallback: tenta encontrar via orderItems ou selectedReceivingOrderItemId
    const matchingOrderItem = orderItems?.find(
      (oi: any) => oi.productId === item.productId && (oi.batch || "") === (item.batch || "")
    );
    const resolvedItemId = item.receivingOrderItemId || matchingOrderItem?.id || selectedReceivingOrderItemId || 0;
    setManualQtyItem({
      productId: item.productId,
      productName: item.productName,
      batch: item.batch || "",
      receivingOrderItemId: resolvedItemId,
      currentUnits: item.unitsRead || 0,
    });
    setManualQtyValue(String(item.unitsRead || 0));
    setManualQtyReason("");
    setShowManualQtyDialog(true);
  };

  const handleManualQtySave = () => {
    if (!conferenceId || !manualQtyItem) return;
    const qty = parseInt(manualQtyValue, 10);
    if (isNaN(qty) || qty <= 0) {
      toast.error("Informe uma quantidade válida maior que zero");
      return;
    }
    if (!manualQtyReason.trim()) {
      toast.error("Informe o motivo");
      return;
    }
    if (!manualQtyItem.receivingOrderItemId) {
      toast.error("Não foi possível identificar o item da ordem. Tente novamente.");
      return;
    }
    setManualUnitsMutation.mutate({
      conferenceId,
      productId: manualQtyItem.productId,
      batch: manualQtyItem.batch || null,
      receivingOrderItemId: manualQtyItem.receivingOrderItemId,
      totalUnits: qty,
      reason: manualQtyReason.trim(),
    });
  };

  // Corrigir caixa fracionada
  const correctFractionalMutation = trpc.blindConference.correctFractionalBox.useMutation({
    onSuccess: (data) => {
      toast.success(`Caixa fracionada registrada: ${data.fractionalQty} unidades`);
      setShowFractionalDialog(false);
      setFractionalLabelCode("");
      setFractionalQty("");
      barcode.focus();
      utils.blindConference.getSummary.invalidate({ conferenceId: conferenceId! });
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Desfazer última leitura
  const undoLastReadingMutation = trpc.blindConference.undoLastReading.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      utils.blindConference.getSummary.invalidate({ conferenceId: conferenceId! });
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Obter resumo
  const { data: summary } = trpc.blindConference.getSummary.useQuery(
    { conferenceId: conferenceId! },
    { enabled: !!conferenceId, refetchInterval: 3000 }
  );

  // Estado para modal de confirmação
  const [showConfirmModal, setShowConfirmModal] = React.useState(false);
  const [prepareSummary, setPrepareSummary] = React.useState<any>(null);

  // Preparar finalização (calcular addressedQuantity)
  const prepareMutation = trpc.blindConference.prepareFinish.useMutation({
    onSuccess: (data) => {
      setPrepareSummary(data);
      setShowConfirmModal(true);
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Finalizar conferência (criar inventory)
  const finishMutation = trpc.blindConference.finish.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      setShowConfirmModal(false);
      setPrepareSummary(null);
      setStep("select");
      setSelectedOrderId(null);
      setConferenceId(null);
      utils.receiving.list.invalidate();
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  // Mutation para criar grupo de conferência agrupada
  const createGroupMutation = trpc.blindConferenceGroup.createGroup.useMutation({
    onSuccess: (data) => {
      toast.success("Conferência agrupada iniciada!");
      setLocation(`/collector/receiving-group?groupId=${data.groupId}`);
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  const handleStartConference = () => {
    if (!selectedOrderId) {
      toast.error("Selecione uma ordem de recebimento");
      return;
    }
    startSessionMutation.mutate({ receivingOrderId: selectedOrderId });
  };

  const handleStartGroupedConference = () => {
    if (selectedOrderIds.length < 2) {
      toast.error("Selecione pelo menos 2 ordens para conferência agrupada");
      return;
    }
    createGroupMutation.mutate({ receivingOrderIds: selectedOrderIds });
  };

  const toggleOrderSelection = (orderId: number) => {
    setSelectedOrderIds(prev =>
      prev.includes(orderId)
        ? prev.filter(id => id !== orderId)
        : [...prev, orderId]
    );
    // Ao selecionar para multi, limpar seleção única
    setSelectedOrderId(null);
  };

  const handleLabelSubmit = () => {
    if (!labelCode.trim()) {
      toast.error("Digite ou escaneie um código");
      return;
    }

    if (!conferenceId) {
      toast.error("Sessão não iniciada");
      return;
    }

    readLabelMutation.mutate({
      conferenceId,
      labelCode: labelCode.trim(),
    });
  };

  const handleScanSuccess = (code: string) => {
    setLabelCode(code);
    setShowScanner(false);
    
    if (conferenceId) {
      readLabelMutation.mutate({
        conferenceId,
        labelCode: code,
      });
    }
  };

  const handleAssociate = () => {
    // 🔍 DEBUG: Verificar IDs antes de enviar
    console.log("🔍 [handleAssociate] selectedProductId:", selectedProductId);
    console.log("🔍 [handleAssociate] selectedReceivingOrderItemId:", selectedReceivingOrderItemId);
    console.log("🔍 [handleAssociate] conferenceId:", conferenceId);
    
    if (!selectedProductId || !selectedReceivingOrderItemId) {
      console.error("❌ [handleAssociate] ERRO: selectedReceivingOrderItemId não preenchido!");
      toast.error("Selecione um produto");
      return;
    }

    if (unitsPerBox < 1) {
      toast.error("Unidades por caixa deve ser maior que zero");
      return;
    }

    if (totalUnitsReceived < 1) {
      toast.error("Quantidade recebida deve ser maior que zero");
      return;
    }

    associateLabelMutation.mutate({
      conferenceId: conferenceId!,
      labelCode: pendingLabelCode,
      receivingOrderItemId: selectedReceivingOrderItemId!, // ✅ ID da linha da ordem
      productId: selectedProductId,
      batch: batch || null,
      expiryDate: expiryDate || null,
      unitsPerBox,
      totalUnitsReceived,
    });
  };

  const handleNcgLabelScan = async () => {
    if (!ncgLabelCode.trim()) {
      toast.error("Digite ou escaneie um código");
      return;
    }

    if (!selectedOrderId) {
      toast.error("Ordem não selecionada");
      return;
    }

    try {
      // Verificar se etiqueta existe em labelAssociations via tRPC
      const labelData = await utils.blindConference.checkLabelExists.fetch({
        labelCode: ncgLabelCode.trim(),
      });

      if (labelData?.exists && labelData.label) {
        // Etiqueta existe: autofill com dados da etiqueta e ir para Tela 3
        const productId = labelData.label.productId;

        // Buscar o receivingOrderItem correspondente na ordem atual
        // ✅ FIX: filtrar por productId E batch para evitar vínculo ao lote errado quando há múltiplos lotes do mesmo SKU
        const labelBatch = labelData.label.batch || null;
        const matchingItem = (
          labelBatch
            ? orderItems?.find(i => i.productId === productId && i.batch === labelBatch)
            : undefined
        ) ?? orderItems?.find(i => i.productId === productId);

        if (!matchingItem) {
          // Produto da etiqueta não está nesta ordem — registrar como NCG sem vínculo de item
          // Usar o primeiro item da ordem como fallback (o backend vai criar o registro NCG)
          toast.warning("Produto da etiqueta não encontrado nesta ordem. Selecione manualmente.");
          // Preencher campos da Tela 2 com dados da etiqueta para facilitar
          const ed = labelData.label.expiryDate;
          setNcgBatch(labelData.label.batch || "");
          setNcgExpiryDate(ed ? new Date(ed).toISOString().split('T')[0] : "");
          setNcgUnitsPerBox(labelData.label.unitsPerBox || 1);
          setNcgProductId(productId);
          setStep("ncg-register-label");
          return;
        }

        // Autofill: produto encontrado na ordem — ir direto para Tela 3 (modal NCG)
        const ed = labelData.label.expiryDate;
        const expiryStr = ed ? new Date(ed).toISOString().split('T')[0] : "";

        setSelectedItemForNCG({
          receivingOrderItemId: matchingItem.id,
          labelCode: ncgLabelCode.trim(),
          maxQuantity: matchingItem.expectedQuantity || 999999,
          labelExists: true,
        });
        // Preencher campos auxiliares para o modal
        setNcgBatch(labelData.label.batch || "");
        setNcgExpiryDate(expiryStr);
        setNcgUnitsPerBox(labelData.label.unitsPerBox || 1);
        setNcgProductId(productId);
        setIsNCGModalOpen(true);
      } else {
        // Etiqueta NÃO existe: ir para Tela 2 (Registro de Etiqueta)
        setStep("ncg-register-label");
      }
    } catch (error) {
      console.error("Erro ao verificar etiqueta:", error);
      toast.error("Erro ao verificar etiqueta");
    }
  };

  const handleUndo = () => {
    if (!conferenceId) return;
    if (!summary?.conferenceItems?.length) {
      toast.error("Nenhuma leitura para desfazer");
      return;
    }
    undoLastReadingMutation.mutate({ conferenceId });
  };

  const handleFinish = () => {
    if (!summary?.conferenceItems.length) {
      toast.error("Nenhuma etiqueta foi lida ainda");
      return;
    }
    
    // Chamar prepareFinish para calcular addressedQuantity e mostrar modal
    prepareMutation.mutate({ conferenceId: conferenceId! });
  };

  const handleConfirmFinish = () => {
    // Chamar finish para criar inventory
    finishMutation.mutate({ conferenceId: conferenceId! });
  };

  const totalVolumes = summary?.conferenceItems.reduce((sum: number, item: any) => sum + item.packagesRead, 0) || 0;
  const totalUnits = summary?.conferenceItems.reduce((sum: number, item: any) => sum + (item.unitsRead || 0), 0) || 0; // Usar unitsRead do backend

  if (showScanner) {
    return (
      <BarcodeScanner
        onScan={handleScanSuccess}
        onClose={() => setShowScanner(false)}
      />
    );
  }

  // Diálogo de associação
  if (showAssociationDialog) {
    return (
      <CollectorLayout title="Associar Etiqueta">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-4">
              <div>
                <Label className="text-lg font-semibold">Nova Etiqueta</Label>
                <p className="text-sm text-gray-600">Código: {pendingLabelCode}</p>
              </div>

              <div>
                <Label>Produto *</Label>
                <ProductCombobox
                  products={orderItems?.map((item: any) => ({
                    id: item.uniqueCode, // ✅ uniqueCode (SKU+Lote) como chave única
                    sku: item.productSku || 'N/A',
                    description: `${item.productDescription || 'Sem descrição'} - Lote: ${item.batch || 'S/L'}`,
                  })) || []}
                  value={selectedUniqueCode}
                  onValueChange={(uniqueCode) => {
                    const selectedLine = orderItems?.find((item: any) => item.uniqueCode === uniqueCode);
                    if (selectedLine) {
                      setSelectedProductId(selectedLine.productId);
                      setSelectedReceivingOrderItemId(selectedLine.id);
                      setSelectedUniqueCode(uniqueCode);
                      if (selectedLine.batch) setBatch(selectedLine.batch);
                      // Preencher data de validade automaticamente
                      const ed = selectedLine.expiryDate;
                      if (ed) {
                        // expiryDate já é string YYYY-MM-DD — usar diretamente
                        setExpiryDate(typeof ed === 'string' ? ed.substring(0, 10) : "");
                      } else {
                        setExpiryDate("");
                      }
                    }
                  }}
                  placeholder="Selecione o produto"
                  className="h-12 text-base"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Lote</Label>
                  <Input
                    value={batch}
                    onChange={async (e) => {
                      const newBatch = e.target.value;
                      setBatch(newBatch);
                      
                      // Busca automática de expiryDate quando lote é digitado
                      if (newBatch && selectedProductId) {
                        const selectedProduct = orderItems?.find((item: any) => item.productId === selectedProductId);
                        if (selectedProduct?.productSku) {
                          try {
                            // ✅ FORMA CORRETA: Use utils.client para fazer fetch manual (não é um Hook)
                            const result = await utils.client.blindConference.getExpiryDateFromXML.query({
                              sku: selectedProduct.productSku,
                              batch: newBatch,
                            });
                            
                            if (result.found && result.expiryDate) {
                              // expiryDate já é string YYYY-MM-DD — usar diretamente
                              const formatted = typeof result.expiryDate === 'string' 
                                ? result.expiryDate.substring(0, 10)
                                : new Date(result.expiryDate).toISOString().split('T')[0];
                              setExpiryDate(formatted);
                              
                              toast.info("Data de validade preenchida automaticamente", {
                                description: `Encontrado no XML da NF-e: ${formatted}`,
                              });
                            }
                          } catch (error) {
                            console.error("Erro ao buscar data de validade:", error);
                          }
                        }
                      }
                    }}
                    placeholder="Lote"
                    className="h-12 text-base"
                  />
                </div>
                <div>
                  <Label>Validade</Label>
                  <Input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className={`h-12 text-base ${
                      expiryDate && (() => {
                        const d = new Date(expiryDate + "T00:00:00");
                        return isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100;
                      })()
                        ? "border-red-500 focus-visible:ring-red-500"
                        : ""
                    }`}
                  />
                  {expiryDate && (() => {
                    const [y, m, d] = expiryDate.split("-").map(Number);
                    const date = new Date(y, m - 1, d);
                    const isInvalid = isNaN(date.getTime()) || date.getMonth() !== m - 1 || date.getDate() !== d;
                    return isInvalid ? (
                      <p className="text-xs text-red-600 mt-1">Data inválida (ex: 29/02 em ano não-bissexto)</p>
                    ) : null;
                  })()}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Un/Caixa *</Label>
                  <Input
                    type="number"
                    value={unitsPerBox}
                    onChange={(e) => setUnitsPerBox(parseInt(e.target.value) || 1)}
                    className="h-12 text-base"
                    min="1"
                  />
                </div>
                <div>
                  <Label>Qtd Recebida *</Label>
                  <Input
                    type="number"
                    value={totalUnitsReceived}
                    onChange={(e) => setTotalUnitsReceived(parseInt(e.target.value) || 0)}
                    className="h-12 text-base"
                    min="1"
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAssociationDialog(false);
                    setPendingLabelCode("");
                    setSelectedProductId(null);
                  }}
                  className="flex-1 h-12"
                >
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    // Abrir modal de NCG
                    if (!selectedReceivingOrderItemId) {
                      toast.error("Selecione um produto primeiro");
                      return;
                    }
                    setSelectedItemForNCG({
                      receivingOrderItemId: selectedReceivingOrderItemId,
                      labelCode: pendingLabelCode,
                      maxQuantity: totalUnitsReceived || unitsPerBox,
                      labelExists: false,
                    });
                    setIsNCGModalOpen(true);
                    setShowAssociationDialog(false);
                  }}
                  className="flex-1 h-12"
                >
                  Registrar NCG
                </Button>
                <Button
                  onClick={handleAssociate}
                  disabled={associateLabelMutation.isPending}
                  className="flex-1 h-12"
                >
                  {associateLabelMutation.isPending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    "Associar"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </CollectorLayout>
    );
  }

  // Tela de seleção de ordem
  if (step === "select") {
    const scheduledOrders = orders?.filter((o: any) => o.status === "scheduled") ?? [];
    const hasMultiSelection = selectedOrderIds.length >= 2;
    const hasSingleSelection = selectedOrderId !== null;

    return (
      <CollectorLayout title="Recebimento">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <Label className="text-lg font-semibold mb-1 block">Selecione a(s) Ordem(ns)</Label>
              <p className="text-xs text-gray-500 mb-3">Toque para selecionar uma ordem. Selecione 2 ou mais para conferência agrupada.</p>

              {scheduledOrders.length === 0 ? (
                <p className="text-center text-gray-400 py-6 text-sm">Nenhuma ordem agendada</p>
              ) : (
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {scheduledOrders.map((order: any) => {
                    const isChecked = selectedOrderIds.includes(order.id);
                    const isSingleSelected = selectedOrderId === order.id;
                    return (
                      <div
                        key={order.id}
                        className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          isChecked
                            ? "bg-indigo-50 border-indigo-400"
                            : isSingleSelected
                            ? "bg-blue-50 border-blue-400"
                            : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                        onClick={() => {
                          // Se já há seleção múltipla ativa, usar modo multi
                          if (selectedOrderIds.length > 0) {
                            toggleOrderSelection(order.id);
                          } else {
                            // Primeiro toque: seleção única
                            setSelectedOrderId(order.id === selectedOrderId ? null : order.id);
                          }
                        }}
                      >
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => toggleOrderSelection(order.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">#{order.orderNumber}</p>
                          <p className="text-xs text-gray-500 truncate">{order.supplierName || "Sem fornecedor"}</p>
                          {order.nfeNumber && (
                            <p className="text-xs text-gray-400">NF-e {order.nfeNumber}</p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Agendado</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Botão Conferência Agrupada (aparece quando ≥2 checkboxes marcados) */}
          {hasMultiSelection && (
            <Button
              onClick={handleStartGroupedConference}
              disabled={createGroupMutation.isPending}
              className="w-full h-14 text-lg bg-indigo-600 hover:bg-indigo-700"
            >
              {createGroupMutation.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ) : (
                <Layers className="w-5 h-5 mr-2" />
              )}
              Conferência Agrupada ({selectedOrderIds.length} NFs)
            </Button>
          )}

          {/* Botão Iniciar Conferência (seleção única) */}
          {!hasMultiSelection && (
            <Button
              onClick={handleStartConference}
              disabled={!hasSingleSelection || startSessionMutation.isPending}
              className="w-full h-14 text-lg"
            >
              {startSessionMutation.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ) : (
                <Package className="w-5 h-5 mr-2" />
              )}
              Iniciar Conferência
            </Button>
          )}
        </div>
      </CollectorLayout>
    );
  }

  // Tela de scan de etiqueta para NCG
  if (step === "ncg-scan") {
    return (
      <CollectorLayout title="Registrar NCG">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-3">
              <Label className="text-base font-semibold">Realize a leitura da etiqueta do produto</Label>
              <div className="flex gap-2">
                <Input
                  value={ncgLabelCode}
                  onChange={(e) => setNcgLabelCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ncgLabelCode.trim()) {
                      handleNcgLabelScan();
                    }
                  }}
                  placeholder="Código da etiqueta..."
                  className="h-12 text-base"
                  inputMode="numeric"
                />
                <Button
                  onClick={handleNcgLabelScan}
                  disabled={!ncgLabelCode.trim()}
                  className="h-12 px-6"
                >
                  Ler
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => setShowScanner(true)}
                className="w-full h-12"
              >
                <Camera className="w-5 h-5 mr-2" />
                Escanear com Câmera
              </Button>
            </CardContent>
          </Card>

          <Button
            variant="outline"
            onClick={() => {
              setStep("select");
              setNcgLabelCode("");
            }}
            className="w-full h-12"
          >
            Voltar
          </Button>
        </div>

        {/* Scanner de código de barras */}
        {showScanner && (
          <BarcodeScanner
            onScan={(code) => {
              setNcgLabelCode(code);
              setShowScanner(false);
              handleNcgLabelScan();
            }}
            onClose={() => setShowScanner(false)}
          />
        )}

        {/* Modal de Registro de NCG */}
        {isNCGModalOpen && selectedItemForNCG && (
          <RegisterNCGModal
            isOpen={isNCGModalOpen}
            onClose={() => {
              setIsNCGModalOpen(false);
              setSelectedItemForNCG(null);
              setStep("select"); // Volta para tela inicial
            }}
            conferenceId={conferenceId || 0}
            receivingOrderItemId={selectedItemForNCG.receivingOrderItemId}
            labelCode={selectedItemForNCG.labelCode}
            maxQuantity={selectedItemForNCG.maxQuantity}
            labelExists={selectedItemForNCG.labelExists}
          />
        )}
      </CollectorLayout>
    );
  }

  // Tela 2: Registro de etiqueta (quando etiqueta não existe)
  if (step === "ncg-register-label") {
    return (
      <CollectorLayout title="Registrar Etiqueta - NCG">
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="space-y-2">
                <Label>Código da Etiqueta</Label>
                <Input
                  value={ncgLabelCode}
                  disabled
                  className="bg-muted font-mono"
                />
              </div>

              <div className="space-y-2">
                <Label>Selecionar Produto (SKU - Lote)</Label>
                <ProductCombobox
                  products={orderItems?.map(item => ({
                    id: item.id.toString(),
                    sku: item.productSku ?? "",
                    description: `Lote: ${item.batch || 'SEM LOTE'}`,
                  }))}
                  value={ncgSelectedItemId}
                  onValueChange={(selectedId) => {
                    setNcgSelectedItemId(selectedId);
                    const item = orderItems?.find(i => i.id.toString() === selectedId);
                    if (item) {
                      setNcgUniqueCode(item.uniqueCode || `${item.productId}-${item.id}`);
                      setNcgProductId(item.productId);
                      setNcgBatch(item.batch || "");
                      // Preencher data de validade automaticamente — tratar Date, string ISO e null
                      const ed = item.expiryDate;
                      if (ed) {
                        // expiryDate já é string YYYY-MM-DD — usar diretamente
                        setNcgExpiryDate(typeof ed === 'string' ? ed.substring(0, 10) : "");
                      } else {
                        setNcgExpiryDate("");
                      }
                    }
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label>Lote</Label>
                <Input
                  value={ncgBatch}
                  disabled
                  className="bg-muted"
                />
              </div>

              <div className="space-y-2">
                <Label>Validade</Label>
                <Input
                  value={ncgExpiryDate}
                  disabled
                  className="bg-muted"
                />
              </div>

              <div className="space-y-2">
                <Label>Unidades por Caixa *</Label>
                <Input
                  type="number"
                  value={ncgUnitsPerBox}
                  onChange={(e) => setNcgUnitsPerBox(Number(e.target.value))}
                  min={1}
                  className="text-center font-bold"
                />
              </div>

              <div className="space-y-2">
                <Label>Quantidade Avariada *</Label>
                <Input
                  type="number"
                  value={ncgQuantity}
                  onChange={(e) => setNcgQuantity(Number(e.target.value))}
                  min={1}
                  className="text-center font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep("ncg-scan");
                    setNcgProductId(null);
                    setNcgUniqueCode("");
                    setNcgBatch("");
                    setNcgExpiryDate("");
                    setNcgUnitsPerBox(1);
                    setNcgQuantity(0);
                  }}
                  className="h-12"
                >
                  Voltar
                </Button>
                <Button
                  onClick={() => {
                    if (!ncgProductId) {
                      toast.error("Selecione um produto");
                      return;
                    }
                    if (ncgUnitsPerBox < 1) {
                      toast.error("Unidades por caixa deve ser maior que zero");
                      return;
                    }
                    if (ncgQuantity < 1) {
                      toast.error("Quantidade avariada deve ser maior que zero");
                      return;
                    }
                    
                    // Ir para Tela 3 (Registro de NCG)
                    // ✅ FIX: filtrar por productId E batch para garantir vínculo ao lote correto
                    const item = (
                      ncgBatch
                        ? orderItems?.find(i => i.productId === ncgProductId && i.batch === ncgBatch)
                        : undefined
                    ) ?? orderItems?.find(i => i.productId === ncgProductId);
                    if (!item) {
                      toast.error("Item da ordem não encontrado");
                      return;
                    }
                    
                    setSelectedItemForNCG({
                      receivingOrderItemId: item.id,
                      labelCode: ncgLabelCode,
                      maxQuantity: ncgQuantity,
                      labelExists: false,
                    });
                    setIsNCGModalOpen(true);
                  }}
                  className="h-12"
                >
                  Confirmar
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Modal de Registro de NCG */}
        {isNCGModalOpen && selectedItemForNCG && (
          <RegisterNCGModal
            isOpen={isNCGModalOpen}
            onClose={() => {
              setIsNCGModalOpen(false);
              setSelectedItemForNCG(null);
              setStep("conference"); // Volta para tela de conferência
            }}
            conferenceId={conferenceId || 0}
            receivingOrderItemId={selectedItemForNCG.receivingOrderItemId}
            labelCode={selectedItemForNCG.labelCode}
            maxQuantity={selectedItemForNCG.maxQuantity}
            labelExists={selectedItemForNCG.labelExists}
            unitsPerBox={ncgUnitsPerBox}
            batch={ncgBatch}
            expiryDate={ncgExpiryDate}
            productId={ncgProductId}
          />
        )}
      </CollectorLayout>
    );
  }

  // Tela de conferência
  return (
    <CollectorLayout title={`Conferência - Ordem #${selectedOrderId}`}>
      <div className="space-y-4">
        {/* Métricas */}
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-gray-600">Volumes</div>
              <div className="text-3xl font-bold">{totalVolumes}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm text-gray-600">Unidades</div>
              <div className="text-3xl font-bold">{totalUnits}</div>
            </CardContent>
          </Card>
        </div>

        {/* Leitura de Etiquetas */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="text-base font-semibold">Leitura de Etiquetas</Label>
            <div className="flex gap-2">
              <Input
                ref={barcode.ref}
                value={barcode.value}
                onChange={barcode.onChange}
                onKeyDown={barcode.onKeyDown}
                placeholder="Bipe a etiqueta..."
                className="h-12 text-base"
                disabled={readLabelMutation.isPending}
                
                autoComplete="off"
                autoFocus
              />
              <Button
                onClick={() => barcode.value.trim() && barcode.onKeyDown({ key: "Enter", preventDefault: () => {} } as any)}
                disabled={readLabelMutation.isPending || !barcode.value.trim()}
                className="h-12 px-6"
              >
                {readLabelMutation.isPending ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  "Ler"
                )}
              </Button>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowScanner(true)}
              className="w-full h-12"
            >
              <Camera className="w-5 h-5 mr-2" />
              Escanear com Câmera
            </Button>
          </CardContent>
        </Card>

        {/* Produtos Conferidos */}
        <Card>
          <CardContent className="p-4">
            <Label className="text-base font-semibold mb-3 block">Produtos Conferidos</Label>
            
            {!summary?.conferenceItems.length ? (
              <div className="text-center py-8 text-gray-500">
                <p className="text-base mb-2">Nenhum produto conferido</p>
                <p className="text-sm">Escaneie a primeira etiqueta</p>
              </div>
            ) : (
              <div className="space-y-2">
                {summary.conferenceItems.map((item: any, idx: number) => (
                  <div key={`${item.productId}-${item.batch ?? "null"}-${idx}`} className="border rounded-lg p-3">
                    <div className="font-medium text-sm">{item.productName}</div>
                    <div className="text-xs text-gray-600 mb-2">{item.productSku}</div>
                    <div className="flex justify-between text-sm mb-2">
                      <span>Lote: {item.batch || "-"}</span>
                      <span className="font-semibold">{item.packagesRead} cx ({item.unitsRead || 0} un.)</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-8 text-xs border-blue-300 text-blue-700 hover:bg-blue-50"
                      onClick={() => handleManualQtyOpen(item)}
                    >
                      <Hash className="w-3 h-3 mr-1" />
                      Informar Quantidade
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Ações */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="outline"
            onClick={handleUndo}
            disabled={!summary?.conferenceItems?.length || undoLastReadingMutation.isPending}
            className="h-12"
          >
            <Undo2 className="w-5 h-5 mr-2" />
            Desfazer
          </Button>
          <Button
            onClick={handleFinish}
            disabled={!summary?.conferenceItems.length || finishMutation.isPending}
            className="h-12"
          >
            {finishMutation.isPending ? (
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
            ) : (
              <Check className="w-5 h-5 mr-2" />
            )}
            Finalizar
          </Button>
        </div>

        {/* Botão Registrar NCG */}
        <Button
          variant="destructive"
          onClick={() => setStep("ncg-scan")}
          className="w-full h-12 mt-3"
        >
          Registrar NCG
        </Button>
      </div>
      {/* Modal de Registro de NCG */}
      {isNCGModalOpen && conferenceId && selectedItemForNCG && (
        <RegisterNCGModal
          isOpen={isNCGModalOpen}
          onClose={() => {
            setIsNCGModalOpen(false);
            setSelectedItemForNCG(null);
          }}
          conferenceId={conferenceId}
          receivingOrderItemId={selectedItemForNCG.receivingOrderItemId}
          labelCode={selectedItemForNCG.labelCode}
          maxQuantity={selectedItemForNCG.maxQuantity}
        />
      )}

      {/* Modal de Confirmação de Finalização */}
      {showConfirmModal && prepareSummary && (
        <ConfirmFinishModal
          open={showConfirmModal}
          onClose={() => {
            setShowConfirmModal(false);
            setPrepareSummary(null);
          }}
          onConfirm={handleConfirmFinish}
          summary={prepareSummary.summary}
          receivingOrderCode={prepareSummary.receivingOrderCode}
          isLoading={finishMutation.isPending}
        />
      )}

      {/* Dialog: Entrada Manual de Quantidade */}
      <Dialog open={showManualQtyDialog} onOpenChange={(open) => { if (!open) { setShowManualQtyDialog(false); setManualQtyItem(null); setManualQtyValue(""); setManualQtyReason(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Hash className="w-5 h-5 text-blue-500" />
              Informar Quantidade
            </DialogTitle>
            <DialogDescription>
              Informe a quantidade total conferida. O sistema registrará como se cada unidade tivesse sido bipada individualmente.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <p className="text-sm font-medium text-gray-500">Produto</p>
              <p className="font-semibold text-sm">{manualQtyItem?.productName}</p>
              {manualQtyItem?.batch && <p className="text-xs text-gray-500">Lote: {manualQtyItem.batch}</p>}
              <p className="text-xs text-gray-500 mt-1">Quantidade atual: <span className="font-semibold">{manualQtyItem?.currentUnits ?? 0} unidades</span></p>
            </div>
            <div>
              <Label htmlFor="manual-qty" className="text-sm font-medium">Quantidade total (unidades) <span className="text-red-500">*</span></Label>
              <Input
                id="manual-qty"
                type="number"
                min="1"
                value={manualQtyValue}
                onChange={(e) => setManualQtyValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleManualQtySave(); }}
                className="mt-1 h-12 text-lg"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="manual-reason" className="text-sm font-medium">Motivo <span className="text-red-500">*</span></Label>
              <Input
                id="manual-reason"
                placeholder="Ex: Produto a granel, contagem física..."
                value={manualQtyReason}
                onChange={(e) => setManualQtyReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleManualQtySave(); }}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white flex-1" onClick={() => { setShowManualQtyDialog(false); setManualQtyItem(null); setManualQtyValue(""); setManualQtyReason(""); }}>
              Cancelar
            </Button>
            <Button
              className="flex-1 h-12 bg-blue-600 hover:bg-blue-700"
              onClick={handleManualQtySave}
              disabled={setManualUnitsMutation.isPending}
            >
              {setManualUnitsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Hash className="w-4 h-4 mr-2" />}
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de Caixa Fracionada */}
      <Dialog
        open={showFractionalDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowFractionalDialog(false);
            setFractionalQty("");
            barcode.focus();
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors className="w-5 h-5 text-amber-500" />
              Caixa Fracionada?
            </DialogTitle>
            <DialogDescription>
              Esta caixa possui <strong>{fractionalUnitsPerBox} unidades</strong> completas.
              Se a caixa estiver aberta (fracionada), informe a quantidade real.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm font-medium">Quantidade real na caixa</Label>
              <Input
                type="number"
                value={fractionalQty}
                onChange={(e) => setFractionalQty(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const qty = parseInt(fractionalQty);
                    if (qty > 0 && qty < fractionalUnitsPerBox && conferenceId && fractionalLabelCode) {
                      correctFractionalMutation.mutate({ conferenceId, labelCode: fractionalLabelCode, fractionalQty: qty });
                    }
                  }
                }}
                placeholder={`Máx: ${fractionalUnitsPerBox}`}
                min="1"
                max={fractionalUnitsPerBox - 1}
                className="h-12 text-lg text-center mt-1"
                autoFocus
              />
              <p className="text-xs text-gray-500 mt-1">Deve ser menor que {fractionalUnitsPerBox} (quantidade da caixa cheia)</p>
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-12"
              onClick={() => {
                setShowFractionalDialog(false);
                setFractionalQty("");
                barcode.focus();
              }}
            >
              Caixa Cheia ({fractionalUnitsPerBox} un.)
            </Button>
            <Button
              className="flex-1 h-12 bg-amber-500 hover:bg-amber-600"
              disabled={!fractionalQty || parseInt(fractionalQty) <= 0 || parseInt(fractionalQty) >= fractionalUnitsPerBox || correctFractionalMutation.isPending}
              onClick={() => {
                const qty = parseInt(fractionalQty);
                if (qty > 0 && qty < fractionalUnitsPerBox && conferenceId && fractionalLabelCode) {
                  correctFractionalMutation.mutate({ conferenceId, labelCode: fractionalLabelCode, fractionalQty: qty });
                }
              }}
            >
              {correctFractionalMutation.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <><Scissors className="w-4 h-4 mr-1" /> Fracionada</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CollectorLayout>
  );
}
