# WMS Med@x - Todo de Migração

## Migração do Repositório wms-homologacao → wms-medax

- [x] Migrar package.json com dependências extras (bwip-js, exceljs, xlsx, pdfkit, multer, @zxing, html5-qrcode, idb, jsbarcode, qrcode, xml2js, etc.)
- [x] Migrar shared/ (const.ts, types.ts, utils.ts, _core/errors.ts)
- [x] Migrar drizzle/schema.ts com todas as 56 tabelas do WMS
- [x] Migrar drizzle.config.ts
- [x] Migrar server/_core/ (env.ts, context.ts, sdk.ts, oauth.ts, trpc.ts, cookies.ts, etc.)
- [x] Migrar server/db.ts com todos os helpers de banco
- [x] Migrar server/routers.ts e todos os routers tRPC
- [x] Migrar server/modules/ (addressing, conference, inventory, picking, receiving, etc.)
- [x] Migrar server/movements.ts, stage.ts, preallocation.ts, etc.
- [x] Migrar server/storage.ts
- [x] Migrar server/nfeParser.ts, locationCodeValidator.ts, locationValidation.ts
- [x] Migrar server/waveLogic.ts, waveDocument.ts, pickingLogic.ts, pickingAllocation.ts
- [x] Migrar server/syncReservations.ts, stockAlerts.ts, occupancy.ts, inventory.ts
- [x] Migrar todos os routers: blindConferenceRouter, clientPortalRouter, collectorPickingRouter, labelRouter, maintenanceRouter, pickingRouter, preallocationRouter, reportsRouter, roleRouter, shippingRouter, stageRouter, stockRouter, uploadRouter, userRouter, waveRouter
- [x] Migrar client/src/index.css (estilos globais)
- [x] Migrar client/src/App.tsx com todas as rotas
- [x] Migrar client/src/const.ts
- [x] Migrar client/src/main.tsx
- [x] Migrar client/src/lib/ (trpc.ts, utils.ts, dateUtils.ts, reportExport.ts, mobile-utils.ts, offlineQueue.ts)
- [x] Migrar client/src/hooks/ (useBackground, useBusinessError, useClientPortalAuth, useComposition, useMobile, useOfflineSync, usePersistFn)
- [x] Migrar client/src/contexts/ThemeContext.tsx
- [x] Migrar client/src/components/ (todos os componentes WMS)
- [x] Migrar client/src/pages/ (todas as páginas WMS)
- [x] Migrar vite.config.ts com aliases corretos
- [x] Migrar tsconfig.json
- [x] Instalar dependências extras com pnpm add
- [x] Aplicar migrations no TiDB Cloud (56 tabelas criadas)
- [x] Configurar variáveis de ambiente (injetadas automaticamente pelo Manus)
- [x] Corrigir erros de TypeScript (0 erros)
- [x] Validar build de produção (vite build + esbuild OK)
- [x] Testes vitest passando (1/1)
- [x] Criar checkpoint e publicar

## Bugs

- [x] CORRIGIDO: novo build com oauth.ts atualizado (campo detail no erro), env.ts simplificado sem Zod. Novo checkpoint criado para Publish.

- [x] Verificado: erro "OAuth callback failed" era esperado (código OAuth inválido no teste). Fluxo OAuth real funciona corretamente — página de login Manus exibida com sucesso
- [x] CORRIGIDO: env.ts com Zod estava no bundle de produção antigo (build de 07:10). Novo build gerado com env.ts simplificado (sem Zod). Checkpoint atualizado. (código OAuth inválido no teste). Fluxo OAuth real funciona corretamente — página de login Manus exibida com sucesso
- [x] CORRIGIDO: coluna tenantId ausente na tabela users do TiDB Cloud — adicionada via ALTER TABLE. Schema Drizzle e banco agora sincronizados. OAuth login deve funcionar.
- [x] Comparar schema Drizzle com todas as tabelas do TiDB Cloud e identificar colunas faltantes
- [x] Adicionada coluna status ao schema Drizzle de labelAssociations (estava no banco mas faltava no schema TypeScript)
- [x] CORRIGIDO: normalizar expiryDate para YYYY-MM-DD em todos os inserts de labelAssociations, productLabels, receivingOrderItems e blindConferenceItems (blindConferenceRouter, collectorPickingRouter, labelRouter, waveRouter, routers.ts)
- [x] CORRIGIDO: colunas associatedAt e status em labelAssociations agora passadas explicitamente (new Date() e 'RECEIVING'/'AVAILABLE') em todos os 5 inserts para evitar que Drizzle gere DEFAULT literal rejeitado pelo TiDB
- [x] CORRIGIDO: servidor reiniciado para carregar código novo com associatedAt/status explícitos. ENUM no banco aceita RECEIVING corretamente. Problema era cache do servidor de dev.
- [x] CORRIGIDO: status 'RECEIVING' trocado por 'AVAILABLE' em todos os inserts de labelAssociations (etiqueta não tem status de recebimento)
- [x] CORRIGIDO: dados de teste com tenantId=2 removidos da tabela labelAssociations (bloqueavam inserts por constraint UNIQUE global em labelCode)
- [x] CORRIGIDO: readLabel, associateLabel e registerNCG agora usam orderTenantId (tenant da ordem) em vez de activeTenantId (tenant do usuário) para buscar etiquetas em labelAssociations
- [x] CORRIGIDO: correção sistêmica — todas as procedures (undoLastReading, adjustQuantity, getSummary, prepareFinish, finish, closeReceivingOrder) agora usam orderTenantId (tenant da ordem) em vez de activeTenantId (tenant do usuário) para filtrar blindConferenceItems
- [x] BUG: finish falha com "Nenhum item encontrado para criar inventory" — receivingOrderItems filtrado por activeTenantId em vez de orderTenantId

## Manutenção

- [x] Procedure tRPC cleanupOrphanInventory no backend com critérios de órfão
- [x] UI de manutenção na tela de Inventário com botão de limpeza manual e relatório de resultado
- [x] Importação massiva de saldos via Excel (inventoryImportRouter): labelCode não-único, status por zona, uniqueCode=SKU-Lote, transação atômica, acesso restrito tenantId=1
- [x] CORRIGIDO: collectorPickingRouter.listOrders — Admin Global agora vê ondas de todos os tenants sem filtro de tenant; removido status inexistente 'in_progress' do filtro (apenas 'pending' e 'picking' são válidos)

## Reimpressão de Etiquetas

- [x] Backend: procedures tRPC para listar/reimprimir etiquetas de Recebimento
- [x] Backend: procedures tRPC para listar/reimprimir etiquetas de Pedidos de Separação
- [x] Backend: procedures tRPC para listar/reimprimir etiquetas de Volumes
- [x] Backend: procedures tRPC para listar/reimprimir etiquetas de Produtos
- [x] Backend: procedures tRPC para listar/reimprimir etiquetas de Endereços
- [x] Frontend: página /collector/label-reprint com menu de 5 tipos (design coletor)
- [x] Frontend: sub-páginas de cada tipo com busca e reimpressão
- [x] Frontend: card "Reimpressão de Etiquetas" na Home (/home)
- [x] Frontend: card "Reimpressão de Etiquetas" na tela /collector (coletor)
- [x] Registrar rotas no App.tsx

## Bugs

- [x] BUG CORRIGIDO: Global Admin não conseguia visualizar etiquetas — isGlobalAdmin no tenantGuard agora usa apenas role='admin' (sem restrição de tenantId)

## Reimpressão de Etiquetas de Endereços — Seleção em Lote

- [x] Backend: procedure reprintLocationsBatch (gera PDF com N etiquetas de uma vez)
- [x] Frontend: checkboxes individuais em cada linha de endereço
- [x] Frontend: botão "Selecionar Todas" (baseado no filtro atual)
- [x] Frontend: barra de ação flutuante com contador de selecionados e botão "Imprimir Selecionadas"
- [x] Frontend: preview modal antes da impressão em lote

## Etiquetas de Separação — Abas Pedidos e Ondas

- [x] Backend: procedure listPickingOrders para listar pedidos de picking com busca
- [x] Backend: procedure reprintPickingOrder para reimprimir etiqueta de pedido individual
- [x] Frontend: abas "Pedidos" e "Ondas" na WavesSubScreen
- [x] Frontend: aba Ondas lista pickingWaves (comportamento atual)
- [x] Frontend: aba Pedidos lista pickingOrders com busca por número/cliente

## Bugs

- [x] BUG CORRIGIDO: Cards de Pedidos de Separação agora exibem Nº do Pedido Cliente como título (cód. interno como subtexto)
- [x] BUG CORRIGIDO: Etiquetas de Separação (aba Pedidos) agora exibe Nº do Pedido Cliente como título

## Filtros em /products

- [x] Backend: atualizar procedure products.list para aceitar filtros tenantId, sku e category
- [x] Frontend: adicionar dropdowns/inputs de Cliente, SKU e Categoria na página Products
- [x] Frontend: aplicar filtros em tempo real (debounce) sem recarregar a página

## Importação de Produtos via Excel

- [x] Backend: instalar xlsx, criar procedure products.importFromExcel com validação e upsert
- [x] Backend: download de planilha modelo gerado no frontend (sem chamada ao servidor)
- [x] Frontend: componente ImportProductsDialog com upload drag-and-drop, preview de linhas e feedback de erros por linha
- [x] Frontend: botão "Importar Excel" na página /products
- [x] Frontend: exibir resumo pós-importação (X inseridos, Y atualizados, Z erros)
- [x] Adaptar template de importação de produtos para cabeçalhos em português

## Regras de Importação de Produtos

- [x] Backend: validar campos obrigatórios (SKU, Descrição, Unidades por Caixa, Controle Lote) e regra Controle Validade = Controle Lote
- [x] Backend: preencher automaticamente campos opcionais em branco com valores padrão
- [x] Frontend: preview destaca linhas com campos obrigatórios faltantes em vermelho
- [x] Frontend: template atualizado com cabeçalhos marcados com * para campos obrigatórios

## Design da Etiqueta de Pedido

- [x] Atualizar PDF da etiqueta de pedido: logo Med@x esquerda, Nº Pedido/Cliente/Destinatário direita, barcode Code-128 centralizado na parte inferior
- [x] Redesign etiqueta de pedido: fundo cinza claro, borda arredondada, marca d'água Med@x repetida, ícone caminhão/entrega antes do Destinatário, barcode grande centralizado

## Auditoria Global Admin - Filtros de Tenant

- [x] BUG CORRIGIDO: /collector/stage e /stage - stageRouter corrigido para passar null como tenantId para Global Admin
- [x] Auditoria completa: waveRouter, shippingRouter, reportsRouter, stockRouter, blindConferenceRouter, routers.ts (picking/waves) já tratavam Global Admin corretamente
- [x] stageRouter: getOrderForStage, startStageCheck, getActiveStageCheck, getStageCheckHistory, cancelStageCheck corrigidos

## Bugs

- [x] BUG CORRIGIDO: /collector/stage - erro "Já existe uma conferência em andamento para este pedido" — sistema de lock com timeout implementado

## Bugs

- [x] BUG CORRIGIDO: Stage — erro "Produto não pertence ao tenant atual" ao bipar etiqueta na conferência. recordStageItem agora usa o tenantId do stageCheck (pedido) em vez de ctx.effectiveTenantId (usuário logado)

## Bugs

- [x] BUG CORRIGIDO: /collector/label-reprint — Etiquetas de Volumes agora busca stageChecks por customerOrderNumber. Novas procedures: listStageVolumes e reprintStageVolume. Operador informa qtd de volumes ao reimprimir.

- [x] BUG CORRIGIDO: Importação de NF-e — xml2js retornava número 0 (int) para <serie>0</serie> e <nNF>66666</nNF>. Corrigido com String() no nfeParser.ts
- [x] BUG CORRIGIDO: Importação de NF-e — chave de acesso extraída com 45 chars em vez de 44 (varchar(44) no banco). Corrigido com replace(/^NFe/) + slice(-44) no nfeParser.ts

## Design Etiqueta de Volume (Stage)

- [x] Ajustar layout: linha divisória em y=70px, logo 2x maior, barcode 60% maior, tamanho 10x5cm

- [x] Redesenhar PDF de etiquetas de volume: logo Med@x esquerda, barcode direita, linha divisória, Destinatário/Pedido/Cliente/Volume bold (15cm x 7.5cm)

## Trava de Concorrência e Timeout — Stage

- [x] Schema: adicionados campos lockedByUserId, lockedByName, lastActivityAt em stageChecks
- [x] Backend: startStageCheck verifica lock ativo (< 10min) e bloqueia com nome do usuário
- [x] Backend: startStageCheck assume lock após timeout (>= 10min) para mesmo tenant
- [x] Backend: procedure stageHeartbeat atualiza lastActivityAt a cada 30s
- [x] Backend: procedure releaseStageLock libera o lock (saída voluntária)
- [x] Backend: procedure forceReleaseStageLock para Global Admin liberar qualquer lock
- [x] Frontend: alerta âmbar "Pedido sendo conferido por [Nome]" quando bloqueado
- [x] Frontend: modal de confirmação ao sair (botão Abandonar + beforeunload)
- [x] Frontend: heartbeat automático a cada 30s enquanto na tela de conferência
- [x] Frontend: botão "Abandonar" com modal de confirmação (libera lock voluntariamente)

## Bugs

- [x] BUG CORRIGIDO: Importação de saldos de estoque — múltiplas linhas com mesmo SKU+Lote+Endereço+Tenant no template faziam a segunda linha sobrescrever a quantidade da primeira (UPDATE quantity = row.quantity). Corrigido em inventoryImportRouter.ts: UPDATE agora acumula (existing.quantity + row.quantity). Afetava M03-03-09 (-24), M03-01-11 (-154), M03-02-37 (-250).

## Bugs

- [x] BUG CORRIGIDO: /products — INSERT/UPDATE de produto: booleanos requiresBatchControl/requiresExpiryControl agora convertidos para 0/1 explicitamente (MySQL/TiDB rejeita string "true"/"false" em tinyint(1))

## Importação de Saldos — Melhorias

- [x] Adicionar coluna "Descrição" ao template modelo de importação de saldos
- [x] Auto-cadastro de produto durante importação: se SKU não existir, criar produto com SKU + Descrição + tenantId automaticamente (retorna productsCreated no resultado)

## Bugs

- [x] BUG CORRIGIDO: Movimentação REC → STORAGE — Global Admin (effectiveTenantId=null) não resolvia tenantId do inventory corretamente. Corrigido em stockRouter.ts (usa input.tenantId como fallback) e movements.ts (não lança erro se tenantId ainda null após fallbacks)
- [x] BUG CORRIGIDO (definitivo): Movimentação de estoque — Global Admin (tenantId=1) filtrava inventory por tenantId=1, mas inventory pertencia a tenantId=30001. Corrigido em stockRouter.ts: Global Admin sem input.tenantId explícito passa null para registerMovement, que usa sql`1=1` no filtro de tenant (sem restrição de tenant)

## Bugs

- [x] BUG CORRIGIDO: /shipping — ao excluir romanéio, ondas (pickingWaves) agora revertem para 'staged' (em vez de permanecer 'picked'). NFs permanecem corretamente em 'linked' (vinculadas ao pedido, mas fora do romanéio). Adicionado import de pickingWaves no shippingRouter.ts

## Bugs

- [x] BUG CORRIGIDO: /shipping — ao excluir romanéio, pickingOrders agora ficam com status='invoiced' + shippingStatus='invoice_linked' (NF vinculada, fora do romanéio, pronto para re-expedição)

## Bugs

- [x] BUG CORRIGIDO: /shipping aba Pedidos — filtro agora inclui status 'staged' e 'invoiced' (inArray). Pedidos com NF vinculada fora de romanéio aparecem corretamente na listagem
## Rastreabilidade ANVISA — conversionSource obrigatório em inventoryMovements
- [x] routers.ts (nfe.import): conversionSource inicializado como "uCom" (nunca "none") — ANVISA
- [x] server/modules/receiving.ts: conversionSource: "uCom" adicionado (moveToQuarantine)
- [x] server/modules/conference.ts: conversionSource: "uCom" adicionado (checkAndUpdateOrderStatus)
- [x] server/preallocation.ts: conversionSource: "uCom" adicionado (executeAddressing)
- [x] server/stage.ts: conversionSource: "manual" adicionado (movimentação após Stage)
- [x] server/modules/picking.ts: conversionSource: "manual" adicionado (confirmPicking)
- [x] server/shippingRouter.ts: conversionSource: "manual" adicionado (baixa de estoque + estorno)
- [x] server/movements.ts: conversionSource: "manual" adicionado (ajuste manual)
## Desbloqueio Automático de ORs após Cadastro de Fator UOM
- [x] Backend: função unlockBlockedReceivingOrders em unitConversionRouter.ts
- [x] Backend: chamar unlockBlockedReceivingOrders após upsertConversion e replicateConversion
- [x] Backend: procedure tRPC listBlockedReceivingOrders para consultar ORs bloqueadas
- [x] Frontend: badge "Aguardando UOM" (vermelho) nas ORs com status pending_unit_setup
- [x] Frontend: opção de filtro "Aguardando UOM" no Select de status em Receiving.tsx
- [x] Frontend: toast com contagem de ORs desbloqueadas após salvar fator em UnitConversion.tsx
- [x] Frontend: invalidar query de receivingOrders após salvar fator (para atualizar badges)

## Ação 2 — Motor de Picking UOM-Aware
- [x] Criar função resolvePickingFactor em server/modules/picking.ts
- [x] Bloquear reserva quando resultado da conversão gerar fração (erro com mensagem clara)
- [x] Registrar log de auditoria com fator utilizado (factorToBase, source, unitCode, tenant)
- [x] Atualizar clientPortalRouter.ts (2 pontos: criação manual e importação CSV) para usar resolvePickingFactor
- [x] Atualizar routers.ts (WMS Admin) para usar resolvePickingFactor
- [x] Documentar limitação de reservedQuantity: int no schema.ts com comentário de auditoria
- [x] Testes Vitest: 13 testes cobrindo CA-1, CA-2, CA-3, CA-4 (todos passando)

## Ação 3 — Seletores de Unidade Dinâmicos
- [x] Verificar procedure getPackagingLevels no unitConversionRouter.ts
- [x] Criar hook usePackagingLevels em client/src/hooks/usePackagingLevels.ts
- [x] Atualizar CreateProductDialog.tsx: seletor de unidade dinâmico
- [x] Atualizar Products.tsx: seletor de unidade dinâmico (edição inline)
- [x] Atualizar PickingOrders.tsx: seletores de unidade dinâmicos (criação e edição)
- [x] Atualizar ClientPortalNewOrder.tsx: seletor de unidade dinâmico
- [x] Inserir dados padrão em packagingLevels (10 níveis: UN, PCT, CX, FD, PL, KG, G, MG, L, ML)
- [x] Fallback estático garantido quando banco ainda não tem dados

## Bug: Validação de Data de Validade (expiryDate)
- [ ] Backend: validar expiryDate como data real antes do INSERT em labelAssociations (rejeitar datas como 2030-02-30)
- [ ] Frontend: exibir mensagem de erro clara quando data de validade for inválida

## Bug: Desfazer Última — Conferência Cega
- [x] Corrigir undoLastScan: substituir lastSuccessfulItem por pilha LIFO readStack em BlindCheckModal.tsx — undo agora remove a leitura mais recente cronologicamente e permite undos consecutivos

## Bug: UI BlindCheckModal — 3 ajustes
- [x] Aumentar largura do dialog principal da Conferência Cega (max-w-5xl w-[95vw])
- [x] Corrigir botão Editar: implementar diálogo de ajuste de quantidade com adjustQuantity mutation e campo de motivo obrigatório
- [x] Corrigir largura do dialog de Finalizar Conferência (max-w-4xl w-[95vw])

## Bug: Coluna Esperado — Unidade Errada no Finalizar Conferência
- [x] Corrigir getSummary para retornar expectedQuantity na unidade correta (uCom da NF-e) com o código da unidade
- [x] Corrigir frontend para exibir a unidade correta (não hardcoded "cx") e calcular divergência na mesma unidade

## Bug: Esperado ainda em branco após correção do JOIN por batch
- [ ] Diagnosticar mismatch batch NULL vs "" no JOIN getSummary e corrigir condição robusta

## Bug: Esperado mostra quantidade errada (24 CX em vez de 200 CX para LUVA)
- [ ] Investigar como expectedQuantity é gravado na importação NF-e (em UN convertidas ou em CX originais)
- [ ] Corrigir exibição: mostrar quantidade na unidade comercial da NF-e (uCom/qCom)

## Apagar Registro de Conferência de Item Individual
- [x] Backend: procedure deleteConferenceItem — apaga blindConferenceItem e reverte labelAssociation para status anterior
- [x] Frontend: botão de apagar item na lista de itens conferidos com diálogo de confirmação
- [x] Testes: vitest para deleteConferenceItem

## Bug: Erro ao cadastrar alias duplicado em /unit-conversion
- [x] Corrigir createAlias para verificar duplicata antes de inserir e lançar TRPCError CONFLICT com mensagem clara

## UX /unit-conversion: Header
- [x] Aplicar padrão de cores de título/subtítulo (título branco, subtítulo cinza claro)
- [x] Adicionar botão Voltar no topo da página

## Bug: Modal de resumo da OR no CollectorReceiving mostra receivedQuantity = 0
- [ ] Diagnosticar por que receivedQuantity está 0 no modal mesmo após conferência cega
- [ ] Corrigir a query/procedure para retornar receivedQuantity correto

## Bug: Modal de resumo da OR mostra receivedQuantity = 0
- [x] Corrigir prepareFinish para calcular receivedQuantity a partir de blindConferenceItems.unitsRead
- [x] Corrigir getItems (usado em /receiving) para usar a mesma lógica quando há sessão ativa

## Bug: blindConferenceAdjustments — tabela ausente no banco
- [x] Criar tabela blindConferenceAdjustments no banco via SQL migration

## Bug: Fila de Pendências UOM vazia para Global Admin
- [x] Corrigir procedure getPendingUOM para retornar pendências de todos os tenants quando Global Admin

## Bug: Over-receiving falso positivo no associateLabel
- [x] Corrigir comparação de unidades no over-receiving check (expectedQuantity em UN vs packagesRead em CX)

## Bug: finish falha com labelCode ausente para batch=null
- [x] Corrigir validação do finish para aceitar itens com batch=null e labelCode gerado corretamente

## Bug: Relatório de estoque com linhas em branco (SKU/Produto/Lote/Qtd vazios) e status Expirado incorreto
- [x] Corrigir exportToExcel para filtrar linhas sem produto (endereços vazios do LEFT JOIN) antes de adicionar ao Excel
- [x] Status "Expirado" era resultado do LEFT JOIN com endereço sem inventory (pos.status=null) — filtro de productId != null resolve

## Bug: Posições de Estoque exibe endereços vazios (sem produto) com status Ocupado
- [x] Corrigir getInventoryPositions para filtrar productId IS NOT NULL quando há filtro de search ou batch
- [x] Corrigir status do endereço REC-01-A no banco (0 linhas afetadas — endereço já estava correto ou não existe)

## Feature: Sincronização de Status de Endereços de Armazém
- [x] Backend: procedure syncLocationStatus que atualiza warehouseLocations.status para 'available' em endereços sem inventory com quantity > 0
- [x] Backend: procedure getLocationStatusSummary para exibir resumo antes de executar a sincronização
- [x] Frontend: seção de Manutenção com botão para acionar sincronização (com confirmação e relatório de resultado)
- [x] Testes: vitest para syncLocationStatus

## Bug: Double Counting no associateLabel (Over-receiving com fator de conversão)

- [x] Investigar lógica de associateLabel e validação de over-receiving em receiving.ts
- [x] Implementar idempotência: verificar se uniqueCode já está vinculado antes de somar quantidade
- [x] Ajustar motor de validação: tratar etiqueta já registrada como atualização de metadados, não nova entrada
- [x] Melhorar mensagem de erro com unidade original (ex: "1 CX (6 un)")
- [x] Testes vitest: associar etiqueta com fator não dispara erro quando saldo é atingido
- [x] Testes vitest: saldo em inventory sem duplicação após associação
- [x] Testes vitest: status da receivingOrder muda para 'Conferido' após última associação

## Bug: Falha na Persistência de Saldo Pós-Recebimento (Fluxo UOM)
- [x] Investigar procedure finish do blindConferenceRouter e fluxo de inserção no inventory
- [x] Verificar se há erros silenciosos em updateInventoryBalance ou campos NULL obrigatórios
- [x] Corrigir persistência de saldo no endereço REC após finalização da conferência cega
- [x] Registrar movimento em inventoryMovements com campos UOM (conversionSource, originalQty)
- [x] Testes vitest: saldo aparece em /stock no endereço REC após finalização
- [x] Testes vitest: inventoryMovements registrado com campos de rastreabilidade UOM

## Bug: Visibilidade da unitPendingQueue para Global Admin
- [x] Corrigir listPendingUnits: Global Admin vê todos os tenants, usuário comum vê apenas o seu
- [x] Exibir tenantName na lista de pendências para o Admin identificar o cliente
- [x] Corrigir mutations de resolução de pendência para salvar no tenantId correto do cliente
- [x] Corrigir filtros de busca (fornecedor, SKU) para funcionar em toda a base para o Admin
- [x] Testes vitest: Global Admin vê itens de todos os tenants
- [x] Testes vitest: usuário comum vê apenas itens do seu tenant

## Bug: Falso positivo de over-receiving no associateLabel (unidades base vs. XML)
- [ ] Corrigir validação: expectedQty e alreadyConferred devem estar na mesma unidade base
- [ ] Garantir que a comparação usa a quantidade base convertida (não a quantidade XML)
- [ ] Testes vitest para o cenário: 1 CX = 6 UN, expectedQty = 6 UN, associar 1 CX

## Bug: Sumiço de Itens na unitPendingQueue
- [x] Ao tratar um item de uma NF-e com múltiplas pendências, os demais itens devem permanecer visíveis e editáveis na fila
- [x] O contador de pendências deve decrementar apenas em 1 unidade por vez
- [x] A NF-e só deve ser liberada para recebimento quando todos os itens individuais da lista forem resolvidos

## Bug: Saldo Insuficiente na Movimentação (inventory não encontrado)
- [ ] Movimentação deve encontrar o saldo correto no inventory após recebimento
- [ ] Query de saldo deve usar os filtros corretos (tenantId, locationId, productId)

## Bug: Lote e Validade não propagados para inventory no finish
- [x] Corrigir finish: propagar batch, expiryDate E labelCode da labelAssociation para inventory
- [x] Garantir que inventoryMovements também receba batch e expiryDate corretos
- [x] Testes vitest: inventory criado com batch e expiryDate corretos após finish

## Feature: Colunas Lote e Validade em /stock
- [x] Verificar que a query getStockPositions retorna batch e expiryDate
- [x] Adicionar colunas Lote e Validade na tabela de Posições de Estoque
- [x] Formatar expiryDate no padrão dd/mm/aaaa

## Bug: Timezone na Data de Validade
- [x] Corrigir bug de timezone: banco armazena 2030-10-20 mas tela exibe 18/10/2030 (2 dias de diferença)
- [x] Garantir que expiryDate seja salva e exibida sem deslocamento de fuso horário
- [x] Flexibilização de Vínculo NF x Pedido: fallback sem lote em validateInvoiceBinding (shipping.ts) com FEFO e log 'Vínculo Simplificado (Sem Lote)'
- [x] BUG CORRIGIDO: Produtos com estoque zerado após expedição agora são removidos do inventory (DELETE automático no confirmShipment + limpeza imediata no banco)

## Importação Legada (Migração)

- [x] BUG CORRIGIDO: importLegacy usava protectedProcedure sem tenantProcedure — Global Admin bloqueado
- [x] BUG CORRIGIDO: busca de tenant suporta formato "(30001) AESC - Mãe de Deus" extraindo ID numérico
- [x] IMPLEMENTADO: consolidação por SKU+Lote+Endereço na importLegacy — linhas duplicadas são somadas antes de criar pickingOrderItems/pickingAllocations
- [x] BUG CORRIGIDO: waveLogic.ts — filtro de zonas especiais (NOT IN) agora usa IS NULL OR NOT IN para não excluir localizações sem zona cadastrada (LEFT JOIN retornava NULL)
- [x] BUG CORRIGIDO: waveLogic.ts — removido LEFT JOIN com inventory que multiplicava linhas quando havia múltiplos registros de inventory por produto+endereço+lote

## Bug: Pedido finaliza ao separar o primeiro item

- [x] Investigar lógica de atualização de status no confirmPicking / collectorPickingRouter
- [x] Corrigir condição de finalização prematura do pedido (getRoute, complete, pause, reportLocationProblem, reportProductProblem agora usam waveId corretamente)

## Bugs reportados em /picking/execute/300001

- [x] BUG: scanProduct rejeita labelCode "0633930225" para SKU 59188 — correção: buscar labelCode na tabela sem filtro de produto; aceitar códigos não cadastrados
- [x] BUG: Chaves React duplicadas (key=10) na lista de itens — correção: usar key={`qty-${idx}-${value}`} nos botões rápidos do PickingStepModal

## Bug: Segregação de Tenants

- [x] BUG CRÍTICO: labelAssociations agora filtrada pelo tenantId da tabela pickingOrders (via waveItem.pickingOrderId), não pelo tenantId do usuário logado
- [ ] Auditar todas as queries críticas (labelAssociations, products, inventory, pickingWaveItems) para garantir filtro de tenantId correto

## Bug: /stage/check — Produto não pertence ao tenant do pedido

- [x] BUG: Validação de tenant corrigida em /stage/check — labelAssociations agora filtrada pelo tenantId do stageCheck (pedido), não do usuário logado

## Feature: Bloqueio de Conferência e Solicitação de Fator UOM

- [x] Backend: refatorar scanProduct (collectorPickingRouter) para retornar requiresUomInput quando unitsPerBox for nulo/zero
- [x] Backend: mutation confirmUomFactor salva fator em products.unitsPerBox, labelAssociations e unitPendingQueue, e processa a bipagem
- [x] Frontend CollectorPicking: tela uom_input exibe modal laranja com input do fator, bloqueia avanço até confirmar
- [x] Quantidade total separada reflete o fator informado (1 bipagem × N unidades = N separados)
- [ ] Frontend WaveExecution: modal de input UOM quando PENDING_CONVERSION (a implementar se necessário)

## Feature: Caixa Fracionada (UOM Split) no Coletor

- [x] Backend: scanProduct retorna requiresFractionConfirm quando unitsPerBox > saldo restante
- [x] Frontend: tela fraction_confirm com alerta amarelo, input manual e botões rápidos
- [x] Validação: quantidade manual bloqueada se > saldo restante
- [x] Rastreabilidade: usa recordFractionalQuantity que já registra em inventoryMovements

## Bug: /collector/stage — Etiqueta filtrada pelo tenantId do usuário

- [x] BUG: stage.ts busca labelAssociations pelo tenantId do usuário logado em vez do tenantId do pedido (stageCheck)

## Bug: labelAssociations criadas com tenantId do usuário

- [x] BUG ORIGEM: inserts em labelAssociations corrigidos em collectorPickingRouter, labelRouter e waveRouter para usar tenantId do pedido
- [x] Reverter fallback incorreto adicionado no stage.ts

## Auditoria: confirmUomFactor — tenantId do pedido

- [x] Auditado e corrigido: confirmUomFactor agora usa tenantId do pedido (via pickingOrders) no insert de unitPendingQueue

## Varredura Sistêmica: tenantId do usuário vs. tenantId da operação

- [x] Mapeadas todas as ocorrências de ctx.user.tenantId em inserts/updates
- [x] unitConversionRouter.ts: listAliases, createAlias e setConversionFactor corrigidos para usar tenantId do tenant alvo, com bloqueio para usuários normais
- [x] waveRouter.ts cancelWithRevert: corrigido para usar wave.tenantId (da onda) em vez de ctx.user.tenantId; admin global pode cancelar qualquer onda
- [x] receiving.ts: já correto (usa order[0].tenantId)
- [x] inventoryImportRouter.ts: já correto (usa row.tenantId do CSV)
- [x] stockRouter.ts: já correto (usa effectiveTenantId)
- [x] Usuário normal bloqueado de injetar targetTenantId diferente do seu em createAlias e setConversionFactor

## Bugs

- [x] BUG CORRIGIDO: Após desvincular NF do pedido, o pedido permanece com status "invoiced" em vez de retornar para "picked". A procedure unlinkInvoice agora reverte status para 'picked' e shippingStatus para 'awaiting_invoice' simultaneamente.

## Motor de De/Para — Cross-Reference de SKU na Expedição

- [x] Schema: adicionar coluna internalCode em products com UNIQUE(tenantId, internalCode)
- [x] Migration: executar ALTER TABLE no TiDB Cloud
- [x] Backend: refatorar linkInvoiceToOrder com fallback em cascata (sku → internalCode → exceção com lista de não-identificados)
- [x] Backend: procedure shipping.confirmSkuMapping para persistir internalCode no produto e reprocessar vínculo
- [x] Backend: procedure shipping.getOrderItemsForMapping para listar itens do pedido (select do modal)
- [x] Backend: audit log de vínculo manual em inventoryMovements.notes
- [x] Frontend: capturar erro de SKUs não identificados e abrir Modal de Vínculo Manual
- [x] Frontend: Modal lista itens da NF não identificados com Select dos itens do pedido
- [x] Frontend: ao confirmar, chamar confirmSkuMapping e reprocessar linkInvoiceToOrder
- [x] Testes: vitest para fallback em cascata (match direto, match internalCode, exceção) — 9/9 passando

- [x] BUG CORRIGIDO: Inventário exibia endereços/produtos com quantidade zerada. Corrigido em server/inventory.ts (LEFT JOIN e INNER JOIN) e server/modules/inventory.ts. 3 registros zerados removidos do banco.

- [x] BUG CORRIGIDO: Endereços com status "Ocupado" mas sem estoque. Corrigido em inventory-sync.ts (após delete de registro zerado), shippingRouter.ts (baixa de expedição e reversão de picking). Banco corrigido via UPDATE. TypeScript: 0 erros.

- [x] Tornar campo "Qtd por Caixa" (unitsPerBox) opcional na importação de produtos via planilha Excel

- [x] BUG CORRIGIDO: Botão "Importar NF-e" em /nfe-import estava sempre desabilitado. Causa: condição usava !xmlContent (assíncrono) antes do FileReader.onload disparar. Corrigido: adicionado estado isReadingFile, botão habilita após leitura completa do arquivo.

- [x] BUG CORRIGIDO: Global Admin (id=1) aparecia como tenant comum em todos os Selects do sistema. Corrigido na procedure tenants.list adicionando .where(ne(tenants.id, 1)) — filtro aplicado globalmente em todos os 10+ componentes que usam a lista.

- [x] BUG: "Não foi possível ler o arquivo XML" — FileReader retorna conteúdo vazio ao tentar importar NF-e

- [x] BUG UI CORRIGIDO: Campo "Cód. Interno" (internalCode) agora aparece como campo separado no formulário de cadastro e edição de produto. SKU voltou a ser "SKU (Cód. Fornecedor)". Backend (products.create e products.update) aceita internalCode.

- [x] Adicionada coluna "Cód. Interno" no template de importação de produtos (Excel modelo)
- [x] Validação do importFromExcel ajustada: produto deve ter pelo menos SKU ou Cód. Interno (não ambos obrigatórios). Busca de duplicata usa SKU quando informado, ou internalCode como fallback.

- [x] BUG CORRIGIDO: Importação de produtos via Excel falhava com "Failed query: insert into products" por conflito de UNIQUE(tenantId, internalCode). Corrigido: upsert agora busca por SKU primeiro, depois por internalCode; sku usa internalCode como fallback quando vazio.

## Refatoração Picking — Exibição e Busca de SKUs

- [x] Backend: nova procedure products.listWithStock com JOIN inventory, filtro saldo > 0 e status available
- [x] Backend: busca multicritério OR(sku, internalCode, description LIKE %query%)
- [x] Frontend: PickingOrders.tsx usa products.listWithStock em vez de products.list
- [x] Frontend: ProductCombobox exibe "{internalCode} - {descrição}" com fallback para "{sku} - {descrição}"
- [x] Frontend: searchTerms inclui sku, internalCode e description para busca multicritério local
- [x] Frontend: placeholder "Buscar por SKU, Cód. Interno ou Descrição..."
- [x] Picking: lista de seleção de produtos exibe apenas produtos com saldo de estoque disponível (INNER JOIN com inventory)

## Índices de Performance — Varredura Completa

- [x] Auditoria completa de todas as tabelas do schema
- [x] SQL migration aplicada no banco (CREATE INDEX IF NOT EXISTS em todas as tabelas)
- [x] Schema Drizzle sincronizado: users, systemUsers, contracts, products, warehouseLocations, receivingOrders, receivingOrderItems, inventory, inventoryMovements, pickingOrders, pickingOrderItems, pickingWaves, pickingWaveItems, pickingAllocations, labelAssociations, blindConferenceSessions, blindConferenceItems, stageChecks, invoices, shipmentManifests, shipmentManifestItems, unitPendingQueue
- [x] Comentários "tenantId = dono da operação (cliente)" adicionados em todos os índices relevantes
- [x] TypeScript: 0 erros após alterações

## Bug — Dropdown de Cliente em /users

- [x] BUG CORRIGIDO: opção "★ Global Admin (Med@x)" (tenantId=1) adicionada nos dropdowns de cliente nos modais de criação e edição de usuário em /users

## Bug — Coletor Picking: Fator de Conversão UOM (unitsPerBox)

- [x] Backend: processScan busca labelAssociations.unitsPerBox (1º) > products.unitsPerBox (2º) > solicitar ao operador (3º)
- [x] Backend: validação de caixa fracionada já existente (unitsPerBox > remaining) mantida
- [x] Backend: retorna conversionFactor e uomSource na resposta do processScan
- [x] Frontend: exibe badge "Lido: 1 emb × N un = +N unidades adicionadas" após cada bipagem com fator > 1
- [x] Frontend: toast diferenciado "Lido: 1 emb × N un = +N un" quando conversionFactor > 1
- [x] TypeScript: 0 erros após correção com type assertion no discriminated union

## Bug — Coletor Stage: Fator de Conversão UOM (unitsPerBox)

- [x] Backend: stage.ts recordStageItem busca labelAssociations.unitsPerBox (1º) > products.unitsPerBox (2º) > fallback 1 (3º)
- [x] Backend: retorna conversionFactor e uomSource na resposta do scan de Stage
- [x] Frontend: CollectorStage exibe badge "Lido: 1 emb × N un" e toast diferenciado quando conversionFactor > 1
- [x] TypeScript: 0 erros após alterações

## Bug — Shipping: Normalização UOM no Vínculo NF x Pedido

- [x] Backend: shippingRouter.linkInvoiceToOrder carrega loadConversionContext(tenantId) e normaliza NF para unidade base
- [x] Backend: Grupo 1 (com lote) e Grupo 2 (sem lote) usam resolveUnit + applyConversion antes de comparar
- [x] Backend: se unidade não tem fator cadastrado, retorna JSON {type: UOM_CONVERSION_REQUIRED} para o frontend
- [x] Backend: log de auditoria "[Shipping Audit] SKU X: vínculo aprovado via conversão UOM" gravado no console
- [x] Frontend: modal "Fator de Conversão Pendente" exibido com preview do cálculo e validação visual
- [x] Frontend: botão "Salvar Fator e Vincular NF" salva via upsertConversion e retenta o vínculo automaticamente
- [x] TypeScript: 0 erros após alterações

## Bug — Romaneio: Finalização não dá baixa no estoque

- [x] BUG CORRIGIDO: finalizeManifest reescrito para buscar inventory na zona EXP por warehouseZones.code='EXP' e decrementar quantity + zerar reservedQuantity
- [x] Baixa parcial: atualiza quantity e reservedQuantity; Baixa total: remove registro e sincroniza status do endereço
- [x] Movimentação de saída gravada em inventoryMovements com referenceType='shipment_manifest' para rastreabilidade ANVISA
- [x] Seção redundante de 'liberação de reservas' removida (estava causando o bug)
- [x] TypeScript: 0 erros após correção

## Bug — Filtro de Status de Endereços (/inventory/locations)

- [x] Backend: schema Zod usa z.preprocess para normalizar string/array; enum inclui 'vacant','available','occupied','blocked','counting','quarantine'
- [x] Backend: 'vacant' separado dos status reais de warehouseLocations; LEFT JOIN + WHERE inventory.id IS NULL quando onlyVacantFilter
- [x] Backend: interface InventoryFilters atualizada com semântica correta (vacant=Livre, available=Disponível, occupied=Ocupado)
- [x] Frontend: MultiSelect envia 'vacant' (não 'livre') para o backend
- [x] Frontend: badge 'Livre' exibido quando locationStatus='available' e productId=null (endereço sem inventory)
- [x] TypeScript: 0 erros após alterações

## Correção getRoute + Consolidação de Picking (Ondas AESC)

- [x] Backend: getRoute já era context-aware (trata input.pickingOrderId como waveId internamente)
- [x] Backend: startOrResume e getRoute consolidam itens por [productId + batch] no mesmo endereço (somar qty em vez de duplicar linhas)
- [x] Backend: complete já verificava todas as alocações da onda antes de finalizar
- [x] Frontend: advanceLocation verifica tarefas pendentes na rota antes de ir para all_done (proteção contra finalização prematura)
- [x] Frontend: volta ao primeiro endereço pendente se ainda houver itens não coletados na onda
- [x] TypeScript: 0 erros após alterações

## Bug — Fila de Pendências UOM: Global Admin não vê pendências de outros tenants

- [x] Causa raiz: frontend passava tenantId=1 explicitamente na query; backend aplicava eq(tenantId, 1) e não encontrava pendências dos clientes
- [x] Correção: quando isGlobalAdmin (tenantId===1), frontend passa tenantId: undefined; backend usa showAllTenants=true e retorna tudo
- [x] Frontend: coluna "Cliente" exibida condicionalmente na tabela quando isGlobalAdmin=true
- [x] TypeScript: 0 erros

## Módulo Intra-Hospitalar — Rastreabilidade Last Mile Interna

- [x] Schema: tabelas deliveryPoints e deliveryLogs criadas no Drizzle com todos os campos (floor, notes, isActive)
- [x] Migration SQL aplicada no banco de dados
- [x] Backend: intraHospitalRouter registrado no router principal com CRUD de deliveryPoints
- [x] Backend: procedure registerCheckpoint com validação de fluxo (RECEIVE_COMPLETE bloqueado sem ARRIVED_UNIT anterior)
- [x] Backend: procedure getOrderTimeline com lead-time entre checkpoints
- [x] Backend: procedure batchRegisterCheckpoint para múltiplos pedidos em um ponto
- [x] Backend: procedure getTransitReport com tempo médio por etapa (SLA interno)
- [x] Coletor: /collector/intra-hospitalar com Scan&Go (seleção de ponto → batch de pedidos)
- [x] Coletor: lógica de status automático por tipo de ponto (DOCK → ARRIVED_COMPLEX, PHARMACY → ARRIVED_UNIT)
- [x] Coletor: validação de fluxo — alerta se pedido chegar em farmácia sem ter passado pela doca
- [x] Coletor: botão "Intra-Hospitalar" (rosa) adicionado no CollectorHome
- [x] Interface: tela /intra-hospitalar com abas Pontos de Entrega, Monitorização e Relatório de Lead-Time
- [x] Interface: timeline vertical de rastreio no detalhe do pedido (aba "Rastreio Interno")
- [x] Navegação: item "Intra-Hospitalar" com ícone Activity no DashboardLayout sidebar
- [x] Rotas: /intra-hospitalar e /collector/intra-hospitalar registradas no App.tsx
- [x] Multi-tenancy: todos os endpoints filtram por tenantId do usuário autenticado
- [x] TypeScript: 0 erros após todas as alterações

## Intra-Hospitalar — Campo Cliente no Cadastro de Pontos de Entrega

- [ ] Frontend: campo "Cliente" (Select de tenants) no modal de criação/edição de DeliveryPoints, visível apenas para Global Admin (tenantId=1)
- [ ] Backend: procedure createPoint e updatePoint devem aceitar tenantId explícito quando chamado pelo Global Admin

## Dashboard de Rastreabilidade Intra-Hospitalar

- [x] Procedure `listOrdersWithCheckpoints` no intraHospitalRouter (pedidos + todos os logs de entrega)
- [x] Procedure `getOrderTrackingDetail` para detalhe de um pedido específico
- [x] Página IntraHospitalarTracking.tsx com tabela de pedidos e timeline de checkpoints
- [x] Filtros: por status atual, por ponto de entrega, por data, por número do pedido
- [x] Timeline visual por pedido (cada checkpoint com data/hora, ponto, responsável)
- [x] Indicador de status atual com badge colorido
- [x] Link para o dashboard na página IntraHospitalar.tsx
- [x] Rota /intra-hospitalar/rastreabilidade no App.tsx

## Bug — Inconsistência de Ponto de Entrega Intra-Hospitalar

- [x] BUG: batchRegisterCheckpoint permite registrar checkpoints em farmácias diferentes para o mesmo pedido (ARRIVED_UNIT em FARMÁCIA 1 + RECEIVING_STARTED em FARMÁCIA 3)
- [x] Regra: uma vez que o pedido registrou ARRIVED_UNIT em uma farmácia, todos os checkpoints subsequentes (RECEIVING_STARTED, RECEIVE_COMPLETE) devem ser na mesma farmácia
- [x] Regra: DEPARTED_TO_UNIT deve ser registrado na mesma doca que ARRIVED_COMPLEX
- [x] Implementar validação de consistência de ponto em batchRegisterCheckpoint e registerCheckpoint
- [x] Mensagem de erro clara: "Pedido X já está vinculado à FARMÁCIA Y. Não é possível registrar em FARMÁCIA Z."

## Dashboard de Performance Intra-Hospitalar (Analytics)
- [x] View SQL v_delivery_analytics com colunas de tempo de ciclo
- [x] Índices otimizados em delivery_logs (orderId, status, tenantId)
- [x] Router intraHospitalarAnalytics: getLeadTimeStats
- [x] Router intraHospitalarAnalytics: getWipStatus
- [x] Router intraHospitalarAnalytics: getAlerts (SLA)
- [x] Página IntraHospitalarDashboard.tsx com cards KPI
- [x] Gráfico de barras: tempo médio por farmácia
- [x] Gráfico de área: volume de chegadas na doca por hora
- [x] Rota /intra-hospitalar/dashboard registrada no App.tsx
- [x] Atualização automática via refetchInterval (React Query)
- [x] Filtro por tenantId em todas as queries
- [x] Suporte a Global Admin (visualizar qualquer tenant)

## Template de Importação de Saldos — Melhorias
- [x] Aba oculta "Clientes" no template XLSX com lista de clientes cadastrados (via procedure getTenantsForTemplate)
- [x] Validação de lista Excel na coluna "Cliente" usando a aba oculta como fonte
- [x] Download de relatório de erros em Excel após importação com erros parciais

## Correção de Dados do Romaneio
- [x] Adicionar coluna totalVolumes na tabela stageChecks (migration aplicada)
- [x] Salvar totalVolumes no stageChecks ao gerar etiquetas de volumes (CollectorStage e StageCheck)
- [x] Corrigir generateManifestPDF: volumes buscados do stageChecks.totalVolumes (Stage), fallback proporcional da NF
- [x] Corrigir generateManifestPDF: peso bruto dividido proporcionalmente entre pedidos que compartilham a mesma NF
- [x] Corrigir createManifest: totalVolumes calculado a partir do Stage (não da NF)
- [x] ManifestPrint: usar totalWeight retornado pelo backend para o rodapé do romaneio

## Correção de Importação de Endereços via Excel
- [x] Corrigir parser de importação: normalizar cabeçalhos com quebras de linha e texto entre parênteses (ex: "Zona\n(obrigatório)" -> "zona")
- [x] Corrigir busca de zona: tentar valor original (ex: "STORAGE") antes de padStart numérico

## Correção de Importação de Saldos via Excel
- [x] Corrigir normalizeHeader no InventoryImport.tsx: remover quebras de linha e texto entre parênteses (ex: "SKU\n(obrigatório)" -> "sku")
- [x] Adicionar "etiqueta/lpn" na lista de lookup do campo labelCode no mapRow

## Correção de Dados de Recebimentos Agendados (16/04/2026)
- [x] Diagnosticar causa raiz: limpeza de produtos deixou receivingOrderItems com productId inválido (390001 - SABONETE KLEENEX ESPUMA)
- [x] Banco limpo: ORs incorretas já foram removidas durante a limpeza de homologação
- [x] Adicionar proteção no código de importação: erro explícito se produto não for encontrado após INSERT (evita vinculação silenciosa a produto errado)

## Correção do Bug de EAN "SEM GTIN" na Importação de NF-e (16/04/2026)
- [x] Causa raiz: parser retornava "SEM GTIN" como string válida de EAN, causando match com produto 390001 (gtin="SEM GTIN")
- [x] Corrigir nfeParser.ts: função normalizeEAN trata "SEM GTIN", "0" e valores não-numéricos como null
- [x] Corrigir banco: gtin="SEM GTIN" do produto 390001 atualizado para NULL
- [x] Limpar ORs incorretas criadas com dados inválidos

## Recebimento Cego Agrupado Multi-NF
- [x] Schema: tabelas blindConferenceGroups, blindConferenceGroupOrders, blindConferenceGroupScans (migration 0032)
- [x] Backend: procedure createGroup (cria grupo, bloqueia NFs → in_progress)
- [x] Backend: procedure getGroupSummary (retorna itens consolidados + progresso)
- [x] Backend: procedure scanLabel (registra bipagem com distribuição FIFO virtual)
- [x] Backend: procedure undoLastScan (desfaz última bipagem - stack LIFO)
- [x] Backend: procedure finalizeGroup (persiste entradas individuais por NF via FIFO)
- [x] Backend: procedure cancelGroup (libera bloqueio das NFs)
- [x] Backend: procedure getActiveGroup (retorna grupo ativo para retomada)
- [x] Frontend /receiving: botão "Conferência Agrupada" ao selecionar ≥2 NFs agendadas
- [x] Coletor /collector/receiving-group: visão unificada com soma total por SKU
- [x] Coletor: bipagem com distribuição FIFO entre NFs
- [x] Coletor: alerta de excesso quando total bipado > total das NFs
- [x] Coletor: botão Desfazer (LIFO) para corrigir bipagens
- [x] Coletor: tela de finalização com relatório de divergências por agrupamento

## Gerador Dinâmico de Etiquetas de Logística (Recebimento)
- [x] Backend: procedure getItemsForLabels (retorna itens com unitsPerBox, internalCode, expiryDate)
- [x] Backend: procedure generateVolumeLabels (PDF 100x50mm/100x100mm + ZPL)
- [x] Frontend: botão "Etiquetas" na tela de recebimento (mobile + desktop)
- [x] Frontend: VolumeLabelDialog com seleção (Todos / Específicos)
- [x] Frontend: lista com checkbox, SKU, descrição, qtd esperada e fator de conversão
- [x] Frontend: modal de intervenção para SKUs sem unitsPerBox
- [x] Frontend: cálculo de volumes com teto (Math.ceil) e alerta de caixa fracionada
- [x] Frontend: pré-visualização SVG da etiqueta antes de gerar
- [x] Frontend: seletor de modelo (100x50mm / 100x100mm)
- [x] Frontend: download PDF e ZPL
- [x] Layout: SKU interno, descrição, lote, validade DD/MM/AAAA, CONTEÚDO: N UN, barcode CODE 128
- [ ] Frontend: botão "Imprimir Etiqueta Avulsa" no Cadastro de Produtos (pendente)

## Etiquetas de Volume — Campo Lote Editável

- [x] Campo Lote editável por item no step "Configurar Etiquetas" do VolumeLabelDialog: pré-preenchido com valor do XML, editável manualmente, aviso visual (âmbar) quando ausente, propagado ao PDF/ZPL gerado e à pré-visualização SVG

## Conferência Agrupada — Vinculação de Etiquetas Não Cadastradas

- [x] Backend: procedure registerNewLabelInGroup no blindConferenceGroupRouter (cria labelAssociation + registra scan no grupo, com verificação de excesso)
- [x] Frontend: dialog de vinculação no CollectorReceivingGroup — ao bipar etiqueta desconhecida, abre modal com busca de produto (SKU/descrição), campos Lote, Validade e Qtd/Caixa, botão "Vincular e Bipar"

## Caixa Fracionada — Conferência Individual e Agrupada

- [x] Backend: procedure correctFractionalBox no blindConferenceRouter (corrige unitsRead do receivingOrderItem para quantidade real)
- [x] Backend: readLabel retorna labelCode no objeto association (necessário para identificar o scan a corrigir)
- [x] Frontend: Dialog de caixa fracionada no CollectorReceiving — após bipar etiqueta com unitsPerBox > 1, pergunta se é caixa cheia ou fracionada; se fracionada, operador informa quantidade real
- [x] Backend: procedure correctFractionalBox no blindConferenceGroupRouter (corrige unitsRead do scan do grupo)
- [x] Backend: scanLabel no blindConferenceGroupRouter retorna labelCode no objeto association
- [x] Frontend: Dialog de caixa fracionada no CollectorReceivingGroup — mesmo comportamento da conferência individual

## Melhorias de UX — Validação e Alertas

- [x] Frontend: Validação visual de data inválida no campo Validade do dialog de associação (borda vermelha + mensagem quando data não existe, ex: 29/02 em ano não-bissexto)
- [x] Frontend: Alerta âmbar "Lotes extras detectados" no ConfirmFinishModal quando há itens com expectedQuantity=0 e receivedQuantity>0
- [x] Frontend: Linhas de lotes extras destacadas em âmbar com badge "Lote extra" e coluna Esperado mostrando "0 (extra)" no ConfirmFinishModal

## Correção de Bug: UNIQUE KEY violation em labelAssociations (17/04/2026)

- [x] Causa raiz: busca de idempotência em `associateLabel` filtrava por `tenantId`, mas a constraint `UNIQUE` em `labelCode` é global (sem tenant). Etiqueta existente com outro tenant não era detectada, causando "Failed query" no INSERT.
- [x] Corrigido `associateLabel` (blindConferenceRouter): busca de `existingLabel` agora usa apenas `labelCode` sem filtro de `tenantId`
- [x] Corrigido `registerNCG` (blindConferenceRouter): mesma correção na busca de `existingLabel`
- [x] Corrigido `registerNewLabelInGroup` (blindConferenceGroupRouter): mesma correção
- [x] Corrigido picking (collectorPickingRouter): adicionada verificação de existência antes do INSERT de etiqueta on-the-fly

## Refatoração: labelAssociations como cadastro global (17/04/2026)

- [x] Causa raiz: buscas de etiqueta filtravam por `tenantId`, mas `labelAssociations` é cadastro global de etiquetas físicas (sem relação com tenant, apenas com produto)
- [x] `associateLabel` (blindConferenceRouter): etiqueta já existente agora registra bip normalmente (blindConferenceItems + labelReadings + receivingOrderItems) sem tentar re-inserir
- [x] `readLabel`, `getLabelInfo`, `correctFractionalBox` (blindConferenceRouter): removido filtro de tenantId
- [x] `scanLabel` (blindConferenceGroupRouter): removido filtro de tenantId
- [x] `labelRouter`: removido filtro de tenantId na busca de etiqueta existente
- [x] `routers.ts` (pré-vínculo e picking): removido filtro de tenantId
- [x] `stage.ts`: removido filtro de tenantId
- [x] `stockRouter.ts`: removido filtro de tenantId
- [x] `labelReprintRouter.ts`: mantido filtro de tenantId apenas na listagem (UX — não exibir etiquetas de outros clientes)

## Produtos Globais (sem tenantId)

- [x] Analisar impacto: tabelas e queries que referenciam products.tenantId
- [x] Migration: remover tenantId de products, consolidar produtos duplicados (AZB1323, AZB1324, AZB2323)
- [x] Atualizar schema Drizzle (remover campo tenantId de products)
- [x] Atualizar todas as queries que filtram products por tenantId (26 erros corrigidos em 10 arquivos)
- [x] Corrigir cadastro de produtos no frontend
- [x] Testes: 144/144 passando

## productTenantMappings — Código Interno por Tenant

- [ ] Criar tabela productTenantMappings (productId, tenantId, internalCode) com UNIQUE(tenantId, internalCode)
- [ ] Migration: migrar dados existentes de products.internalCode para a nova tabela
- [ ] Backend: atualizar queries de lookup de internalCode para usar a nova tabela
- [ ] Backend: atualizar procedures de criação/edição de produto para salvar em productTenantMappings
- [ ] Frontend: exibir/editar internalCode por tenant no cadastro de produtos
- [ ] Testes: 144/144 passando
- [x] BUG: Menu Performance Intra-Hosp. aparece para todos os clientes (corrigido: menu dinâmico com intraHospitalEnabled)
- [x] BUG: Rota do menu apontava para /intra-hospitalar/dashboard (corrigido: aponta para /portal/intra-hospitalar)
- [x] BUG: Acesso direto a /portal/intra-hospitalar não valida intraHospitalEnabled
- [x] Exportação PDF+XLSX: Módulo Estoque (/portal/estoque)
- [x] Exportação PDF+XLSX: Módulo Pedidos (/portal/pedidos)
- [x] Exportação PDF+XLSX: Módulo Recebimentos (/portal/recebimentos)
- [x] Exportação PDF+XLSX: Módulo Movimentações (/portal/movimentacoes)
- [x] Exportação PDF+XLSX: Performance Intra-Hospitalar (/portal/intra-hospitalar)
- [x] Helper de exportação centralizado no backend (portalExport router)
- [x] Filtro de período (data inicial e data final) no módulo Pedidos do portal
- [x] Filtro de período (data inicial e data final) no módulo Recebimentos do portal
- [x] Filtro de período (data inicial e data final) no módulo Movimentações do portal
- [x] Filtro de período (data inicial e data final) no módulo Estoque do portal
- [x] Filtro de período (data inicial e data final) no módulo Performance Intra-Hospitalar-Hospitalar do portal
- [ ] Componente DateRangeFilter reutilizável para o portal
- [ ] Upload de logo do cliente no cadastro de tenant
- [ ] Exibir logo no Portal do Cliente (sidebar e cabeçalho)
- [x] Incluir logo nos relatórios PDF exportados do portal
- [x] BUG: data de validade não gravada no inventory ao vincular etiqueta com lote diferente do NF-e (finish não propagava expiryDate do blindConferenceItems)
- [x] Filtro de cliente (tenant) em /locations — seletor no painel de filtros, coluna Cliente na tabela, query backend filtra por tenantId
- [x] Ordenação crescente das etiquetas de endereço (Zona → Rua → Prédio → Andar → Código) na função printLabelsDirectly
- [x] Filtro de Lado (Ímpar/Par/Ambos) em /locations — filtro client-side por número do rack
- [x] Snapshot histórico de estoque por data de referência em /inventory (procedure getPositionsAtDate)
- [x] unitOfMeasure sempre "UN" ao criar produto via NF-e (motor de conversão converte para unidade base)
- [x] SLAs arredondados no módulo intra-hospitalar (Math.round em formatMinutes, fmt e fmtAlert)
- [x] Vinculação manual de SKU na importação de XML de saída em /nfe-import: backend retorna pendingSkuLinks, frontend exibe dialog com seletor de produto, após vincular reimporta automaticamente
- [x] BUG: Importação de saldos — coluna SKU do template deve corresponder ao campo "Cód. Interno" (internalCode) no cadastro de produtos (backend fazia lookup por products.sku em vez de products.internalCode)

## Inteligência de Cadastro e Vínculo Dinâmico (Fluxo de Saldo e XML)

- [x] Importação de saldo: coluna "SKU" da planilha salva em internalCode (codigoInterno), customerCode (Cód. Externo) fica NULL
- [x] Importação de saldo: não criar produto automaticamente — exigir que o produto já exista com internalCode cadastrado
- [x] XML de saída: lookup por tenantId + customerCode (uniqueSKU = tenantId+cProd); se não encontrar, disparar Modal DE/PARA
- [x] Modal DE/PARA: exibir código e descrição do XML lado a lado com lista de produtos sem customerCode (carregados via saldo)
- [x] Modal DE/PARA: ao confirmar vínculo, atualizar customerCode no cadastro do produto (transação atômica) e reimportar NF
- [x] Procedure products.linkCustomerCode: recebe productId + customerCode + tenantId, persiste em productTenantMappings
- [x] Procedure products.listWithoutCustomerCode: retorna produtos com internalCode preenchido mas customerCode NULL para o tenant

## Refatoração do Formulário de Cadastro de Produto

- [x] Schema: adicionar campos faltantes (unitsPerPallet, length, width, height, minOrderQty, requiresLotControl, requiresExpiryControl, specialTransportCategory)
- [x] Schema: renomear/ajustar storageCondition para incluir todas as opções especificadas
- [x] Backend: gerar uniqueSKU automaticamente quando customerCode + tenantId estiverem preenchidos
- [x] Backend: atualizar procedures create/update de produto com todos os novos campos
- [x] Frontend: refatorar formulário com 4 seções (Identificação, Saúde/Regulatório, Logística, Operacional)
- [x] Frontend: campo Cliente (Tenant) no formulário de cadastro
- [x] Frontend: campos de dimensões (Comprimento, Largura, Altura)
- [x] Frontend: switches para Controle de Lote e Controle de Validade
- [x] Frontend: campo Categorias Especiais/Transporte
- [x] Frontend: campos Pedido Mínimo e Unidades por Palete

## Bug - uniqueCode na Importação de Saldos

- [x] BUG CORRIGIDO: uniqueCode gerado incorretamente na importação de saldos — estava usando internalCode+lote em vez do formato correto
- [x] BUG CORRIGIDO: uniqueCode na importação de saldos agora usa products.sku (Cód. Externo) em vez de internalCode. uniqueCode = {SKU}-{lote}
- [x] Importação de saldos: auto-criar produto quando internalCode não encontrado (sku=NULL, Cód. Externo vazio)
- [x] uniqueCode fica vazio quando produto não tem Cód. Externo (SKU) — será preenchido no DE/PARA
- [x] Ao vincular DE/PARA (linkCustomerCode): recalcular e persistir uniqueCode nos registros de inventário do produto
- [x] BUG CORRIGIDO: importação de saldos agora usa a descrição da planilha ao auto-criar produto; texto genérico só é usado quando a coluna Descrição estiver vazia
- [x] Adicionar campo Cliente (Tenant) na ficha de cadastro de produto (CreateProductDialog e dialog de edição em Products.tsx)

## Módulo de Inventário - Fase 1

- [x] Schema: tabelas inventories, inventoryLocations, inventoryDivergences
- [x] Schema: role supervisor no enum users.role
- [x] Migration SQL aplicada via webdev_execute_sql
- [x] inventoryRouter.ts: criar, listar, iniciar, concluir, cancelar, dashboard, OMs, ondas
- [x] inventoryRouter.ts: gerar endereços elegíveis (cíclico/geral)
- [x] Bloqueio de movimentações em endereços com inventário ativo (movements.ts)
- [x] Bloqueio de picking em endereços com inventário ativo (pickingAllocation.ts)
- [x] pickingOrders: suporte a tipo INVENTORY_SURPLUS + campo inventoryId para OMs de sobra
- [x] Frontend: tela de configuração/criação de inventário (InventoryModule.tsx)
- [x] Frontend: tela de listagem de inventários com ações (iniciar, concluir, cancelar)
- [x] Frontend: tela de Ordens de Movimentação (OMs) com seleção para ondas
- [x] Frontend: tela de Ondas de Movimentação
- [x] Frontend: dashboard/relatório de inventário (KPIs + últimos concluídos)
- [x] Rotas registradas em App.tsx (/inventory-module)
- [x] Link no Home.tsx para o módulo de inventário

## Módulo de Inventário - Fase 2 (Coletor)

- [x] Backend: procedure listActiveForCollector (inventários em andamento para o operador)
- [x] Backend: procedure getLocationByCode (busca endereço por código escaneado)
- [x] Backend: procedure getLocationStock (saldo esperado do endereço)
- [x] Backend: procedure requestRecount (solicitar recontagem com justificativa — supervisor/admin)
- [x] Frontend: CollectorInventory.tsx (seleção de inventário, scan de endereço, contagem por produto/lote, resultado, recontagem)
- [x] Frontend: rota /collector/inventory registrada no App.tsx
- [x] Frontend: link "Inventário" no CollectorHome.tsx
- [x] Correção: startedAt → startDate em listActiveForCollector

## Bugs — Módulo de Inventário (Fase 1 e 2)

- [x] BUG CORRIGIDO: Inventário incluía endereços não-STORAGE (REC-01-C, EXP, SOB, FAL etc.). Filtro corrigido para zoneCode IN ('STORAGE', 'ARM') tanto na query geral quanto na query cíclica (SQL raw)
- [x] BUG CORRIGIDO: Inventário gerado não aparecia no coletor — listActiveForCollector filtrava apenas status='in_progress'. Corrigido para incluir ['pending', 'in_progress'] para que inventários recém-criados (pending) já apareçam no coletor
