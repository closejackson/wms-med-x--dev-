/**
 * useBreadcrumb — gera automaticamente os segmentos de breadcrumb
 * a partir da rota atual (wouter), usando um mapa estático de rotas.
 *
 * Cada segmento tem: label (texto legível), href (link clicável, exceto o último).
 */
import { useLocation } from "wouter";

interface BreadcrumbSegment {
  label: string;
  href?: string; // undefined = segmento atual (não clicável)
}

// Mapa de rotas → rótulo legível
// Ordem importa: rotas mais específicas devem vir antes das genéricas
const ROUTE_MAP: Record<string, string> = {
  "/":                              "Home",
  "/home":                          "Home",
  "/tenants":                       "Clientes",
  "/products":                      "Produtos",
  "/locations":                     "Endereços",
  "/receiving":                     "Recebimento",
  "/recebimento":                   "Recebimento",
  "/picking":                       "Picking",
  "/picking/execute":               "Execução de Onda",
  "/shipping":                      "Expedição",
  "/separacao":                     "Separação",
  "/inventory":                     "Estoque",
  "/stock":                         "Posições de Estoque",
  "/stock/movements":               "Movimentações",
  "/stock/occupancy":               "Ocupação",
  "/cadastros":                     "Cadastros",
  "/cadastros/produtos":            "Produtos",
  "/users":                         "Usuários",
  "/roles":                         "Perfis de Acesso",
  "/nfe-import":                    "Importar NF-e",
  "/inventory-import":              "Importar Saldos",
  "/stage/check":                   "Conferência de Stage",
  "/reports":                       "Relatórios",
  "/maintenance":                   "Manutenção",
  "/admin":                         "Administração",
  "/unit-conversion":               "Conversão de Unidades",
  "/settings/printing":             "Configurações de Impressão",
  "/scanner-test":                  "Teste de Scanner",
  "/intra-hospitalar":              "Intra-Hospitalar",
  "/intra-hospitalar/rastreabilidade": "Rastreabilidade",
  "/portal":                        "Portal do Cliente",
  "/portal/pedidos":                "Pedidos",
  "/portal/recebimentos":           "Recebimentos",
  "/portal/movimentacoes":          "Movimentações",
  "/portal/estoque":                "Estoque",
};

// Hierarquia de rotas pai → para construir o breadcrumb completo
const PARENT_MAP: Record<string, string> = {
  "/home":                          "/",
  "/tenants":                       "/",
  "/products":                      "/",
  "/locations":                     "/",
  "/receiving":                     "/",
  "/recebimento":                   "/",
  "/picking":                       "/",
  "/shipping":                      "/",
  "/separacao":                     "/",
  "/inventory":                     "/",
  "/stock":                         "/",
  "/stock/movements":               "/stock",
  "/stock/occupancy":               "/stock",
  "/cadastros":                     "/",
  "/cadastros/produtos":            "/cadastros",
  "/users":                         "/",
  "/roles":                         "/",
  "/nfe-import":                    "/",
  "/inventory-import":              "/",
  "/stage/check":                   "/",
  "/reports":                       "/",
  "/maintenance":                   "/",
  "/admin":                         "/",
  "/unit-conversion":               "/",
  "/settings/printing":             "/",
  "/scanner-test":                  "/",
  "/intra-hospitalar":              "/",
  "/intra-hospitalar/rastreabilidade": "/intra-hospitalar",
  "/portal":                        "/",
  "/portal/pedidos":                "/portal",
  "/portal/recebimentos":           "/portal",
  "/portal/movimentacoes":          "/portal",
  "/portal/estoque":                "/portal",
};

/**
 * Resolve a rota mais específica que corresponde ao pathname atual.
 * Suporta rotas dinâmicas como /picking/:id.
 */
function resolveRoute(pathname: string): string {
  // Correspondência exata primeiro
  if (ROUTE_MAP[pathname]) return pathname;

  // Correspondência por prefixo (rotas dinâmicas)
  const sorted = Object.keys(ROUTE_MAP).sort((a, b) => b.length - a.length);
  for (const route of sorted) {
    if (pathname.startsWith(route + "/") || pathname === route) {
      return route;
    }
  }
  return pathname;
}

/**
 * Constrói a cadeia de segmentos do breadcrumb percorrendo o PARENT_MAP.
 */
function buildChain(route: string): string[] {
  const chain: string[] = [route];
  let current = route;
  const visited = new Set<string>();

  while (PARENT_MAP[current] && !visited.has(current)) {
    visited.add(current);
    current = PARENT_MAP[current];
    chain.unshift(current);
  }

  return chain;
}

export function useBreadcrumb(): BreadcrumbSegment[] {
  const [location] = useLocation();
  const resolved = resolveRoute(location);
  const chain = buildChain(resolved);

  return chain.map((route, index) => {
    const isLast = index === chain.length - 1;
    const label = ROUTE_MAP[route] ?? route.split("/").filter(Boolean).pop() ?? "Home";
    return {
      label,
      href: isLast ? undefined : route,
    };
  });
}
