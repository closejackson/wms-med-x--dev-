import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, decimal, boolean, index, unique, uniqueIndex, json, date } from "drizzle-orm/mysql-core";

/**
 * Sistema WMS Med@x - Modelo de Dados Completo
 * Multi-tenant com conformidade ANVISA e rastreabilidade total
 */

// ============================================================================
// TABELA DE USUÁRIOS E AUTENTICAÇÃO
// ============================================================================

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "operator", "quality", "manager", "supervisor"]).default("user").notNull(),
  tenantId: int("tenantId"), // Relacionamento com cliente (tenant)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
}, (table) => ({
  tenantIdIdx: index("users_tenantId_idx").on(table.tenantId),
  roleIdx: index("users_role_idx").on(table.role),
}));

// ============================================================================
// SISTEMA DE USUÁRIOS E PERMISSÕES (RBAC)
// ============================================================================

/**
 * Tabela de usuários do sistema WMS
 * Cada usuário pertence a um cliente (tenant) e possui login/senha próprios
 */
export const systemUsers = mysqlTable("systemUsers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Cliente ao qual o usuário pertence
  fullName: varchar("fullName", { length: 255 }).notNull(),
  login: varchar("login", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(), // bcrypt hash
  active: boolean("active").default(true).notNull(),
  approvalStatus: mysqlEnum("approvalStatus", ["pending", "approved", "rejected"]).default("approved").notNull(), // Status de aprovação
  approvedBy: int("approvedBy"), // ID do admin que aprovou
  approvedAt: timestamp("approvedAt"), // Data/hora da aprovação
  failedLoginAttempts: int("failedLoginAttempts").default(0).notNull(),
  lockedUntil: timestamp("lockedUntil"), // Bloqueio temporário por tentativas inválidas
  lastLogin: timestamp("lastLogin"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdBy: int("createdBy"), // ID do usuário que criou este registro
  mustResetPassword: boolean("mustResetPassword").default(false).notNull(), // Força redefinição de senha no próximo login
}, (table) => ({
  tenantLoginIdx: unique().on(table.tenantId, table.login), // Login único por cliente
  tenantIdIdx: index("systemUsers_tenantId_idx").on(table.tenantId),
  tenantActiveIdx: index("systemUsers_active_idx").on(table.tenantId, table.active),
}));

/**
 * Perfis de acesso (roles)
 * Define conjuntos de permissões que podem ser atribuídos a usuários
 */
export const roles = mysqlTable("roles", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(), // Ex: ADMIN_SISTEMA, SUPERVISOR
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isSystemRole: boolean("isSystemRole").default(false).notNull(), // Perfis do sistema não podem ser editados
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Permissões granulares do sistema
 * Cada permissão representa uma ação específica que pode ser executada
 */
export const permissions = mysqlTable("permissions", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 100 }).notNull().unique(), // Ex: USUARIO_CRIAR, ESTOQUE_MOVIMENTAR
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  module: varchar("module", { length: 50 }).notNull(), // Ex: USUARIO, ESTOQUE, RECEBIMENTO
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Relacionamento entre perfis e permissões
 * Define quais permissões cada perfil possui
 */
export const rolePermissions = mysqlTable("rolePermissions", {
  id: int("id").autoincrement().primaryKey(),
  roleId: int("roleId").notNull(),
  permissionId: int("permissionId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  rolePermissionIdx: unique().on(table.roleId, table.permissionId),
}));

/**
 * Relacionamento entre usuários e perfis
 * Um usuário pode ter múltiplos perfis
 */
export const userRoles = mysqlTable("userRoles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  roleId: int("roleId").notNull(),
  isPrimary: boolean("isPrimary").default(false).notNull(), // Perfil principal do usuário
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  createdBy: int("createdBy"), // Quem atribuiu este perfil
}, (table) => ({
  userRoleIdx: unique().on(table.userId, table.roleId),
}));

/**
 * Permissões extras concedidas diretamente a usuários
 * Permite override de permissões além das herdadas dos perfis
 */
export const userPermissions = mysqlTable("userPermissions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  permissionId: int("permissionId").notNull(),
  granted: boolean("granted").default(true).notNull(), // true = conceder, false = revogar
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  createdBy: int("createdBy"),
}, (table) => ({
  userPermissionIdx: unique().on(table.userId, table.permissionId),
}));

// ============================================================================
// MÓDULO 1: GESTÃO DE CLIENTES (MULTI-TENANT)
// ============================================================================

export const tenants = mysqlTable("tenants", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  tradeName: varchar("tradeName", { length: 255 }),
  cnpj: varchar("cnpj", { length: 18 }).notNull().unique(),
  afe: varchar("afe", { length: 50 }), // Autorização de Funcionamento de Empresa (ANVISA)
  ae: varchar("ae", { length: 50 }), // Autorização Especial (ANVISA)
  licenseNumber: varchar("licenseNumber", { length: 100 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zipCode: varchar("zipCode", { length: 10 }),
  phone: varchar("phone", { length: 20 }),
  email: varchar("email", { length: 320 }),
  pickingRule: mysqlEnum("pickingRule", ["FIFO", "FEFO", "Direcionado"]).default("FIFO").notNull(),
  shippingAddress: varchar("shippingAddress", { length: 50 }), // Endereço de expedição (ex: EXP-01-A)
  intraHospitalEnabled: boolean("intraHospitalEnabled").default(false).notNull(), // Módulo Intra-Hospitalar habilitado para este cliente
  logoUrl: varchar("logoUrl", { length: 1024 }), // URL da logo do cliente (S3)
  status: mysqlEnum("status", ["active", "inactive", "suspended"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const contracts = mysqlTable("contracts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // tenantId = dono da operação (cliente)
  contractNumber: varchar("contractNumber", { length: 50 }).notNull().unique(),
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate"),
  slaReceivingHours: int("slaReceivingHours").default(24), // SLA de recebimento em horas
  slaPickingHours: int("slaPickingHours").default(4), // SLA de separação em horas
  slaShippingHours: int("slaShippingHours").default(2), // SLA de expedição em horas
  pickingStrategy: mysqlEnum("pickingStrategy", ["FEFO", "FIFO", "LIFO"]).default("FEFO").notNull(),
  expiryDaysThreshold: int("expiryDaysThreshold").default(90), // Dias mínimos de validade no recebimento
  status: mysqlEnum("status", ["active", "inactive", "expired"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("contracts_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("contracts_tenantId_status_idx").on(table.tenantId, table.status),
}));

// ============================================================================
// MÓDULO 2: CADASTRO MESTRE
// ============================================================================

export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  sku: varchar("sku", { length: 100 }), // Código global do produto (Cód. Externo/fornecedor) — pode ser NULL quando produto é criado via importação de saldos
  supplierCode: varchar("supplierCode", { length: 100 }), // Código do fornecedor (usado em NF-e de entrada)
  customerCode: varchar("customerCode", { length: 100 }), // Código do cliente (usado em NF-e de saída)
  internalCode: varchar("internalCode", { length: 100 }), // Código interno do cliente na NF-e de saída (De/Para)
  description: text("description").notNull(),
  gtin: varchar("gtin", { length: 14 }), // EAN/DUN (código de barras)
  anvisaRegistry: varchar("anvisaRegistry", { length: 100 }), // Registro ANVISA
  therapeuticClass: varchar("therapeuticClass", { length: 100 }),
  manufacturer: varchar("manufacturer", { length: 255 }),
  unitOfMeasure: varchar("unitOfMeasure", { length: 20 }).default("UN").notNull(),
  unitsPerBox: int("unitsPerBox"), // Quantidade de unidades por caixa/volume
  category: varchar("category", { length: 100 }), // Categoria do produto
  costPrice: decimal("costPrice", { precision: 10, scale: 2 }), // Preço de custo
  salePrice: decimal("salePrice", { precision: 10, scale: 2 }), // Preço de venda
  minQuantity: int("minQuantity").default(0), // Quantidade mínima em estoque
  dispensingQuantity: int("dispensingQuantity").default(1), // Quantidade mínima de dispensação/separação
  requiresBatchControl: boolean("requiresBatchControl").default(true).notNull(),
  requiresExpiryControl: boolean("requiresExpiryControl").default(true).notNull(),
  requiresSerialControl: boolean("requiresSerialControl").default(false).notNull(),
  // Condição de armazenagem (expandida conforme especificação)
  storageCondition: mysqlEnum("storageCondition", [
    "ambient",              // Ambiente (sem controle de temperatura)
    "climatized_15_30",     // Climatizada (15°C a 30°C)
    "controlled_8_25",      // Ambiente Controlada (8°C a 25°C)
    "refrigerated_2_8",     // Refrigerado (2°C a 8°C)
    "frozen_minus_20",      // Congelado (-20°C a -10°C)
    "controlled"            // Controlado
  ]).default("ambient").notNull(),
  // Categoria especial de transporte
  specialTransportCategory: mysqlEnum("specialTransportCategory", [
    "thermoLabile_2_8",           // Termolábil (2°C a 8°C)
    "thermoLabile_extended_2_25", // Termolábil faixa ampliada (2°C a 25°C)
    "thermoStable_15_30",         // Termoestável (15°C a 30°C)
    "none"                        // Sem categoria especial
  ]).default("none").notNull(),
  minTemperature: decimal("minTemperature", { precision: 5, scale: 2 }),
  maxTemperature: decimal("maxTemperature", { precision: 5, scale: 2 }),
  requiresHumidityControl: boolean("requiresHumidityControl").default(false).notNull(),
  isControlledSubstance: boolean("isControlledSubstance").default(false).notNull(), // Medicamento controlado
  isPsychotropic: boolean("isPsychotropic").default(false).notNull(), // Psicotrópico
  // Dados logísticos e cubagem
  unitsPerPallet: int("unitsPerPallet"),              // Unidades por palete
  lengthCm: decimal("lengthCm", { precision: 8, scale: 2 }), // Comprimento (cm)
  widthCm: decimal("widthCm", { precision: 8, scale: 2 }),   // Largura (cm)
  heightCm: decimal("heightCm", { precision: 8, scale: 2 }), // Altura (cm)
  // Regras operacionais
  minOrderQty: int("minOrderQty").default(0),         // Pedido mínimo (trava de separação)
  // Cliente (Tenant) dono global do produto — null = produto sem cliente específico
  tenantId: int("tenantId"),
  status: mysqlEnum("status", ["active", "inactive", "discontinued"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  skuIdx: index("idx_products_sku").on(table.sku),
  internalCodeIdx: index("idx_products_internal_code").on(table.internalCode),
  statusIdx: index("products_status_idx").on(table.status),
  gtinIdx: index("products_gtin_idx").on(table.gtin),
  supplierCodeIdx: index("products_supplierCode_idx").on(table.supplierCode),
  customerCodeIdx: index("products_customerCode_idx").on(table.customerCode),
}));

/**
 * Mapeamento de código interno por tenant
 * Permite que cada cliente tenha seu próprio código interno para o mesmo produto global
 */
export const productTenantMappings = mysqlTable("productTenantMappings", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("productId").notNull(),
  tenantId: int("tenantId").notNull(),
  internalCode: varchar("internalCode", { length: 100 }),
  customerCode: varchar("customerCode", { length: 100 }), // Código do cliente na NF-e de saída
  supplierCode: varchar("supplierCode", { length: 100 }), // Código do fornecedor na NF-e de entrada
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  productTenantUnique: unique().on(table.productId, table.tenantId),
  tenantInternalCodeUnique: unique().on(table.tenantId, table.internalCode),
  productIdIdx: index("ptm_productId_idx").on(table.productId),
  tenantIdIdx: index("ptm_tenantId_idx").on(table.tenantId),
}));

// Tabela para vincular códigos de barras (etiquetas) a produtos
// Permite múltiplas etiquetas por produto, cada uma com lote/validade específicos
export const productBarcodes = mysqlTable("productBarcodes", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("productId").notNull(),
  barcode: varchar("barcode", { length: 100 }).notNull().unique(), // Código da etiqueta
  batch: varchar("batch", { length: 50 }), // Lote associado (opcional)
  expiryDate: date("expiryDate", { mode: "string" }), // Validade associada (opcional)
  locationId: int("locationId"), // Endereço onde está armazenado (opcional)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const warehouses = mysqlTable("warehouses", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zipCode: varchar("zipCode", { length: 10 }),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const warehouseZones = mysqlTable("warehouseZones", {
  id: int("id").autoincrement().primaryKey(),
  warehouseId: int("warehouseId").notNull(),
  code: varchar("code", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  storageCondition: mysqlEnum("storageCondition", ["ambient", "refrigerated_2_8", "frozen_minus_20", "controlled", "quarantine"]).default("ambient").notNull(),
  hasTemperatureControl: boolean("hasTemperatureControl").default(false).notNull(),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  warehouseCodeIdx: unique().on(table.warehouseId, table.code),
}));

export const warehouseLocations = mysqlTable("warehouseLocations", {
  id: int("id").autoincrement().primaryKey(),
  zoneId: int("zoneId").notNull(),
  zoneCode: varchar("zoneCode", { length: 20 }), // Código da zona (ex: 'NCG', 'REC', 'EXP')
  tenantId: int("tenantId").notNull(), // Cliente dono do endereço (OBRIGATÓRIO)
  code: varchar("code", { length: 50 }).notNull().unique(),
  aisle: varchar("aisle", { length: 10 }), // Rua
  rack: varchar("rack", { length: 10 }), // Prédio
  level: varchar("level", { length: 10 }), // Andar
  position: varchar("position", { length: 10 }), // Quadrante (obrigatório apenas para tipo "fraction")
  locationType: mysqlEnum("locationType", ["whole", "fraction"]).default("whole").notNull(), // Inteira ou Fração
  storageRule: mysqlEnum("storageRule", ["single", "multi"]).default("single").notNull(), // Único item/lote ou Multi-item
  status: mysqlEnum("status", ["available", "occupied", "blocked", "counting", "quarantine"]).default("available").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  zoneStatusIdx: index("zone_status_idx").on(table.zoneId, table.status),
  tenantStatusIdx: index("tenant_status_idx").on(table.tenantId, table.status),
  statusIdx: index("location_status_idx").on(table.status),
  tenantZoneCodeIdx: index("warehouseLocations_tenantId_zoneCode_idx").on(table.tenantId, table.zoneCode),
  codeIdx: index("warehouseLocations_code_idx").on(table.code),
}));

// ============================================================================
// MÓDULO 3: RECEBIMENTO
// ============================================================================

export const receivingOrders = mysqlTable("receivingOrders", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
  nfeKey: varchar("nfeKey", { length: 44 }), // Chave da NF-e (44 dígitos)
  nfeNumber: varchar("nfeNumber", { length: 20 }),
  supplierName: varchar("supplierName", { length: 255 }),
  supplierCnpj: varchar("supplierCnpj", { length: 18 }),
  scheduledDate: timestamp("scheduledDate"),
  receivedDate: timestamp("receivedDate"),
  receivingLocationId: int("receivingLocationId"), // Endereço REC alocado automaticamente
  addressingPlan: json("addressingPlan"), // Pré-alocação: [{productSku, batch, quantity, locationCode}]
  status: mysqlEnum("status", ["scheduled", "in_progress", "in_quarantine", "addressing", "completed", "cancelled", "pending_unit_setup"]).default("scheduled").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente), não o usuário logado
  tenantIdIdx: index("receivingOrders_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("receivingOrders_tenantId_status_idx").on(table.tenantId, table.status),
  nfeKeyIdx: index("receivingOrders_nfeKey_idx").on(table.nfeKey),
}));

export const receivingOrderItems = mysqlTable("receivingOrderItems", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Multi-tenant: item pertence a um cliente
  receivingOrderId: int("receivingOrderId").notNull(),
  productId: int("productId").notNull(),
  expectedQuantity: int("expectedQuantity").notNull(),
  receivedQuantity: int("receivedQuantity").default(0).notNull(),
  blockedQuantity: int("blockedQuantity").default(0).notNull(), // Quantidade avariada/bloqueada
  addressedQuantity: int("addressedQuantity").default(0).notNull(), // Saldo líquido endereçável (received - blocked)
  // Códigos esperados da NF-e
  expectedGtin: varchar("expectedGtin", { length: 14 }),
  expectedSupplierCode: varchar("expectedSupplierCode", { length: 50 }),
  expectedInternalCode: varchar("expectedInternalCode", { length: 50 }),
  // Códigos conferidos
  scannedGtin: varchar("scannedGtin", { length: 14 }),
  scannedSupplierCode: varchar("scannedSupplierCode", { length: 50 }),
  scannedInternalCode: varchar("scannedInternalCode", { length: 50 }),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  serialNumber: varchar("serialNumber", { length: 100 }),
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  labelCode: varchar("labelCode", { length: 100 }), // Código da etiqueta vinculada (após conferência)
  status: mysqlEnum("status", ["pending", "in_quarantine", "approved", "rejected", "awaiting_approval", "receiving", "completed"]).default("pending").notNull(),
  rejectionReason: text("rejectionReason"),
  approvedBy: int("approvedBy"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("receivingOrderItems_tenantId_idx").on(table.tenantId),
  receivingOrderIdIdx: index("receivingOrderItems_receivingOrderId_idx").on(table.receivingOrderId),
  productIdIdx: index("receivingOrderItems_productId_idx").on(table.productId),
  tenantStatusIdx: index("receivingOrderItems_status_idx").on(table.tenantId, table.status),
}));

// Tabela de pré-alocações de endereços (definidas antes do recebimento)
export const receivingPreallocations = mysqlTable("receivingPreallocations", {
  id: int("id").autoincrement().primaryKey(),
  receivingOrderId: int("receivingOrderId").notNull(),
  productId: int("productId").notNull(),
  locationId: int("locationId").notNull(), // Endereço de armazenagem pré-definido
  batch: varchar("batch", { length: 50 }),
  quantity: int("quantity").notNull(),
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  status: mysqlEnum("status", ["pending", "allocated", "cancelled"]).default("pending").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Tabela de conferências parciais (múltiplas conferências por item/lote)
export const receivingConferences = mysqlTable("receivingConferences", {
  id: int("id").autoincrement().primaryKey(),
  receivingOrderItemId: int("receivingOrderItemId").notNull(),
  batch: varchar("batch", { length: 50 }),
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  quantityConferenced: int("quantityConferenced").notNull(), // Quantidade conferida nesta conferência
  conferencedBy: int("conferencedBy").notNull(), // Operador que fez a conferência
  conferencedAt: timestamp("conferencedAt").defaultNow().notNull(),
  notes: text("notes"), // Observações (ex: "Palete 1 de 4")
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Tabela de divergências (sobras e faltas)
export const receivingDivergences = mysqlTable("receivingDivergences", {
  id: int("id").autoincrement().primaryKey(),
  receivingOrderItemId: int("receivingOrderItemId").notNull(),
  divergenceType: mysqlEnum("divergenceType", ["shortage", "surplus"]).notNull(), // falta ou sobra
  expectedQuantity: int("expectedQuantity").notNull(),
  receivedQuantity: int("receivedQuantity").notNull(),
  differenceQuantity: int("differenceQuantity").notNull(), // Diferença (positivo = sobra, negativo = falta)
  batch: varchar("batch", { length: 50 }),
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
  reportedBy: int("reportedBy").notNull(), // Operador que reportou
  reportedAt: timestamp("reportedAt").defaultNow().notNull(),
  approvedBy: int("approvedBy"), // Supervisor que aprovou
  approvedAt: timestamp("approvedAt"),
  justification: text("justification"), // Justificativa do supervisor
  fiscalAdjustment: boolean("fiscalAdjustment").default(false).notNull(), // Se já foi feito ajuste fiscal
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Tabela de não-conformidades (NCG)
export const nonConformities = mysqlTable("nonConformities", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Multi-tenant
  receivingOrderItemId: int("receivingOrderItemId").notNull(), // ID do item da ordem de recebimento
  labelCode: varchar("labelCode", { length: 100 }).notNull(), // Código da etiqueta com NCG
  conferenceId: int("conferenceId").notNull(), // ID da conferência onde foi registrado
  // REGRA XOR: locationId OU shippingId (nunca ambos, nunca nenhum)
  // - Em estoque: locationId preenchido, shippingId NULL
  // - Expedido: locationId NULL, shippingId preenchido
  // - CHECK CONSTRAINT: (locationId IS NOT NULL AND shippingId IS NULL) OR (locationId IS NULL AND shippingId IS NOT NULL)
  locationId: int("locationId"), // Localização atual do produto NCG (NCG inicialmente)
  shippingId: int("shippingId"), // ID da expedição (NULL se ainda em estoque)
  description: text("description").notNull(), // Descrição da não-conformidade (motivo)
  photoUrl: varchar("photoUrl", { length: 500 }), // URL da foto (opcional)
  registeredBy: int("registeredBy").notNull(), // userId do operador
  registeredAt: timestamp("registeredAt").defaultNow().notNull(),
}, (table) => ({
  labelCodeIdx: index("ncg_label_code_idx").on(table.labelCode),
  conferenceIdx: index("ncg_conference_idx").on(table.conferenceId),
  tenantIdIdx: index("ncg_tenant_id_idx").on(table.tenantId),
  locationIdx: index("ncg_location_idx").on(table.locationId),
  shippingIdx: index("ncg_shipping_idx").on(table.shippingId),
}));

export const divergenceApprovals = mysqlTable("divergenceApprovals", {
  id: int("id").autoincrement().primaryKey(),
  receivingOrderItemId: int("receivingOrderItemId").notNull(),
  requestedBy: int("requestedBy").notNull(),
  divergenceType: mysqlEnum("divergenceType", ["quantity", "code_mismatch", "expiry_date", "multiple"]).notNull(),
  divergenceDetails: text("divergenceDetails").notNull(), // JSON com detalhes da divergência
  justification: text("justification").notNull(),
  status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
  approvedBy: int("approvedBy"),
  approvalJustification: text("approvalJustification"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ============================================================================
// MÓDULO 4: ESTOQUE E ARMAZENAGEM
// ============================================================================

export const inventory = mysqlTable("inventory", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  productId: int("productId").notNull(),
  locationId: int("locationId").notNull(),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  labelCode: varchar("labelCode", { length: 255 }), // ✅ Código da etiqueta (LPN) para rastreabilidade
  serialNumber: varchar("serialNumber", { length: 100 }),
  locationZone: varchar("locationZone", { length: 10 }), // Zona do endereço (EXP, REC, NCG, DEV, etc.)
  quantity: int("quantity").default(0).notNull(),
  reservedQuantity: int("reservedQuantity").default(0).notNull(),
  // ⚠️ LIMITAÇÃO CONHECIDA (Risco 7.1 — Auditoria UOM):
  // reservedQuantity é int (sem casas decimais). Medicamentos com fatores de conversão
  // que gerem frações (ex: 10.5 UN) terão o valor arredondado silenciosamente pelo MySQL.
  // A validação de fração em resolvePickingFactor() (picking.ts) BLOQUEIA pedidos com
  // resultado fracionário ANTES de chegar aqui, eliminando o risco na prática.
  // Para suporte a quantidades fracionárias no futuro, migrar para decimal(10,4).
  status: mysqlEnum("status", ["available", "quarantine", "blocked", "damaged", "expired"]).default("available").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantProductIdx: index("tenant_product_idx").on(table.tenantId, table.productId),
  locationIdx: index("location_idx").on(table.locationId),
  // uniqueLabelIdx removido: o mesmo labelCode pode existir em múltiplas zonas (ex: REC available + NCG quarantine)
  // A unicidade é controlada pela lógica de negócio (1 labelCode por zona/status)
  labelCodeIdx: index("label_code_tenant_idx").on(table.labelCode, table.tenantId),
  // Índices adicionais — tenantId = dono da operação (cliente)
  tenantStatusIdx: index("inventory_tenantId_status_idx").on(table.tenantId, table.status),
  tenantLocationIdx: index("inventory_tenantId_locationId_idx").on(table.tenantId, table.locationId),
  tenantBatchIdx: index("inventory_batch_idx").on(table.tenantId, table.batch),
  tenantExpiryIdx: index("inventory_expiryDate_idx").on(table.tenantId, table.expiryDate),
  tenantQuantityIdx: index("inventory_quantity_idx").on(table.tenantId, table.quantity),
}));

export const inventoryMovements = mysqlTable("inventoryMovements", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  productId: int("productId").notNull(),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }), // ✅ Validade do lote (ANVISA — rastreabilidade completa)
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  labelCode: varchar("labelCode", { length: 100 }), // ✅ Código da etiqueta (rastreabilidade completa)
  serialNumber: varchar("serialNumber", { length: 100 }),
  fromLocationId: int("fromLocationId"),
  toLocationId: int("toLocationId"),
  quantity: int("quantity").notNull(),
  movementType: mysqlEnum("movementType", ["receiving", "put_away", "picking", "transfer", "adjustment", "return", "disposal", "quality"]).notNull(),
  referenceType: varchar("referenceType", { length: 50 }), // Ex: "receiving_order", "picking_order"
  referenceId: int("referenceId"),
  performedBy: int("performedBy").notNull(),
  notes: text("notes"),
  // ✅ Rastreabilidade ANVISA: campos de conversão de unidades de medida
  originalUnit: varchar("originalUnit", { length: 50 }),     // Unidade original do XML (ex: CX, FD, PÇ)
  originalQty: decimal("originalQty", { precision: 18, scale: 6 }), // Quantidade original antes da conversão
  conversionFactor: decimal("conversionFactor", { precision: 18, scale: 6 }), // Fator aplicado
  conversionSource: mysqlEnum("conversionSource", ["uTrib", "uCom", "manual", "none"]), // Origem da conversão
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantProductIdx: index("tenant_product_movement_idx").on(table.tenantId, table.productId),
  createdAtIdx: index("created_at_idx").on(table.createdAt),
  // Índices adicionais — tenantId = dono da operação (cliente)
  tenantMovementTypeIdx: index("inventoryMovements_tenantId_movementType_idx").on(table.tenantId, table.movementType),
  labelCodeIdx: index("inventoryMovements_labelCode_idx").on(table.labelCode),
  referenceIdx: index("inventoryMovements_referenceId_idx").on(table.referenceType, table.referenceId),
}));

// ============================================================================
// MÓDULO 5: SEPARAÇÃO DE PEDIDOS (PICKING)
// ============================================================================

export const pickingOrders = mysqlTable("pickingOrders", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  orderNumber: varchar("orderNumber", { length: 50 }).notNull().unique(),
  customerOrderNumber: varchar("customerOrderNumber", { length: 100 }), // Número do pedido do cliente (numeração interna)
  customerName: varchar("customerName", { length: 255 }), // Nome do destinatário (texto livre do pedido original)
  deliveryAddress: text("deliveryAddress"),
  priority: mysqlEnum("priority", ["emergency", "urgent", "normal", "low"]).default("normal").notNull(),
  status: mysqlEnum("status", ["pending", "validated", "in_wave", "in_progress", "paused", "picking", "picked", "divergent", "checking", "packed", "staged", "invoiced", "collected", "shipped", "cancelled"]).default("pending").notNull(),
  shippingStatus: mysqlEnum("shippingStatus", ["awaiting_invoice", "invoice_linked", "in_manifest", "collected", "shipped"]), // Status de expedição
  totalItems: int("totalItems").default(0).notNull(), // Total de linhas de itens
  totalQuantity: int("totalQuantity").default(0).notNull(), // Quantidade total de unidades
  scheduledDate: timestamp("scheduledDate"), // Data agendada para separação
  assignedTo: int("assignedTo"), // Separador atribuído
  pickedBy: int("pickedBy"), // Quem realmente separou
  pickedAt: timestamp("pickedAt"),
  checkedBy: int("checkedBy"), // Conferente (DEVE ser diferente de pickedBy)
  checkedAt: timestamp("checkedAt"),
  packedBy: int("packedBy"),
  packedAt: timestamp("packedAt"),
  shippedAt: timestamp("shippedAt"),
  waveId: int("waveId"), // Onda de separação (futuro)
  notes: text("notes"), // Observações gerais
  nfeNumber: varchar("nfeNumber", { length: 20 }), // Número da NF-e de saída
  nfeKey: varchar("nfeKey", { length: 44 }), // Chave de acesso da NF-e (44 dígitos)
  isLegacyImported: boolean("isLegacyImported").default(false).notNull(), // Pedido importado do sistema legado (bypass FEFO/FIFO)
  orderType: mysqlEnum("orderType", ["customer_order", "inventory_surplus"]).default("customer_order").notNull(), // Tipo da ordem
  inventoryId: int("inventoryId"), // Referência ao inventário (para INVENTORY_SURPLUS)
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente do pedido)
  tenantIdIdx: index("pickingOrders_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("pickingOrders_tenantId_status_idx").on(table.tenantId, table.status),
  tenantShippingStatusIdx: index("pickingOrders_tenantId_shippingStatus_idx").on(table.tenantId, table.shippingStatus),
  customerOrderNumberIdx: index("pickingOrders_customerOrderNumber_idx").on(table.customerOrderNumber),
  waveIdIdx: index("pickingOrders_waveId_idx").on(table.waveId),
  nfeKeyIdx: index("pickingOrders_nfeKey_idx").on(table.nfeKey),
}));
export const pickingOrderItems = mysqlTable("pickingOrderItems", {
  id: int("id").autoincrement().primaryKey(),
  pickingOrderId: int("pickingOrderId").notNull(),
  productId: int("productId").notNull(),
  requestedQuantity: int("requestedQuantity").notNull(),
  requestedUM: mysqlEnum("requestedUM", ["unit", "box", "pallet"]).default("unit").notNull(), // Unidade de Medida solicitada
  unit: mysqlEnum("unit", ["unit", "box"]).default("unit").notNull(), // Unidade do pedido original (para rastreabilidade)
  unitsPerBox: int("unitsPerBox"), // Unidades por caixa (quando unit=box)
  pickedQuantity: int("pickedQuantity").default(0).notNull(),
  pickedUM: mysqlEnum("pickedUM", ["unit", "box", "pallet"]).default("unit").notNull(),
  batch: varchar("batch", { length: 50 }), // Lote separado (FEFO)
  expiryDate: date("expiryDate", { mode: "string" }), // Validade do lote
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única para rastreabilidade)
  serialNumber: varchar("serialNumber", { length: 100 }),
  fromLocationId: int("fromLocationId"), // Endereço de origem
  inventoryId: int("inventoryId"), // Referência ao registro de estoque usado
  status: mysqlEnum("status", ["pending", "picking", "picked", "short_picked", "exception", "cancelled"]).default("pending").notNull(),
  pickedBy: int("pickedBy"),
  pickedAt: timestamp("pickedAt"),
  exceptionReason: text("exceptionReason"), // Motivo de exceção (falta, avaria, etc)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  pickingOrderIdIdx: index("pickingOrderItems_pickingOrderId_idx").on(table.pickingOrderId),
  productIdIdx: index("pickingOrderItems_productId_idx").on(table.productId),
  statusIdx: index("pickingOrderItems_status_idx").on(table.pickingOrderId, table.status),
}));



// ============================================================================
// MÓDULO 6: EXPEDIÇÃO
// ============================================================================

export const shipments = mysqlTable("shipments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  shipmentNumber: varchar("shipmentNumber", { length: 50 }).notNull().unique(),
  pickingOrderId: int("pickingOrderId"),
  carrierName: varchar("carrierName", { length: 255 }),
  vehiclePlate: varchar("vehiclePlate", { length: 20 }),
  driverName: varchar("driverName", { length: 255 }),
  trackingNumber: varchar("trackingNumber", { length: 100 }),
  shippedAt: timestamp("shippedAt"),
  deliveredAt: timestamp("deliveredAt"),
  status: mysqlEnum("status", ["pending", "loaded", "in_transit", "delivered", "returned"]).default("pending").notNull(),
  requiresColdChain: boolean("requiresColdChain").default(false).notNull(),
  temperatureLoggerSerial: varchar("temperatureLoggerSerial", { length: 100 }),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ============================================================================
// MÓDULO 7: INVENTÁRIO
// ============================================================================

export const inventoryCounts = mysqlTable("inventoryCounts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  countNumber: varchar("countNumber", { length: 50 }).notNull().unique(),
  countType: mysqlEnum("countType", ["full_blind", "cyclic", "spot"]).notNull(),
  status: mysqlEnum("status", ["scheduled", "in_progress", "completed", "cancelled"]).default("scheduled").notNull(),
  scheduledDate: timestamp("scheduledDate"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const inventoryCountItems = mysqlTable("inventoryCountItems", {
  id: int("id").autoincrement().primaryKey(),
  inventoryCountId: int("inventoryCountId").notNull(),
  locationId: int("locationId").notNull(),
  productId: int("productId"),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  serialNumber: varchar("serialNumber", { length: 100 }),
  systemQuantity: int("systemQuantity").default(0).notNull(),
  countedQuantity: int("countedQuantity"),
  variance: int("variance").default(0).notNull(),
  countedBy: int("countedBy"),
  countedAt: timestamp("countedAt"),
  adjustmentReason: text("adjustmentReason"),
  adjustedBy: int("adjustedBy"),
  adjustedAt: timestamp("adjustedAt"),
  status: mysqlEnum("status", ["pending", "counted", "variance", "adjusted"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ============================================================================
// MÓDULO 8: QUALIDADE E RECALL
// ============================================================================

export const recalls = mysqlTable("recalls", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  recallNumber: varchar("recallNumber", { length: 50 }).notNull().unique(),
  productId: int("productId").notNull(),
  affectedBatches: text("affectedBatches").notNull(), // JSON array de lotes afetados
  reason: text("reason").notNull(),
  severity: mysqlEnum("severity", ["critical", "high", "medium", "low"]).default("high").notNull(),
  status: mysqlEnum("status", ["active", "in_progress", "completed", "cancelled"]).default("active").notNull(),
  initiatedBy: int("initiatedBy").notNull(),
  initiatedAt: timestamp("initiatedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const returns = mysqlTable("returns", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  returnNumber: varchar("returnNumber", { length: 50 }).notNull().unique(),
  shipmentId: int("shipmentId"),
  returnReason: text("returnReason"),
  status: mysqlEnum("status", ["pending", "received", "inspected", "approved", "rejected", "disposed"]).default("pending").notNull(),
  inspectedBy: int("inspectedBy"),
  inspectedAt: timestamp("inspectedAt"),
  disposition: mysqlEnum("disposition", ["restock", "quarantine", "dispose"]),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ============================================================================
// MÓDULO 8.5: ENDEREÇAMENTO PRÉ-DEFINIDO
// ============================================================================

export const productLocationMapping = mysqlTable("productLocationMapping", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  productId: int("productId").notNull(),
  suggestedLocationId: int("suggestedLocationId").notNull(), // Endereço sugerido para armazenagem
  priority: int("priority").default(1).notNull(), // Prioridade (1 = maior prioridade)
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  productIdx: index("product_idx").on(table.productId),
  tenantProductIdx: index("tenant_product_idx").on(table.tenantId, table.productId),
}));

// ============================================================================
// MÓDULO 9: AUDITORIA E LOGS
// ============================================================================

export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  userId: int("userId").notNull(),
  action: varchar("action", { length: 100 }).notNull(), // Ex: "approve_quarantine", "adjust_inventory"
  entityType: varchar("entityType", { length: 50 }).notNull(), // Ex: "receiving_order", "inventory"
  entityId: int("entityId"),
  oldValue: text("oldValue"), // JSON do estado anterior
  newValue: text("newValue"), // JSON do novo estado
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  signature: text("signature"), // Assinatura eletrônica (hash)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantUserIdx: index("tenant_user_idx").on(table.tenantId, table.userId),
  entityIdx: index("entity_idx").on(table.entityType, table.entityId),
  createdAtIdx: index("audit_created_at_idx").on(table.createdAt),
}));

// ============================================================================
// HISTÓRICO DE IMPRESSÃO DE ETIQUETAS
// ============================================================================

export const labelPrintHistory = mysqlTable("labelPrintHistory", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  userId: int("userId").notNull(),
  receivingOrderId: int("receivingOrderId").notNull(),
  nfeNumber: varchar("nfeNumber", { length: 50 }),
  labelCount: int("labelCount").notNull(),
  labelData: text("labelData").notNull(), // JSON com dados das etiquetas impressas
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantUserIdx: index("label_print_tenant_user_idx").on(table.tenantId, table.userId),
  receivingOrderIdx: index("label_print_order_idx").on(table.receivingOrderId),
  createdAtIdx: index("label_print_created_at_idx").on(table.createdAt),
}));

// ============================================================================
// CONFERÊNCIA CEGA POR ASSOCIAÇÃO DE ETIQUETAS
// ============================================================================

// Sessão de conferência cega
export const blindConferenceSessions = mysqlTable("blindConferenceSessions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"),
  receivingOrderId: int("receivingOrderId").notNull(),
  startedBy: int("startedBy").notNull(), // userId
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
  finishedBy: int("finishedBy"), // userId
  status: mysqlEnum("status", ["active", "completed", "cancelled"]).default("active").notNull(),
}, (table) => ({
  receivingOrderIdx: index("blind_conf_order_idx").on(table.receivingOrderId),
  statusIdx: index("blind_conf_status_idx").on(table.status),
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("blindConferenceSessions_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("blindConferenceSessions_tenantId_status_idx").on(table.tenantId, table.status),
}));

// Itens da conferência cega (progresso por produto)
export const blindConferenceItems = mysqlTable("blindConferenceItems", {
  id: int("id").autoincrement().primaryKey(),
  conferenceId: int("conferenceId").notNull(), // FK para blindConferenceSessions
  productId: int("productId").notNull(), // FK para products
  batch: varchar("batch", { length: 100 }).notNull(), // Lote do produto
  expiryDate: date("expiryDate", { mode: "string" }), // Data de validade do lote
  packagesRead: int("packagesRead").default(0).notNull(), // Contador de embalagens bipadas
  unitsRead: int("unitsRead").default(0).notNull(), // Total de unidades lidas (packagesRead * unitsPerBox)
  expectedQuantity: int("expectedQuantity").default(0).notNull(), // Quantidade esperada (da NF)
  tenantId: int("tenantId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").onUpdateNow(),
}, (table) => ({
  // CONSTRAINT CRÍTICA: 1 registro por conferência + produto + lote
  conferenceProductBatchUnique: uniqueIndex("conf_product_batch_idx").on(table.conferenceId, table.productId, table.batch),
  conferenceIdx: index("blind_conf_items_conf_idx").on(table.conferenceId),
  productIdx: index("blind_conf_items_product_idx").on(table.productId),
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("blindConferenceItems_tenantId_idx").on(table.tenantId),
}));

// Associações de etiquetas a produtos/lotes
export const labelAssociations = mysqlTable("labelAssociations", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Multi-tenant: etiqueta pertence a um cliente
  labelCode: varchar("labelCode", { length: 100 }).notNull().unique(), // Código da etiqueta lida (1 etiqueta = 1 registro)
  uniqueCode: varchar("uniqueCode", { length: 200 }).notNull(), // SKU+Lote (garantidor de 100% rastreabilidade)
  productId: int("productId").notNull(),
  batch: varchar("batch", { length: 100 }),
  expiryDate: date("expiryDate", { mode: "string" }), // Data de validade do lote
  unitsPerBox: int("unitsPerBox").notNull(), // Quantidade de unidades por caixa
  associatedBy: int("associatedBy").notNull(), // userId
  associatedAt: timestamp("associatedAt").defaultNow().notNull(),
  status: mysqlEnum("status", ["RECEIVING", "AVAILABLE", "BLOCKED", "EXPIRED"]).default("AVAILABLE").notNull(), // Status da etiqueta no estoque
}, (table) => ({
  labelCodeIdx: index("label_assoc_label_code_idx").on(table.labelCode),
  uniqueCodeIdx: index("label_assoc_unique_code_idx").on(table.uniqueCode),
  tenantIdIdx: index("label_assoc_tenant_id_idx").on(table.tenantId),
  // Índices adicionais — tenantId = dono da operação (cliente)
  tenantProductIdx: index("labelAssociations_tenantId_productId_idx").on(table.tenantId, table.productId),
  tenantStatusIdx: index("labelAssociations_tenantId_status_idx").on(table.tenantId, table.status),
  tenantBatchIdx: index("labelAssociations_batch_idx").on(table.tenantId, table.batch),
}));

// Histórico de leituras de etiquetas
export const labelReadings = mysqlTable("labelReadings", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: varchar("sessionId", { length: 20 }).notNull(), // "R10002" ou "P10002"
  associationId: int("associationId").notNull(),
  labelCode: varchar("labelCode", { length: 100 }).notNull(),
  readBy: int("readBy").notNull(), // userId
  readAt: timestamp("readAt").defaultNow().notNull(),
  unitsAdded: int("unitsAdded").notNull(), // Unidades adicionadas nesta leitura
}, (table) => ({
  sessionIdx: index("label_read_session_idx").on(table.sessionId),
  associationIdx: index("label_read_assoc_idx").on(table.associationId),
}));

// Ajustes manuais de quantidade
export const blindConferenceAdjustments = mysqlTable("blindConferenceAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull().default(0),
  associationId: int("associationId").notNull().default(0),
  previousQuantity: int("previousQuantity").notNull().default(0),
  conferenceId: int("conferenceId").notNull(),
  productId: int("productId").notNull(),
  batch: varchar("batch", { length: 100 }),
  oldQuantity: int("oldQuantity").notNull(),
  newQuantity: int("newQuantity").notNull(),
  reason: text("reason"),
  adjustedBy: int("adjustedBy").notNull(), // userId
  adjustedAt: timestamp("adjustedAt").defaultNow().notNull(),
}, (table) => ({
  conferenceIdx: index("blind_adj_conference_idx").on(table.conferenceId),
}));

// Auditoria de Picking (rastreabilidade de regras aplicadas)
export const pickingAuditLogs = mysqlTable("pickingAuditLogs", {
  id: int("id").autoincrement().primaryKey(),
  pickingOrderId: int("pickingOrderId").notNull(),
  tenantId: int("tenantId").notNull(),
  pickingRule: mysqlEnum("pickingRule", ["FIFO", "FEFO", "Direcionado"]).notNull(),
  productId: int("productId").notNull(),
  requestedQuantity: int("requestedQuantity").notNull(),
  allocatedLocations: json("allocatedLocations").notNull(), // Array de alocações
  userId: int("userId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  orderIdx: index("picking_audit_order_idx").on(table.pickingOrderId),
  tenantIdx: index("picking_audit_tenant_idx").on(table.tenantId),
  ruleIdx: index("picking_audit_rule_idx").on(table.pickingRule),
}));

// ============================================================================
// MÓDULO: SEPARAÇÃO POR ONDA (WAVE PICKING)
// ============================================================================

/**
 * Tabela de ondas de separação
 * Agrupa múltiplos pedidos do mesmo cliente para otimizar picking
 */
export const pickingWaves = mysqlTable("pickingWaves", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Cliente da onda
  waveNumber: varchar("waveNumber", { length: 50 }).notNull().unique(), // Número único da OS
  status: mysqlEnum("status", ["pending", "picking", "picked", "staged", "completed", "cancelled"]).default("pending").notNull(),
  totalOrders: int("totalOrders").default(0).notNull(), // Quantidade de pedidos agrupados
  totalItems: int("totalItems").default(0).notNull(), // Total de linhas consolidadas
  totalQuantity: int("totalQuantity").default(0).notNull(), // Quantidade total de unidades
  pickingRule: mysqlEnum("pickingRule", ["FIFO", "FEFO", "Direcionado"]).notNull(), // Regra aplicada
  assignedTo: int("assignedTo"), // Separador atribuído
  pickedBy: int("pickedBy"), // Quem realmente separou
  pickedAt: timestamp("pickedAt"),
  stagedBy: int("stagedBy"), // Quem fez a segregação em stage
  stagedAt: timestamp("stagedAt"),
  notes: text("notes"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantIdx: index("wave_tenant_idx").on(table.tenantId),
  statusIdx: index("wave_status_idx").on(table.status),
  // Índice composto — tenantId = dono da onda (cliente)
  tenantStatusIdx: index("pickingWaves_tenantId_status_idx").on(table.tenantId, table.status),
}));

/**
 * Tabela de itens consolidados da onda
 * Produtos + quantidades totais + endereços alocados
 */
export const pickingWaveItems = mysqlTable("pickingWaveItems", {
  id: int("id").autoincrement().primaryKey(),
  waveId: int("waveId").notNull(),
  pickingOrderId: int("pickingOrderId").notNull(), // Pedido de origem do item
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  totalQuantity: int("totalQuantity").notNull(), // Quantidade consolidada
  pickedQuantity: int("pickedQuantity").default(0).notNull(), // Quantidade já separada
  unit: mysqlEnum("unit", ["unit", "box"]).default("unit").notNull(), // Unidade do pedido original
  unitsPerBox: int("unitsPerBox"),
  locationId: int("locationId").notNull(), // Endereço alocado (FIFO/FEFO)
  locationCode: varchar("locationCode", { length: 50 }).notNull(), // Código do endereço (ex: H01-08-02)
  batch: varchar("batch", { length: 100 }), // Lote sugerido
  expiryDate: date("expiryDate", { mode: "string" }), // Validade do lote
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  labelCode: varchar("labelCode", { length: 200 }), // Código da etiqueta (rastreabilidade)
  status: mysqlEnum("status", ["pending", "picking", "picked"]).default("pending").notNull(),
  pickedAt: timestamp("pickedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  waveIdx: index("wave_item_wave_idx").on(table.waveId),
  productIdx: index("wave_item_product_idx").on(table.productId),
  locationIdx: index("wave_item_location_idx").on(table.locationId),
  orderIdx: index("wave_item_order_idx").on(table.pickingOrderId), // Índice para buscar por pedido
  waveStatusIdx: index("pickingWaveItems_status_idx").on(table.waveId, table.status),
  labelCodeIdx: index("pickingWaveItems_labelCode_idx").on(table.labelCode),
}));

// ============================================================================
// MÓDULO 9: PRÉ-ALOCAÇÃO DE PICKING (FEFO/FIFO/Direcionado)
// ============================================================================

/**
 * Tabela de pré-alocações de picking
 * Persiste lotes e endereços pré-alocados ao gerar pedido/onda
 * Permite fluxo guiado por endereço no coletor
 */
export const pickingAllocations = mysqlTable("pickingAllocations", {
  id: int("id").autoincrement().primaryKey(),
  pickingOrderId: int("pickingOrderId").notNull(),
  waveId: int("waveId"), // 🚀 Onda associada (para cancelamento atômico)
  inventoryId: int("inventoryId"), // 🚀 Registro exato de estoque reservado (rastreabilidade atômica)
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }).notNull(),
  locationId: int("locationId").notNull(), // Endereço pré-alocado
  locationCode: varchar("locationCode", { length: 50 }).notNull(),
  batch: varchar("batch", { length: 100 }), // Lote pré-alocado
  expiryDate: date("expiryDate", { mode: "string" }), // Validade do lote
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  labelCode: varchar("labelCode", { length: 100 }), // Código da etiqueta (rastreabilidade completa)
  quantity: int("quantity").notNull(), // Quantidade a separar
  isFractional: boolean("isFractional").default(false).notNull(), // Item fracionado?
  sequence: int("sequence").notNull(), // Ordem de visitação (endereços ordenados)
  status: mysqlEnum("status", ["pending", "in_progress", "picked", "short_picked"]).default("pending").notNull(),
  pickedQuantity: int("pickedQuantity").default(0).notNull(), // Quantidade efetivamente separada
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  orderIdx: index("allocation_order_idx").on(table.pickingOrderId),
  locationIdx: index("allocation_location_idx").on(table.locationId),
  sequenceIdx: index("allocation_sequence_idx").on(table.pickingOrderId, table.sequence),
  waveIdIdx: index("pickingAllocations_waveId_idx").on(table.waveId),
  productIdIdx: index("pickingAllocations_productId_idx").on(table.productId),
  statusIdx: index("pickingAllocations_status_idx").on(table.pickingOrderId, table.status),
  labelCodeIdx: index("pickingAllocations_labelCode_idx").on(table.labelCode),
}));

/**
 * Tabela de progresso de picking
 * Salva estado atual do picking para permitir pausa/retomada
 */
export const pickingProgress = mysqlTable("pickingProgress", {
  id: int("id").autoincrement().primaryKey(),
  pickingOrderId: int("pickingOrderId").notNull(), // Um progresso por pedido
  currentSequence: int("currentSequence").default(1).notNull(), // Índice do endereço atual
  currentLocationId: int("currentLocationId"), // Endereço em que o operador está
  scannedItems: json("scannedItems"), // JSON com itens já bipados
  pausedAt: timestamp("pausedAt"),
  pausedBy: int("pausedBy"), // Operador que pausou
  resumedAt: timestamp("resumedAt"),
  resumedBy: int("resumedBy"), // Operador que retomou
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  orderIdx: unique().on(table.pickingOrderId), // Um progresso por pedido
}));

// ============================================================================
// MÓDULO 10: STAGE (CONFERÊNCIA DE EXPEDIÇÃO)
// ============================================================================

/**
 * Tabela de conferências de expedição (Stage)
 * Registra conferências cegas de pedidos antes da expedição
 */
export const stageChecks = mysqlTable("stageChecks", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  pickingOrderId: int("pickingOrderId").notNull(),
  customerOrderNumber: varchar("customerOrderNumber", { length: 100 }).notNull(),
  operatorId: int("operatorId").notNull(), // Usuário que fez a conferência
  status: mysqlEnum("status", ["in_progress", "completed", "divergent"]).default("in_progress").notNull(),
  hasDivergence: boolean("hasDivergence").default(false).notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  notes: text("notes"),
  totalVolumes: int("totalVolumes"), // Quantidade de volumes informada ao gerar etiquetas no Stage
  // Campos de controle de sessão / trava de concorrência
  lockedByUserId: int("lockedByUserId"), // ID do usuário com a trava ativa
  lockedByName: varchar("lockedByName", { length: 200 }), // Nome para exibir no alerta
  lastActivityAt: timestamp("lastActivityAt"), // Última atividade (heartbeat)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantIdx: index("stage_check_tenant_idx").on(table.tenantId),
  orderIdx: index("stage_check_order_idx").on(table.pickingOrderId),
  statusIdx: index("stage_check_status_idx").on(table.status),
  // Índices adicionais — tenantId = dono da operação (cliente)
  tenantStatusIdx: index("stageChecks_tenantId_status_idx").on(table.tenantId, table.status),
  customerOrderNumberIdx: index("stageChecks_customerOrderNumber_idx").on(table.customerOrderNumber),
}));

/**
 * Tabela de itens conferidos no Stage
 * Registra cada produto conferido com quantidade esperada vs conferida
 */
export const stageCheckItems = mysqlTable("stageCheckItems", {
  id: int("id").autoincrement().primaryKey(),
  stageCheckId: int("stageCheckId").notNull(),
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }).notNull(),
  productName: varchar("productName", { length: 255 }).notNull(),
  batch: varchar("batch", { length: 100 }), // Lote esperado (null = sem validação de lote)
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  expectedQuantity: int("expectedQuantity").notNull(), // Quantidade separada
  checkedQuantity: int("checkedQuantity").default(0).notNull(), // Quantidade conferida
  divergence: int("divergence").default(0).notNull(), // Diferença (conferido - esperado)
  scannedAt: timestamp("scannedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  checkIdx: index("stage_item_check_idx").on(table.stageCheckId),
  productIdx: index("stage_item_product_idx").on(table.productId),
}));

/**
 * Tabela global de etiquetas de produtos
 * Mapeia códigos de etiqueta (SKU+Lote) para produtos e lotes de forma permanente
 * Permite reconhecimento de etiquetas em qualquer módulo do sistema
 */
export const productLabels = mysqlTable("productLabels", {
  id: int("id").autoincrement().primaryKey(),
  labelCode: varchar("labelCode", { length: 200 }).notNull().unique(), // SKU + Lote (ex: 401460P22D08LB109)
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }).notNull(),
  batch: varchar("batch", { length: 100 }).notNull(),
  expiryDate: date("expiryDate", { mode: "string" }), // Data de validade do lote
  createdBy: int("createdBy").notNull(), // userId que gerou a etiqueta
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  labelCodeIdx: index("product_label_code_idx").on(table.labelCode),
  productIdx: index("product_label_product_idx").on(table.productId),
  skuBatchIdx: index("product_label_sku_batch_idx").on(table.productSku, table.batch),
}));

// ============================================================================
// PREFERÊNCIAS DE IMPRESSÃO
// ============================================================================

/**
 * Tabela de preferências de impressão por usuário
 * Armazena configurações personalizadas para impressão de etiquetas
 */
export const printSettings = mysqlTable("printSettings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(), // Relacionamento com users.id
  defaultFormat: mysqlEnum("defaultFormat", ["zpl", "pdf"]).default("zpl").notNull(),
  defaultCopies: int("defaultCopies").default(1).notNull(),
  labelSize: varchar("labelSize", { length: 50 }).default("4x2").notNull(), // 4x2 polegadas
  printerDpi: int("printerDpi").default(203).notNull(), // 203 DPI (8dpmm)
  autoPrint: boolean("autoPrint").default(true).notNull(), // Abrir diálogo automaticamente
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: unique().on(table.userId), // Um registro por usuário
}));

// ============================================================================
// MÓDULO DE EXPEDIÇÃO (SHIPPING)
// ============================================================================

/**
 * Notas Fiscais (Invoices)
 * Armazena XMLs de NF-e importados e vinculação com pedidos
 */
export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  invoiceNumber: varchar("invoiceNumber", { length: 20 }).notNull(), // Número da NF
  series: varchar("series", { length: 5 }).notNull(), // Série da NF
  invoiceKey: varchar("invoiceKey", { length: 44 }).notNull().unique(), // Chave de acesso (44 dígitos)
  customerId: int("customerId").notNull(), // Cliente (tenant)
  customerName: varchar("customerName", { length: 255 }),
  customerCity: varchar("customerCity", { length: 100 }), // Município do destinatário
  customerState: varchar("customerState", { length: 2 }), // UF do destinatário
  pickingOrderId: int("pickingOrderId"), // Pedido vinculado
  xmlData: json("xmlData"), // Dados completos do XML
  volumes: int("volumes"), // Quantidade de volumes
  pesoB: decimal("pesoB", { precision: 10, scale: 3 }), // Peso bruto em kg
  totalValue: decimal("totalValue", { precision: 15, scale: 2 }), // Valor total da NF
  issueDate: timestamp("issueDate"), // Data de emissão
  status: mysqlEnum("status", ["imported", "linked", "in_manifest", "shipped"]).default("imported").notNull(),
  importedBy: int("importedBy").notNull(),
  importedAt: timestamp("importedAt").defaultNow().notNull(),
  linkedAt: timestamp("linkedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("invoices_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("invoices_tenantId_status_idx").on(table.tenantId, table.status),
  pickingOrderIdIdx: index("invoices_pickingOrderId_idx").on(table.pickingOrderId),
  invoiceNumberIdx: index("invoices_invoiceNumber_idx").on(table.tenantId, table.invoiceNumber),
}));

/**
 * Itens de Notas Fiscais de Saída (Picking Invoice Items)
 * Armazena itens individuais da NF-e de saída para rastreabilidade e queries eficientes
 */
export const pickingInvoiceItems = mysqlTable("pickingInvoiceItems", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(), // Referência à NF-e
  productId: int("productId"), // Produto vinculado (pode ser null se não encontrado)
  sku: varchar("sku", { length: 100 }).notNull(), // SKU/Código do produto na NF-e
  productName: varchar("productName", { length: 255 }).notNull(), // Nome do produto
  batch: varchar("batch", { length: 50 }), // Lote
  expiryDate: date("expiryDate", { mode: "string" }), // Validade
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  quantity: int("quantity").notNull(), // Quantidade (sempre em unidades)
  quantityUM: mysqlEnum("quantityUM", ["unit", "box", "pallet"]).default("unit").notNull(),lue: decimal("totalValue", { precision: 15, scale: 2 }), // Valor total do item
  ncm: varchar("ncm", { length: 10 }), // Código NCM
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("picking_invoice_items_invoice_idx").on(table.invoiceId),
  productIdx: index("picking_invoice_items_product_idx").on(table.productId),
  uniqueCodeIdx: index("picking_invoice_items_unique_code_idx").on(table.uniqueCode),
}));

/**
 * Itens de Notas Fiscais de Entrada (Receiving Invoice Items)
 * Armazena itens individuais da NF-e de entrada para rastreabilidade e queries eficientes
 */
export const receivingInvoiceItems = mysqlTable("receivingInvoiceItems", {
  id: int("id").autoincrement().primaryKey(),
  receivingOrderId: int("receivingOrderId").notNull(), // Referência ao pedido de recebimento
  nfeKey: varchar("nfeKey", { length: 44 }), // Chave da NF-e (44 dígitos)
  nfeNumber: varchar("nfeNumber", { length: 20 }), // Número da NF-e
  productId: int("productId"), // Produto vinculado (pode ser null se não encontrado)
  sku: varchar("sku", { length: 100 }).notNull(), // SKU/Código do produto na NF-e
  productName: varchar("productName", { length: 255 }).notNull(), // Nome do produto
  batch: varchar("batch", { length: 50 }), // Lo  expiryDate: date("expiryDate", { mode: "string" }), // Validade
  uniqueCode: varchar("uniqueCode", { length: 200 }), // SKU+Lote (chave única)
  quantity: int("quantity").notNull(), // Quantidade (sempre em unidades)
  divergence: int("divergence"), // Diferença (conferido - esperado)/ Valor unitário
  totalValue: decimal("totalValue", { precision: 15, scale: 2 }), // Valor total do item
  ncm: varchar("ncm", { length: 10 }), // Código NCM
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  receivingOrderIdx: index("receiving_invoice_items_order_idx").on(table.receivingOrderId),
  productIdx: index("receiving_invoice_items_product_idx").on(table.productId),
  uniqueCodeIdx: index("receiving_invoice_items_unique_code_idx").on(table.uniqueCode),
  nfeKeyIdx: index("receiving_invoice_items_nfe_key_idx").on(table.nfeKey),
}));

/**
 * Romaneios de Transporte (Shipment Manifests)
 * Consolida múltiplos pedidos e NFs para uma transportadora
 */
export const shipmentManifests = mysqlTable("shipmentManifests", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  manifestNumber: varchar("manifestNumber", { length: 50 }).notNull().unique(),
  carrierId: int("carrierId"), // Transportadora (relacionamento futuro)
  carrierName: varchar("carrierName", { length: 255 }),
  totalOrders: int("totalOrders").default(0).notNull(),
  totalInvoices: int("totalInvoices").default(0).notNull(),
  totalVolumes: int("totalVolumes").default(0).notNull(),
  status: mysqlEnum("status", ["draft", "ready", "collected", "shipped"]).default("draft").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  collectedAt: timestamp("collectedAt"),
  shippedAt: timestamp("shippedAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  // tenantId = dono da operação (cliente)
  tenantIdIdx: index("shipmentManifests_tenantId_idx").on(table.tenantId),
  tenantStatusIdx: index("shipmentManifests_tenantId_status_idx").on(table.tenantId, table.status),
}));

/**
 * Itens do Romaneio
 * Relaciona pedidos e NFs a um romaneio específico
 */
export const shipmentManifestItems = mysqlTable("shipmentManifestItems", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  pickingOrderId: int("pickingOrderId").notNull(),
  invoiceId: int("invoiceId").notNull(),
  volumes: int("volumes"),
  addedAt: timestamp("addedAt").defaultNow().notNull(),
}, (table) => ({
  manifestOrderIdx: unique().on(table.manifestId, table.pickingOrderId), // Pedido não pode estar em mais de um romanéio
  manifestIdIdx: index("shipmentManifestItems_manifestId_idx").on(table.manifestId),
  pickingOrderIdIdx: index("shipmentManifestItems_pickingOrderId_idx").on(table.pickingOrderId),
  invoiceIdIdx: index("shipmentManifestItems_invoiceId_idx").on(table.invoiceId),
}));

// ============================================================================
// TIPOS EXPORTADOS
// ============================================================================

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type Contract = typeof contracts.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type WarehouseZone = typeof warehouseZones.$inferSelect;
export type WarehouseLocation = typeof warehouseLocations.$inferSelect;
export type ReceivingOrder = typeof receivingOrders.$inferSelect;
export type ReceivingOrderItem = typeof receivingOrderItems.$inferSelect;
export type Inventory = typeof inventory.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type PickingOrder = typeof pickingOrders.$inferSelect;
export type PickingOrderItem = typeof pickingOrderItems.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type InventoryCount = typeof inventoryCounts.$inferSelect;
export type InventoryCountItem = typeof inventoryCountItems.$inferSelect;
export type Recall = typeof recalls.$inferSelect;
export type Return = typeof returns.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type LabelPrintHistory = typeof labelPrintHistory.$inferSelect;
export type InsertLabelPrintHistory = typeof labelPrintHistory.$inferInsert;
export type BlindConferenceSession = typeof blindConferenceSessions.$inferSelect;
export type InsertBlindConferenceSession = typeof blindConferenceSessions.$inferInsert;
export type LabelAssociation = typeof labelAssociations.$inferSelect;
export type InsertLabelAssociation = typeof labelAssociations.$inferInsert;
export type LabelReading = typeof labelReadings.$inferSelect;
export type InsertLabelReading = typeof labelReadings.$inferInsert;
export type BlindConferenceAdjustment = typeof blindConferenceAdjustments.$inferSelect;
export type InsertBlindConferenceAdjustment = typeof blindConferenceAdjustments.$inferInsert;
export type PickingWave = typeof pickingWaves.$inferSelect;
export type InsertPickingWave = typeof pickingWaves.$inferInsert;
export type PickingWaveItem = typeof pickingWaveItems.$inferSelect;
export type InsertPickingWaveItem = typeof pickingWaveItems.$inferInsert;
export type StageCheck = typeof stageChecks.$inferSelect;
export type InsertStageCheck = typeof stageChecks.$inferInsert;
export type StageCheckItem = typeof stageCheckItems.$inferSelect;
export type InsertStageCheckItem = typeof stageCheckItems.$inferInsert;
export type ProductLabel = typeof productLabels.$inferSelect;
export type InsertProductLabel = typeof productLabels.$inferInsert;
export type PrintSettings = typeof printSettings.$inferSelect;
export type InsertPrintSettings = typeof printSettings.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;
export type PickingInvoiceItem = typeof pickingInvoiceItems.$inferSelect;
export type InsertPickingInvoiceItem = typeof pickingInvoiceItems.$inferInsert;
export type ReceivingInvoiceItem = typeof receivingInvoiceItems.$inferSelect;
export type InsertReceivingInvoiceItem = typeof receivingInvoiceItems.$inferInsert;
export type ShipmentManifest = typeof shipmentManifests.$inferSelect;
export type InsertShipmentManifest = typeof shipmentManifests.$inferInsert;
export type ShipmentManifestItem = typeof shipmentManifestItems.$inferSelect;
export type InsertShipmentManifestItem = typeof shipmentManifestItems.$inferInsert;
export type PickingAllocation = typeof pickingAllocations.$inferSelect;
export type InsertPickingAllocation = typeof pickingAllocations.$inferInsert;
export type PickingProgress = typeof pickingProgress.$inferSelect;
export type InsertPickingProgress = typeof pickingProgress.$inferInsert;


// ============================================================================
// MÓDULO DE RELATÓRIOS
// ============================================================================

/**
 * Tabela de logs de geração de relatórios
 * Registra auditoria de quem gerou qual relatório e quando
 */
export const reportLogs = mysqlTable("reportLogs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"), // null = relatório global (admin)
  userId: int("userId").notNull(), // Quem gerou o relatório
  reportType: varchar("reportType", { length: 100 }).notNull(), // ex: "stock_position", "productivity"
  reportCategory: mysqlEnum("reportCategory", ["stock", "operational", "shipping", "audit"]).notNull(),
  filters: json("filters"), // Filtros aplicados (JSON)
  exportFormat: mysqlEnum("exportFormat", ["screen", "excel", "pdf", "csv"]),
  recordCount: int("recordCount"), // Quantidade de registros retornados
  executionTime: int("executionTime"), // Tempo de execução em ms
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("reportLogs_tenantId_idx").on(table.tenantId),
  userIdx: index("reportLogs_userId_idx").on(table.userId),
  typeIdx: index("reportLogs_reportType_idx").on(table.reportType),
  dateIdx: index("reportLogs_generatedAt_idx").on(table.generatedAt),
}));

/**
 * Tabela de filtros favoritos salvos por usuário
 * Permite que usuários salvem combinações de filtros frequentes
 */
export const reportFavorites = mysqlTable("reportFavorites", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  reportType: varchar("reportType", { length: 100 }).notNull(),
  favoriteName: varchar("favoriteName", { length: 255 }).notNull(), // Nome dado pelo usuário
  filters: json("filters").notNull(), // Filtros salvos (JSON)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdx: index("reportFavorites_userId_idx").on(table.userId),
  typeIdx: index("reportFavorites_reportType_idx").on(table.reportType),
}));

// Type exports
export type ReportLog = typeof reportLogs.$inferSelect;
export type InsertReportLog = typeof reportLogs.$inferInsert;
export type ReportFavorite = typeof reportFavorites.$inferSelect;
export type InsertReportFavorite = typeof reportFavorites.$inferInsert;

// ============================================================================
// MÓDULO PORTAL DO CLIENTE
// ============================================================================

/**
 * Sessões de acesso ao Portal do Cliente
 * Usuários do systemUsers fazem login aqui com token próprio (independente do OAuth do WMS).
 * Token JWT é armazenado em cookie "client_portal_session".
 */
export const clientPortalSessions = mysqlTable("clientPortalSessions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  systemUserId: int("systemUserId").notNull(),
  token: varchar("token", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("cps_tenant_idx").on(table.tenantId),
  userIdx: index("cps_user_idx").on(table.systemUserId),
  expiresIdx: index("cps_expires_idx").on(table.expiresAt),
}));

export type ClientPortalSession = typeof clientPortalSessions.$inferSelect;
export type InsertClientPortalSession = typeof clientPortalSessions.$inferInsert;

// ============================================================================
// MÓDULO MOTOR DE CONVERSÃO DE UNIDADES DE MEDIDA
// ============================================================================

/**
 * Níveis de embalagem normalizados (hierarquia de unidades)
 * UN(1) < PCT(2) < CX(3) < FD(4) < PL(5)
 * Tabela global (sem tenant) — define os "tipos" de embalagem disponíveis.
 */
export const packagingLevels = mysqlTable("packagingLevels", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 20 }).notNull().unique(), // UN, PCT, CX, FD, PL
  name: varchar("name", { length: 100 }).notNull(),         // Unidade, Pacote, Caixa, Fardo, Pallet
  rank: int("rank").notNull(),                              // 1=UN, 2=PCT, 3=CX, 4=FD, 5=PL
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PackagingLevel = typeof packagingLevels.$inferSelect;
export type InsertPackagingLevel = typeof packagingLevels.$inferInsert;

/**
 * Aliases de unidades de medida por tenant
 * "De-Para": textos do XML da NF-e → código normalizado (packagingLevels.code)
 * Ex: 'PÇ', 'PC', 'UNID', 'UND' → 'UN'
 * Ex: 'CX', 'CXA', 'CAIXA' → 'CX'
 * Permite que cada tenant customize seus próprios mapeamentos.
 */
export const unitAliases = mysqlTable("unitAliases", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  alias: varchar("alias", { length: 50 }).notNull(),        // Texto exato do XML (uCom ou uTrib)
  targetCode: varchar("targetCode", { length: 20 }).notNull(), // Código normalizado (UN, CX, FD...)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantAliasUnique: unique("unit_alias_tenant_unique").on(table.tenantId, table.alias),
  tenantIdx: index("unit_aliases_tenant_idx").on(table.tenantId),
}));
export type UnitAlias = typeof unitAliases.$inferSelect;
export type InsertUnitAlias = typeof unitAliases.$inferInsert;

/**
 * Fatores de conversão por produto e unidade (por tenant)
 * Define quantas unidades base (UN) equivalem a 1 unidade da embalagem.
 * Ex: 1 CX de Produto A = 12 UN → factor_to_base = 12
 * Ex: 1 FD de Produto B = 100 UN para Cliente A, 120 UN para Cliente B
 */
export const productConversions = mysqlTable("productConversions", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  productId: int("productId").notNull(),
  unitCode: varchar("unitCode", { length: 20 }).notNull(),  // Código da embalagem (UN, CX, FD...)
  factorToBase: decimal("factorToBase", { precision: 18, scale: 6 }).notNull(), // Fator de conversão para UN
  roundingStrategy: mysqlEnum("roundingStrategy", ["floor", "ceil", "round"]).default("round").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantProductUnitUnique: unique("product_conversion_unique").on(table.tenantId, table.productId, table.unitCode),
  tenantProductIdx: index("product_conversions_tenant_product_idx").on(table.tenantId, table.productId),
}));
export type ProductConversion = typeof productConversions.$inferSelect;
export type InsertProductConversion = typeof productConversions.$inferInsert;

/**
 * Fila de pendências de cadastro de unidades
 * NF-es bloqueadas por falta de mapeamento de unidade ou fator de conversão.
 * O admin deve resolver o mapeamento e reprocessar a NF-e.
 */
export const unitPendingQueue = mysqlTable("unitPendingQueue", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  receivingOrderId: int("receivingOrderId"),               // Ordem de recebimento bloqueada
  nfeKey: varchar("nfeKey", { length: 44 }),               // Chave da NF-e
  nfeNumber: varchar("nfeNumber", { length: 20 }),
  productCode: varchar("productCode", { length: 100 }).notNull(), // cProd do XML
  productDescription: varchar("productDescription", { length: 500 }),
  xmlUnit: varchar("xmlUnit", { length: 50 }).notNull(),   // Unidade do XML (uCom ou uTrib)
  reason: mysqlEnum("reason", ["no_alias", "no_conversion", "new_product"]).notNull(),
  status: mysqlEnum("status", ["pending", "resolved", "ignored"]).default("pending").notNull(),
  resolvedBy: int("resolvedBy"),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("unit_pending_tenant_idx").on(table.tenantId),
  statusIdx: index("unit_pending_status_idx").on(table.status),
  // Índices adicionais — tenantId = dono da operação (cliente)
  tenantStatusIdx: index("unitPendingQueue_tenantId_status_idx").on(table.tenantId, table.status),
  productCodeIdx: index("unitPendingQueue_productCode_idx").on(table.tenantId, table.productCode),
  receivingOrderIdIdx: index("unitPendingQueue_receivingOrderId_idx").on(table.receivingOrderId),
}));
export type UnitPendingQueue = typeof unitPendingQueue.$inferSelect;
export type InsertUnitPendingQueue = typeof unitPendingQueue.$inferInsert;

// ============================================================================
// MÓDULO INTRA-HOSPITALAR — RASTREABILIDADE LAST MILE INTERNA
// ============================================================================

/**
 * Pontos de Entrega Intra-Hospitalar
 * Representa os pontos físicos do complexo hospitalar onde os pedidos transitam:
 * - DOCK: docas de descarregamento (entrada no complexo)
 * - PHARMACY: farmácias internas (destino final)
 * O externalCode é usado para gerar QR Codes para leitura no coletor.
 */
export const deliveryPoints = mysqlTable("deliveryPoints", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Dono da operação (cliente hospitalar)
  name: varchar("name", { length: 255 }).notNull(),
  type: mysqlEnum("type", ["DOCK", "PHARMACY"]).notNull(),
  externalCode: varchar("externalCode", { length: 100 }).notNull(), // Código para QR Code
  description: text("description"),
  floor: varchar("floor", { length: 50 }), // Andar/Bloco (ex: "Bloco A - 2º Andar")
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantIdIdx: index("deliveryPoints_tenantId_idx").on(table.tenantId),
  tenantTypeIdx: index("deliveryPoints_tenantId_type_idx").on(table.tenantId, table.type),
  externalCodeIdx: index("deliveryPoints_externalCode_idx").on(table.tenantId, table.externalCode),
}));
export type DeliveryPoint = typeof deliveryPoints.$inferSelect;
export type InsertDeliveryPoint = typeof deliveryPoints.$inferInsert;

/**
 * Log de Checkpoints Intra-Hospitalar
 * Registra cada evento de movimentação de um pedido dentro do complexo hospitalar.
 * Status possíveis (em ordem de fluxo):
 *   ARRIVED_COMPLEX   → Pedido chegou à doca de descarregamento
 *   DEPARTED_TO_UNIT  → Pedido saiu da doca em direção à farmácia
 *   ARRIVED_UNIT      → Pedido chegou à farmácia de destino
 *   RECEIVING_STARTED → Farmácia iniciou a conferência do recebimento
 *   RECEIVE_COMPLETE  → Recebimento finalizado e confirmado pela farmácia
 */
export const deliveryLogs = mysqlTable("deliveryLogs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(), // Dono da operação (cliente hospitalar)
  orderId: int("orderId").notNull(),   // FK para pickingOrders.id
  deliveryPointId: int("deliveryPointId").notNull(), // FK para deliveryPoints.id
  status: mysqlEnum("status", [
    "ARRIVED_COMPLEX",
    "DEPARTED_TO_UNIT",
    "ARRIVED_UNIT",
    "RECEIVING_STARTED",
    "RECEIVE_COMPLETE",
  ]).notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  userId: int("userId"), // FK para users.id (quem registrou)
  notes: text("notes"), // Observações livres (ex: "Caixa avariada")
  waveNumber: varchar("waveNumber", { length: 50 }), // Romaneio (pickingWaves.waveNumber)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tenantIdIdx: index("deliveryLogs_tenantId_idx").on(table.tenantId),
  orderIdIdx: index("deliveryLogs_orderId_idx").on(table.orderId),
  tenantOrderIdx: index("deliveryLogs_tenantId_orderId_idx").on(table.tenantId, table.orderId),
  deliveryPointIdx: index("deliveryLogs_deliveryPointId_idx").on(table.deliveryPointId),
  statusIdx: index("deliveryLogs_status_idx").on(table.status),
  timestampIdx: index("deliveryLogs_timestamp_idx").on(table.timestamp),
}));
export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type InsertDeliveryLog = typeof deliveryLogs.$inferInsert;

/**
 * Tabela de junção: NF ↔ Pedidos de Separação (N:N)
 * Permite que uma NF cubra múltiplos pedidos de separação.
 * A validação dos itens da NF é feita contra o conjunto de todos os pedidos vinculados.
 */
export const invoicePickingOrders = mysqlTable("invoicePickingOrders", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),       // FK para invoices.id
  pickingOrderId: int("pickingOrderId").notNull(), // FK para pickingOrders.id
  tenantId: int("tenantId").notNull(),
  linkedAt: timestamp("linkedAt").defaultNow().notNull(),
  linkedBy: int("linkedBy"),                   // FK para users.id
}, (table) => ({
  invoiceIdx: index("invoicePickingOrders_invoiceId_idx").on(table.invoiceId),
  orderIdx: index("invoicePickingOrders_pickingOrderId_idx").on(table.pickingOrderId),
  uniqueLink: uniqueIndex("invoicePickingOrders_unique_idx").on(table.invoiceId, table.pickingOrderId),
  tenantIdx: index("invoicePickingOrders_tenantId_idx").on(table.tenantId),
}));
export type InvoicePickingOrder = typeof invoicePickingOrders.$inferSelect;
export type InsertInvoicePickingOrder = typeof invoicePickingOrders.$inferInsert;

// ============================================================================
// MÓDULO RECEBIMENTO CEGO AGRUPADO (MULTI-NF)
// ============================================================================

/**
 * Grupo de conferência agrupada: vincula múltiplas NFs a uma única sessão de conferência cega.
 * A distribuição das bipagens entre as NFs é feita virtualmente (FIFO) e persistida apenas na finalização.
 */
export const blindConferenceGroups = mysqlTable("blindConferenceGroups", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  groupNumber: varchar("groupNumber", { length: 50 }).notNull().unique(), // Ex: GRP-1234567890
  startedBy: int("startedBy").notNull(), // userId
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
  finishedBy: int("finishedBy"),
  status: mysqlEnum("status", ["active", "completed", "cancelled"]).default("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantIdIdx: index("blindConfGroups_tenantId_idx").on(table.tenantId),
  statusIdx: index("blindConfGroups_status_idx").on(table.status),
  tenantStatusIdx: index("blindConfGroups_tenantId_status_idx").on(table.tenantId, table.status),
}));
export type BlindConferenceGroup = typeof blindConferenceGroups.$inferSelect;
export type InsertBlindConferenceGroup = typeof blindConferenceGroups.$inferInsert;

/**
 * NFs participantes de um grupo de conferência agrupada.
 * Cada registro vincula uma OR a um grupo, com a ordem de prioridade FIFO.
 */
export const blindConferenceGroupOrders = mysqlTable("blindConferenceGroupOrders", {
  id: int("id").autoincrement().primaryKey(),
  groupId: int("groupId").notNull(), // FK para blindConferenceGroups
  receivingOrderId: int("receivingOrderId").notNull(), // FK para receivingOrders
  tenantId: int("tenantId").notNull(),
  fifoOrder: int("fifoOrder").notNull().default(0), // Ordem de prioridade FIFO (0 = primeira)
  linkedAt: timestamp("linkedAt").defaultNow().notNull(),
}, (table) => ({
  groupIdx: index("blindConfGroupOrders_groupId_idx").on(table.groupId),
  orderIdx: index("blindConfGroupOrders_orderId_idx").on(table.receivingOrderId),
  tenantIdx: index("blindConfGroupOrders_tenantId_idx").on(table.tenantId),
  uniqueGroupOrder: uniqueIndex("blindConfGroupOrders_unique_idx").on(table.groupId, table.receivingOrderId),
}));
export type BlindConferenceGroupOrder = typeof blindConferenceGroupOrders.$inferSelect;
export type InsertBlindConferenceGroupOrder = typeof blindConferenceGroupOrders.$inferInsert;

/**
 * Bipagens temporárias da conferência agrupada.
 * Cada registro representa uma leitura de etiqueta no contexto do grupo.
 * A distribuição FIFO entre NFs é calculada na finalização.
 */
export const blindConferenceGroupScans = mysqlTable("blindConferenceGroupScans", {
  id: int("id").autoincrement().primaryKey(),
  groupId: int("groupId").notNull(), // FK para blindConferenceGroups
  tenantId: int("tenantId").notNull(),
  productId: int("productId").notNull(),
  labelCode: varchar("labelCode", { length: 100 }).notNull(), // Código da etiqueta lida
  uniqueCode: varchar("uniqueCode", { length: 200 }).notNull(), // SKU+Lote
  batch: varchar("batch", { length: 100 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  unitsPerBox: int("unitsPerBox").notNull().default(1),
  unitsRead: int("unitsRead").notNull().default(1), // Unidades desta leitura
  scannedBy: int("scannedBy").notNull(), // userId
  scannedAt: timestamp("scannedAt").defaultNow().notNull(),
  isUndone: boolean("isUndone").default(false).notNull(), // true = desfeito pelo operador
}, (table) => ({
  groupIdx: index("blindConfGroupScans_groupId_idx").on(table.groupId),
  productIdx: index("blindConfGroupScans_productId_idx").on(table.productId),
  tenantIdx: index("blindConfGroupScans_tenantId_idx").on(table.tenantId),
  labelCodeIdx: index("blindConfGroupScans_labelCode_idx").on(table.labelCode),
  groupProductIdx: index("blindConfGroupScans_groupProduct_idx").on(table.groupId, table.productId),
}));
export type BlindConferenceGroupScan = typeof blindConferenceGroupScans.$inferSelect;
export type InsertBlindConferenceGroupScan = typeof blindConferenceGroupScans.$inferInsert;

// ============================================================================
// MÓDULO DE INVENTÁRIO (Fase 1 — Cíclico e Geral)
// ============================================================================
export const inventories = mysqlTable("inventories", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId"), // null = inventário geral (todos os tenants)
  inventoryNumber: varchar("inventoryNumber", { length: 50 }).notNull().unique(),
  inventoryType: mysqlEnum("inventoryType", ["cyclic", "general"]).notNull(),
  referenceDate: date("referenceDate", { mode: "string" }), // Obrigatório para cíclico
  startDate: timestamp("startDate").notNull(),
  endDate: timestamp("endDate"),
  status: mysqlEnum("status", ["pending", "in_progress", "completed", "cancelled"]).default("pending").notNull(),
  notes: text("notes"),
  cancellationReason: text("cancellationReason"),
  cancelledBy: int("cancelledBy"),
  cancelledAt: timestamp("cancelledAt"),
  totalLocations: int("totalLocations").default(0).notNull(),
  countedLocations: int("countedLocations").default(0).notNull(),
  divergentLocations: int("divergentLocations").default(0).notNull(),
  accuracy: varchar("accuracy", { length: 10 }), // Ex: "98.50"
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantStatusIdx: index("inventories_tenant_status_idx").on(table.tenantId, table.status),
  inventoryNumberIdx: index("inventories_number_idx").on(table.inventoryNumber),
}));

export const inventoryLocations = mysqlTable("inventoryLocations", {
  id: int("id").autoincrement().primaryKey(),
  inventoryId: int("inventoryId").notNull(),
  locationId: int("locationId").notNull(),
  locationCode: varchar("locationCode", { length: 50 }).notNull(),
  status: mysqlEnum("status", ["pending", "counting", "counted", "divergent", "blocked"]).default("pending").notNull(),
  countAttempts: int("countAttempts").default(0).notNull(), // Número de contagens realizadas
  isBlocked: boolean("isBlocked").default(false).notNull(), // Bloqueado para picking durante inventário
  blockedAt: timestamp("blockedAt"),
  countedBy: int("countedBy"),
  countedAt: timestamp("countedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  inventoryIdIdx: index("inventoryLocations_inventoryId_idx").on(table.inventoryId),
  locationIdIdx: index("inventoryLocations_locationId_idx").on(table.locationId),
  inventoryLocationIdx: index("inventoryLocations_inv_loc_idx").on(table.inventoryId, table.locationId),
}));

export const inventoryCountAttempts = mysqlTable("inventoryCountAttempts", {
  id: int("id").autoincrement().primaryKey(),
  inventoryLocationId: int("inventoryLocationId").notNull(),
  inventoryId: int("inventoryId").notNull(),
  locationId: int("locationId").notNull(),
  attemptNumber: int("attemptNumber").notNull(), // 1, 2, 3...
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }),
  productDescription: varchar("productDescription", { length: 255 }),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  expectedQuantity: int("expectedQuantity").default(0).notNull(),
  countedQuantity: int("countedQuantity").default(0).notNull(),
  variance: int("variance").default(0).notNull(), // countedQuantity - expectedQuantity
  countedBy: int("countedBy").notNull(),
  countedAt: timestamp("countedAt").defaultNow().notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  inventoryLocationIdx: index("inventoryCountAttempts_invLoc_idx").on(table.inventoryLocationId),
  inventoryIdIdx: index("inventoryCountAttempts_invId_idx").on(table.inventoryId),
}));

export const inventoryDivergences = mysqlTable("inventoryDivergences", {
  id: int("id").autoincrement().primaryKey(),
  inventoryId: int("inventoryId").notNull(),
  inventoryLocationId: int("inventoryLocationId").notNull(),
  locationId: int("locationId").notNull(),
  locationCode: varchar("locationCode", { length: 50 }).notNull(),
  productId: int("productId").notNull(),
  productSku: varchar("productSku", { length: 100 }),
  productDescription: varchar("productDescription", { length: 255 }),
  batch: varchar("batch", { length: 50 }),
  expiryDate: date("expiryDate", { mode: "string" }),
  tenantId: int("tenantId"),
  expectedQuantity: int("expectedQuantity").notNull(),
  countedQuantity: int("countedQuantity").notNull(),
  variance: int("variance").notNull(), // + sobra, - falta
  divergenceType: mysqlEnum("divergenceType", ["surplus", "shortage"]).notNull(),
  resolution: mysqlEnum("resolution", ["pending", "movement_order_created", "adjusted", "cancelled"]).default("pending").notNull(),
  movementOrderId: int("movementOrderId"), // pickingOrders.id (tipo INVENTORY_SURPLUS)
  resolvedBy: int("resolvedBy"),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  inventoryIdIdx: index("inventoryDivergences_inventoryId_idx").on(table.inventoryId),
  locationIdIdx: index("inventoryDivergences_locationId_idx").on(table.locationId),
  resolutionIdx: index("inventoryDivergences_resolution_idx").on(table.resolution),
}));

export const inventoryAuditLog = mysqlTable("inventoryAuditLog", {
  id: int("id").autoincrement().primaryKey(),
  inventoryId: int("inventoryId").notNull(),
  inventoryLocationId: int("inventoryLocationId"),
  action: mysqlEnum("action", ["created", "started", "location_counted", "divergence_detected", "recount_requested", "divergence_resolved", "location_blocked", "completed", "cancelled"]).notNull(),
  locationId: int("locationId"),
  locationCode: varchar("locationCode", { length: 50 }),
  productId: int("productId"),
  batch: varchar("batch", { length: 50 }),
  expectedQuantity: int("expectedQuantity"),
  countedQuantity: int("countedQuantity"),
  performedBy: int("performedBy").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  inventoryIdIdx: index("inventoryAuditLog_inventoryId_idx").on(table.inventoryId),
  createdAtIdx: index("inventoryAuditLog_createdAt_idx").on(table.createdAt),
}));

export type Inventory = typeof inventories.$inferSelect;
export type InsertInventory = typeof inventories.$inferInsert;
export type InventoryLocation = typeof inventoryLocations.$inferSelect;
export type InventoryDivergence = typeof inventoryDivergences.$inferSelect;
