# WMS Med@x — Sistema de Gerenciamento de Armazém Farmacêutico

> Sistema web multi-tenant para gestão de armazéns farmacêuticos, cobrindo recebimento, conferência cega, endereçamento, separação (picking), expedição, rastreabilidade e portal do cliente. Desenvolvido sobre React 19 + tRPC 11 + Express 4 + MySQL/TiDB, com conformidade à ANVISA RDC 430/2020.

---

## Sumário

1. [Visão Geral](#visão-geral)
2. [Stack Tecnológico](#stack-tecnológico)
3. [Arquitetura](#arquitetura)
4. [Módulos do Sistema](#módulos-do-sistema)
5. [Fluxos Operacionais](#fluxos-operacionais)
6. [Modelo de Dados](#modelo-de-dados)
7. [Controle de Acesso (RBAC)](#controle-de-acesso-rbac)
8. [Rotas da Aplicação](#rotas-da-aplicação)
9. [Estrutura de Arquivos](#estrutura-de-arquivos)
10. [Variáveis de Ambiente](#variáveis-de-ambiente)
11. [Instalação e Desenvolvimento](#instalação-e-desenvolvimento)
12. [Testes](#testes)
13. [Geração de Etiquetas](#geração-de-etiquetas)
14. [Integração com NF-e](#integração-com-nf-e)
15. [Portal do Cliente](#portal-do-cliente)
16. [Interface do Coletor](#interface-do-coletor)
17. [Relatórios](#relatórios)
18. [Convenções e Boas Práticas](#convenções-e-boas-práticas)

---

## Visão Geral

O WMS Med@x é uma plataforma SaaS multi-tenant voltada para operadores logísticos e distribuidores do setor farmacêutico. Cada cliente (tenant) possui seu próprio espaço de dados isolado, enquanto o Global Admin (Med@x) gerencia todos os clientes a partir de uma única interface.

O sistema cobre o ciclo completo de movimentação de mercadorias:

**Recebimento → Conferência → Endereçamento → Separação → Stage → Expedição**

Além disso, disponibiliza um **Portal do Cliente** para acompanhamento de pedidos, estoque e recebimentos em tempo real, e uma **Interface de Coletor** otimizada para terminais móveis (coletores de dados).

---

## Stack Tecnológico

| Camada | Tecnologia | Versão |
|---|---|---|
| Frontend | React | 19 |
| Roteamento frontend | Wouter | — |
| Estilização | Tailwind CSS | 4 |
| Componentes UI | shadcn/ui + Radix UI | — |
| Gerenciamento de estado | TanStack Query | 5 |
| Contrato API | tRPC | 11 |
| Serialização | SuperJSON | — |
| Backend | Express | 4 |
| ORM | Drizzle ORM | — |
| Banco de dados | MySQL / TiDB | — |
| Armazenamento de arquivos | AWS S3 | — |
| Autenticação | Manus OAuth 2.0 | — |
| Geração de PDF | PDFKit | — |
| Geração de código de barras | bwip-js | — |
| Build tool | Vite | 7 |
| Linguagem | TypeScript | 5 |

---

## Arquitetura

O projeto segue uma arquitetura **monorepo full-stack** com separação clara entre cliente e servidor:

```
┌─────────────────────────────────────────────────────┐
│                   Browser / Coletor                  │
│         React 19 + Wouter + TanStack Query           │
│              tRPC Client (SuperJSON)                 │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS /api/trpc
┌────────────────────▼────────────────────────────────┐
│                  Express 4 Server                    │
│         tRPC Router (protectedProcedure)             │
│         tenantGuard → effectiveTenantId              │
│         Drizzle ORM → MySQL / TiDB                   │
│         S3 (PDFs, etiquetas, uploads)                │
└─────────────────────────────────────────────────────┘
```

Toda comunicação entre frontend e backend ocorre exclusivamente via **tRPC procedures**, sem rotas REST avulsas. O contexto de cada requisição inclui `ctx.user` (usuário autenticado) e `ctx.effectiveTenantId` (tenant resolvido pelo `tenantGuard`), que considera o papel do usuário e o parâmetro `tenantId` opcional passado pelo Global Admin.

---

## Módulos do Sistema

### 1. Recebimento (`/receiving`)

Gerencia a entrada de mercadorias no armazém. O fluxo suporta importação de NF-e (XML), conferência cega por lote, aprovação de divergências, endereçamento automático (FEFO/FIFO) e geração de etiquetas de volume.

Funcionalidades principais:
- Importação de XML de NF-e com parser automático
- Conferência cega: o operador informa quantidades sem ver os valores esperados
- Aprovação de divergências (falta/sobra) com fluxo de qualidade
- Endereçamento automático por zona e regra de armazenamento
- Geração de etiquetas de volume (PDF e ZPL) com código de barras
- Conversão automática de unidades (CX → UN) usando `unitsPerBox` do produto como fallback

### 2. Separação / Picking (`/picking`)

Gerencia pedidos de separação de mercadorias. Suporta criação manual, importação via Excel e execução por ondas de separação.

Funcionalidades principais:
- Criação de pedidos com prioridade (emergência, urgente, normal, baixa)
- **Reserva automática de estoque** ao criar o pedido (`reservedQuantity` incrementado)
- Liberação automática da reserva ao concluir ou cancelar o pedido
- Agrupamento de pedidos em **ondas de separação** para otimização operacional
- Execução de picking com leitura de código de barras (coletor)
- Geração de etiquetas de produto com seleção individual de itens
- Cadastro inline de `unitsPerBox` diretamente no modal de etiquetas

### 3. Expedição (`/shipping`)

Gerencia o vínculo de NF-e aos pedidos separados, conferência de volumes, manifesto de carga e coleta.

Funcionalidades principais:
- Vínculo automático de NF-e ao pedido por código do produto (`sku`, `supplierCode`, `customerCode`, `internalCode`)
- Modal De/Para para mapeamento manual de códigos desconhecidos (salvo por tenant do pedido)
- Conversão automática de unidades CX → UN com fallback por `unitsPerBox`
- Geração de manifesto de carga
- Controle de status de expedição: `awaiting_invoice → invoice_linked → in_manifest → collected → shipped`

### 4. Estoque (`/stock`, `/inventory`)

Visibilidade em tempo real das posições de estoque com rastreabilidade completa.

Funcionalidades principais:
- Posições de estoque com colunas: Quantidade, Qtd. Reservada, Qtd. Disponível
- Movimentações com tipo: recebimento, put_away, picking, transferência, ajuste, retorno, descarte, qualidade
- Dashboard de ocupação por zona e endereço
- Importação em massa de inventário via Excel
- Alertas de estoque (vencimento próximo, estoque mínimo)

### 5. Stage (`/stage/check`)

Módulo de conferência de volumes no stage (área de expedição) antes da coleta.

### 6. Intra-Hospitalar (`/intra-hospitalar`)

Módulo especializado para distribuição intra-hospitalar com rastreabilidade de itens individuais (labelCode/uniqueCode) e dashboard analítico.

### 7. Relatórios (`/reports`)

11 tipos de relatório com filtros dinâmicos por tipo:

| Relatório | Filtros disponíveis |
|---|---|
| Posição de Estoque | Validade de/até, lote |
| Produtos Vencendo | Dias até vencimento |
| Estoque por Endereço | Tipo de endereço |
| Movimentações | Data inicial/final, tipo de movimentação |
| Produtividade de Picking | Data inicial/final |
| Acurácia de Picking | Data inicial/final |
| Tempo Médio de Ciclo | Data inicial/final |
| Performance de Operadores | Data inicial/final |
| Pedidos por Status | Data inicial/final |
| Disponibilidade de Produtos | — |
| Não Conformidades | — |

Quando o usuário é **Global Admin**, um seletor de cliente é exibido no painel de filtros, permitindo visualizar dados de qualquer tenant.

### 8. Cadastros

- **Produtos** (`/products`): cadastro completo com SKU, código do fornecedor, código do cliente, código interno, GTIN, registro ANVISA, condição de armazenamento, categoria de transporte especial, `unitsPerBox`, estratégia de picking (FEFO/FIFO/LIFO).
- **Endereços** (`/locations`): criação individual ou em lote, com tipo (inteira/fração), regra de armazenamento (único/multi), condição de armazenamento e status.
- **Clientes / Tenants** (`/tenants`): gestão de clientes com regras de picking, habilitação de intra-hospitalar.
- **Usuários** (`/users`) e **Papéis** (`/roles`): controle de acesso baseado em papéis (RBAC).
- **Conversão de Unidades** (`/unit-conversion`): fatores de conversão entre unidades de medida por produto.
- **Configurações de Impressão** (`/settings/printing`): configuração de impressoras ZPL e PDF.

---

## Fluxos Operacionais

### Fluxo de Recebimento

```
1. Criar Ordem de Recebimento (manual ou via importação NF-e XML)
2. Iniciar Conferência Cega (operador informa quantidades)
3. Sistema compara com NF → identifica divergências
4. Aprovação de divergências (Qualidade/Gerente)
5. Endereçamento automático (FEFO/FIFO por zona)
6. Geração de etiquetas de volume (PDF/ZPL)
7. Ordem concluída → Estoque atualizado
```

### Fluxo de Separação

```
1. Criar Pedido de Picking (manual ou importação Excel)
   → reservedQuantity incrementado no estoque
2. Validar disponibilidade de estoque
3. Agrupar em Onda de Separação (opcional)
4. Executar picking (coletor ou desktop)
   → reservedQuantity decrementado ao concluir
5. Gerar etiquetas de produto (seleção individual de itens)
6. Conferência de volumes no Stage
7. Pedido concluído → Estoque debitado
```

### Fluxo de Expedição

```
1. Vincular NF-e ao Pedido (automático por código ou De/Para manual)
2. Converter unidades se necessário (CX → UN via unitsPerBox)
3. Validar quantidades NF vs. Pedido
4. Adicionar ao Manifesto de Carga
5. Registrar Coleta → Status: shipped
```

---

## Modelo de Dados

O banco de dados possui **55+ tabelas** organizadas nos seguintes grupos:

### Identidade e Acesso

| Tabela | Descrição |
|---|---|
| `users` | Usuários do sistema com papel (user, admin, operator, quality, manager) |
| `systemUsers` | Usuários de sistema com status de aprovação |
| `roles` | Papéis personalizados |
| `permissions` | Permissões granulares |
| `rolePermissions` | Vínculo papel ↔ permissão |
| `userRoles` | Vínculo usuário ↔ papel |
| `userPermissions` | Permissões diretas por usuário |
| `tenants` | Clientes (multi-tenant) |
| `contracts` | Contratos por cliente |

### Catálogo

| Tabela | Descrição |
|---|---|
| `products` | Produtos com SKU, códigos, GTIN, ANVISA, `unitsPerBox`, estratégia de picking |
| `productTenantMappings` | Mapeamentos De/Para de código por tenant |
| `productBarcodes` | Códigos de barras alternativos por produto |
| `productConversions` | Fatores de conversão de unidades por produto |
| `unitAliases` | Aliases de unidades de medida |
| `packagingLevels` | Níveis de embalagem (unidade, caixa, palete) |

### Armazém

| Tabela | Descrição |
|---|---|
| `warehouses` | Armazéns |
| `warehouseZones` | Zonas com condição de armazenamento e regra de picking |
| `warehouseLocations` | Endereços com tipo, regra e status |

### Recebimento

| Tabela | Descrição |
|---|---|
| `receivingOrders` | Ordens de recebimento |
| `receivingOrderItems` | Itens da ordem |
| `receivingPreallocations` | Pré-alocações de endereço |
| `receivingConferences` | Sessões de conferência cega |
| `receivingDivergences` | Divergências identificadas |
| `nonConformities` | Não conformidades |
| `divergenceApprovals` | Aprovações de divergência |

### Estoque

| Tabela | Descrição |
|---|---|
| `inventory` | Posições de estoque com `quantity`, `reservedQuantity`, `status` |
| `inventoryMovements` | Histórico de movimentações com tipo e origem da conversão |
| `inventoryCounts` | Contagens de inventário |
| `inventoryCountItems` | Itens de contagem |

### Separação

| Tabela | Descrição |
|---|---|
| `pickingOrders` | Pedidos de separação com prioridade e status completo |
| `pickingOrderItems` | Itens do pedido |
| `pickingAllocations` | Alocações de estoque por item (com `inventoryId` para reserva) |
| `pickingWaves` | Ondas de separação |
| `pickingWaveItems` | Itens da onda |
| `pickingProgress` | Progresso de execução por item |
| `pickingAuditLogs` | Auditoria de picking |

### Expedição

| Tabela | Descrição |
|---|---|
| `shipments` | Expedições |
| `invoices` | NF-e vinculadas |
| `pickingInvoiceItems` | Itens de NF vinculados ao picking |
| `receivingInvoiceItems` | Itens de NF vinculados ao recebimento |
| `shipmentManifests` | Manifestos de carga |
| `shipmentManifestItems` | Itens do manifesto |

### Etiquetas e Impressão

| Tabela | Descrição |
|---|---|
| `labelPrintHistory` | Histórico de impressão de etiquetas |
| `labelAssociations` | Associações de etiqueta a volume/item |
| `labelReadings` | Leituras de código de barras |
| `productLabels` | Etiquetas de produto geradas |
| `printSettings` | Configurações de impressora por tenant |

### Outros

| Tabela | Descrição |
|---|---|
| `stageChecks` | Conferências de stage |
| `stageCheckItems` | Itens conferidos no stage |
| `auditLogs` | Logs de auditoria geral |
| `reportLogs` | Logs de geração de relatórios |
| `reportFavorites` | Relatórios favoritos por usuário |
| `clientPortalSessions` | Sessões do Portal do Cliente |
| `unitPendingQueue` | Fila de pendências de conversão de unidades |

---

## Controle de Acesso (RBAC)

O sistema implementa controle de acesso em dois níveis:

**Papéis nativos do usuário** (campo `role` na tabela `users`):

| Papel | Descrição |
|---|---|
| `admin` | Global Admin — acesso irrestrito a todos os tenants |
| `manager` | Gerente — aprovação de divergências, relatórios gerenciais |
| `operator` | Operador — recebimento, picking, expedição |
| `quality` | Qualidade — aprovação de não conformidades |
| `user` | Usuário padrão — acesso básico |

**Papéis customizados** (tabelas `roles` e `permissions`): permitem criar papéis adicionais com permissões granulares por módulo.

No backend, as procedures são protegidas por:
- `publicProcedure`: acesso sem autenticação
- `protectedProcedure`: requer autenticação
- `tenantProcedure`: requer autenticação + resolve `effectiveTenantId`
- `adminProcedure`: requer papel `admin`

---

## Rotas da Aplicação

### Sistema WMS (operadores)

| Rota | Módulo |
|---|---|
| `/home` | Dashboard principal |
| `/receiving` | Recebimento de mercadorias |
| `/picking` | Pedidos de separação |
| `/picking/:id` | Execução de pedido |
| `/picking/execute/:id` | Execução de onda |
| `/shipping` | Expedição |
| `/inventory` | Inventário |
| `/stock` | Posições de estoque |
| `/stock/movements` | Movimentações de estoque |
| `/stock/occupancy` | Dashboard de ocupação |
| `/stage/check` | Conferência de stage |
| `/reports` | Relatórios |
| `/intra-hospitalar` | Distribuição intra-hospitalar |
| `/intra-hospitalar/rastreabilidade` | Rastreabilidade intra-hospitalar |
| `/intra-hospitalar/dashboard` | Dashboard intra-hospitalar |
| `/products` | Cadastro de produtos |
| `/locations` | Cadastro de endereços |
| `/locations/batch-create` | Criação em lote de endereços |
| `/tenants` | Gestão de clientes |
| `/users` | Gestão de usuários |
| `/roles` | Gestão de papéis |
| `/unit-conversion` | Conversão de unidades |
| `/nfe-import` | Importação de NF-e |
| `/inventory-import` | Importação de inventário |
| `/settings/printing` | Configurações de impressão |
| `/maintenance` | Manutenção do sistema |

### Interface do Coletor (terminais móveis)

| Rota | Função |
|---|---|
| `/collector` | Home do coletor |
| `/collector/receiving` | Recebimento via coletor |
| `/collector/receiving-group` | Recebimento em grupo |
| `/collector/picking` | Picking via coletor |
| `/collector/stage` | Stage via coletor |
| `/collector/movement` | Movimentação via coletor |
| `/collector/label-reprint` | Reimpressão de etiquetas |
| `/collector/intra-hospitalar` | Intra-hospitalar via coletor |

### Portal do Cliente

| Rota | Função |
|---|---|
| `/portal` | Dashboard do cliente |
| `/portal/login` | Login do portal |
| `/portal/primeiro-acesso` | Primeiro acesso |
| `/portal/pedidos` | Pedidos do cliente |
| `/portal/pedidos/novo` | Novo pedido |
| `/portal/pedidos/:id` | Detalhe do pedido |
| `/portal/recebimentos` | Recebimentos |
| `/portal/recebimentos/:id` | Detalhe do recebimento |
| `/portal/movimentacoes` | Movimentações |
| `/portal/estoque` | Estoque do cliente |
| `/portal/intra-hospitalar` | Intra-hospitalar do cliente |

---

## Estrutura de Arquivos

```
wms-medax/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx                    # Roteamento principal
│       ├── main.tsx                   # Providers (QueryClient, tRPC)
│       ├── index.css                  # Tokens de design global (Tailwind 4)
│       ├── components/
│       │   ├── ui/                    # shadcn/ui (Button, Card, Dialog, etc.)
│       │   ├── DashboardLayout.tsx    # Layout com sidebar para o WMS
│       │   ├── PageHeader.tsx         # Cabeçalho de página com botão Início/Voltar
│       │   └── ...
│       ├── pages/
│       │   ├── Home.tsx               # Dashboard principal
│       │   ├── Receiving.tsx          # Recebimento
│       │   ├── PickingOrders.tsx      # Pedidos de separação
│       │   ├── PickingExecution.tsx   # Execução de pedido
│       │   ├── WaveExecution.tsx      # Execução de onda
│       │   ├── Shipping.tsx           # Expedição
│       │   ├── Inventory.tsx          # Inventário
│       │   ├── StockPositions.tsx     # Posições de estoque
│       │   ├── StockMovements.tsx     # Movimentações
│       │   ├── OccupancyDashboard.tsx # Dashboard de ocupação
│       │   ├── StageCheck.tsx         # Conferência de stage
│       │   ├── Reports.tsx            # Relatórios
│       │   ├── Products.tsx           # Cadastro de produtos
│       │   ├── Locations.tsx          # Cadastro de endereços
│       │   ├── Tenants.tsx            # Gestão de clientes
│       │   ├── Users.tsx              # Gestão de usuários
│       │   ├── Roles.tsx              # Gestão de papéis
│       │   ├── UnitConversion.tsx     # Conversão de unidades
│       │   ├── InventoryImport.tsx    # Importação de inventário
│       │   ├── NFEImport.tsx          # Importação de NF-e
│       │   ├── IntraHospitalar.tsx    # Intra-hospitalar
│       │   ├── client/                # Portal do Cliente
│       │   └── collector/             # Interface do Coletor
│       ├── hooks/
│       │   └── useAuth.ts             # Hook de autenticação
│       ├── contexts/                  # Contextos React
│       └── lib/
│           └── trpc.ts                # Cliente tRPC
├── server/
│   ├── routers.ts                     # Router principal (tenants, products, locations, picking, etc.)
│   ├── db.ts                          # Helpers de banco de dados
│   ├── storage.ts                     # Helpers S3
│   ├── waveRouter.ts                  # Router de ondas de separação
│   ├── shippingRouter.ts              # Router de expedição e NF-e
│   ├── reportsRouter.ts               # Router de relatórios
│   ├── labelReprintRouter.ts          # Router de reimpressão de etiquetas
│   ├── labelRouter.ts                 # Router de geração de etiquetas
│   ├── blindConferenceRouter.ts       # Router de conferência cega
│   ├── blindConferenceGroupRouter.ts  # Router de conferência cega em grupo
│   ├── clientPortalRouter.ts          # Router do Portal do Cliente
│   ├── collectorPickingRouter.ts      # Router do coletor (picking)
│   ├── intraHospitalRouter.ts         # Router intra-hospitalar
│   ├── inventoryImportRouter.ts       # Router de importação de inventário
│   ├── stageRouter.ts                 # Router de stage
│   ├── unitConversionRouter.ts        # Router de conversão de unidades
│   ├── roleRouter.ts                  # Router de papéis e permissões
│   ├── userRouter.ts                  # Router de usuários
│   ├── syncReservations.ts            # Sincronização de reservas de estoque
│   ├── modules/                       # Módulos de lógica de negócio
│   │   ├── receiving.ts               # Lógica de recebimento
│   │   ├── picking.ts                 # Lógica de picking
│   │   ├── inventory.ts               # Lógica de inventário
│   │   ├── conference.ts              # Lógica de conferência
│   │   ├── addressing.ts              # Lógica de endereçamento
│   │   ├── labelGenerator.ts          # Gerador de etiquetas (PDF/ZPL)
│   │   ├── nfeParser.ts               # Parser de NF-e XML
│   │   └── ...
│   └── _core/                         # Infraestrutura (OAuth, contexto, LLM, etc.)
│       ├── context.ts                 # Contexto tRPC
│       ├── tenantGuard.ts             # Resolução de effectiveTenantId
│       ├── env.ts                     # Variáveis de ambiente tipadas
│       └── ...
├── drizzle/
│   ├── schema.ts                      # Schema completo do banco (55+ tabelas)
│   └── migrations/                    # Migrações SQL geradas pelo Drizzle Kit
├── shared/                            # Tipos e constantes compartilhados
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## Variáveis de Ambiente

Todas as variáveis são injetadas automaticamente pela plataforma Manus. Não é necessário configurar manualmente em desenvolvimento local via Manus.

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão MySQL/TiDB |
| `JWT_SECRET` | Segredo para assinatura de cookies de sessão |
| `VITE_APP_ID` | ID da aplicação Manus OAuth |
| `OAUTH_SERVER_URL` | URL base do servidor OAuth (backend) |
| `VITE_OAUTH_PORTAL_URL` | URL do portal de login Manus (frontend) |
| `OWNER_OPEN_ID` | OpenID do proprietário da aplicação |
| `OWNER_NAME` | Nome do proprietário |
| `BUILT_IN_FORGE_API_URL` | URL das APIs internas Manus (LLM, Storage, etc.) |
| `BUILT_IN_FORGE_API_KEY` | Token de acesso às APIs internas (server-side) |
| `VITE_FRONTEND_FORGE_API_KEY` | Token de acesso às APIs internas (frontend) |
| `VITE_FRONTEND_FORGE_API_URL` | URL das APIs internas Manus (frontend) |

---

## Instalação e Desenvolvimento

### Pré-requisitos

- Node.js 22+
- pnpm 9+
- Acesso ao banco de dados MySQL/TiDB
- Conta na plataforma Manus (para OAuth e variáveis de ambiente)

### Instalação

```bash
# Clonar o repositório
git clone https://github.com/DecoSantosBR/wms-homologacao.git
cd wms-homologacao

# Instalar dependências
pnpm install

# Iniciar servidor de desenvolvimento
pnpm dev
```

O servidor de desenvolvimento inicia em `http://localhost:3000` (ou na próxima porta disponível).

### Migrações de banco de dados

O projeto usa **Drizzle ORM** com fluxo schema-first:

```bash
# 1. Editar drizzle/schema.ts com as novas tabelas/colunas

# 2. Gerar o SQL de migração
pnpm drizzle-kit generate

# 3. Ler o arquivo .sql gerado em drizzle/migrations/
# 4. Aplicar via webdev_execute_sql (plataforma Manus) ou cliente MySQL
```

> **Atenção:** nunca execute `drizzle-kit push` diretamente em produção. Sempre revise o SQL gerado antes de aplicar.

### Scripts disponíveis

| Comando | Descrição |
|---|---|
| `pnpm dev` | Inicia servidor de desenvolvimento (Vite + Express) |
| `pnpm build` | Build de produção |
| `pnpm test` | Executa testes Vitest |
| `pnpm drizzle-kit generate` | Gera SQL de migração a partir do schema |
| `pnpm drizzle-kit studio` | Abre o Drizzle Studio (inspetor de banco) |

---

## Testes

Os testes utilizam **Vitest** e seguem o padrão de arquivos `server/*.test.ts`. O arquivo de referência é `server/auth.logout.test.ts`.

```bash
# Executar todos os testes
pnpm test

# Executar em modo watch
pnpm test --watch
```

Cada nova procedure ou módulo de lógica de negócio deve ter cobertura de teste correspondente antes de ser entregue.

---

## Geração de Etiquetas

O sistema gera etiquetas em dois formatos:

**PDF** (via PDFKit): para impressoras comuns. Inclui código de barras (bwip-js), informações do produto, lote, validade, endereço e cliente.

**ZPL** (Zebra Programming Language): para impressoras térmicas Zebra. Gerado como string ZPL pura, enviado diretamente para a impressora configurada.

### Tipos de etiqueta

| Tipo | Descrição |
|---|---|
| Etiqueta de Volume | Gerada no recebimento, identifica cada caixa/palete |
| Etiqueta de Produto | Gerada no picking, identifica o produto separado |
| Reimpressão | Reimprime etiquetas de volumes já gerados |

### Campo CONTEUDO

O campo CONTEUDO na etiqueta de produto exibe `unitsPerBox` do produto (ex.: "12 UN/CX"). Quando o produto não possui `unitsPerBox` cadastrado, o campo é omitido da etiqueta. O valor pode ser cadastrado diretamente no modal de geração de etiquetas sem sair da tela.

---

## Integração com NF-e

O sistema realiza o vínculo automático de NF-e (XML padrão SEFAZ) aos pedidos de separação e ordens de recebimento.

### Resolução de produtos

O motor de resolução tenta identificar o produto da NF na seguinte ordem de prioridade:

1. `sku` do produto
2. `supplierCode` (código do fornecedor)
3. `customerCode` (código do cliente/tenant)
4. `internalCode` (código interno)
5. Mapeamento De/Para salvo em `productTenantMappings`

Quando nenhum código coincide, o modal **De/Para** é exibido para mapeamento manual. O mapeamento é salvo no tenant do pedido (não do usuário logado) e aplicado automaticamente nas próximas expedições.

### Conversão de unidades

Quando a NF informa quantidade em uma unidade diferente da base (ex.: `CX` em vez de `UN`), o sistema converte automaticamente:

1. Busca fator de conversão cadastrado em `productConversions`
2. Se não encontrado, usa `unitsPerBox` do produto como fallback (`1 CX = unitsPerBox UN`)
3. Se nenhum dos dois estiver disponível, o item entra na fila de pendências (`unitPendingQueue`)

---

## Portal do Cliente

O Portal do Cliente é uma interface separada, acessível em `/portal`, com autenticação própria via `clientPortalSessions`. Permite que os clientes (tenants) acompanhem:

- Dashboard com KPIs em tempo real (pedidos, recebimentos, estoque)
- Pedidos de separação e status de expedição
- Histórico de recebimentos com detalhe por item
- Posições de estoque em tempo real
- Movimentações de estoque
- Distribuição intra-hospitalar (quando habilitada no contrato)
- Criação de novos pedidos de separação

---

## Interface do Coletor

A interface do coletor (`/collector/*`) é otimizada para terminais móveis com tela pequena e entrada por leitura de código de barras. Cobre:

- Recebimento de mercadorias (individual e em grupo)
- Execução de picking
- Conferência de stage
- Movimentação de estoque
- Reimpressão de etiquetas
- Distribuição intra-hospitalar

---

## Relatórios

Os relatórios são gerados no backend (`server/reportsRouter.ts`) e exportados em Excel (via `xlsx`) ou exibidos em tabela na interface. Cada relatório suporta paginação e filtros específicos. O Global Admin pode filtrar por cliente usando o seletor de tenant no painel de filtros.

---

## Convenções e Boas Práticas

**Backend:**
- Toda lógica de negócio deve residir em `server/modules/` ou em routers dedicados, nunca inline em `routers.ts`.
- Procedures que crescem além de 150 linhas devem ser extraídas para arquivos separados em `server/routers/`.
- Timestamps são armazenados como UTC no banco e convertidos para o fuso do usuário apenas no frontend.
- Reservas de estoque (`reservedQuantity`) devem ser incrementadas ao criar alocações e decrementadas ao concluir ou cancelar.

**Frontend:**
- Toda comunicação com o backend ocorre via `trpc.*.useQuery/useMutation`. Nunca usar `fetch` ou `axios` diretamente.
- Referências instáveis em inputs de query (objetos/arrays criados no render) causam re-fetches infinitos — sempre estabilizar com `useState` ou `useMemo`.
- Assets estáticos (imagens, vídeos) devem ser hospedados via `manus-upload-file --webdev` e referenciados pela URL retornada.
- O componente `PageHeader` deve ser usado em todas as páginas para manter consistência de navegação (botões Voltar e Início).

**Banco de dados:**
- Nunca armazenar bytes de arquivo em colunas do banco. Usar S3 (`storagePut`) e salvar apenas a URL/chave.
- Migrações destrutivas (DROP, ALTER com perda de dados) devem ser revisadas manualmente antes de aplicar.
- O tenant Global Admin possui `id = 1` e é excluído das listagens de clientes.

---

*Documentação gerada em 30/04/2026 — WMS Med@x v1.0 (branch: homologacao)*
