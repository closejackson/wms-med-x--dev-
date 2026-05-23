/**
 * useClientPortalAuth.ts
 *
 * Hook de autenticação do portal do cliente.
 * Análogo ao useAuth.ts do painel WMS, mas usa o endpoint clientPortal.me.
 *
 * Colocar em: client/src/hooks/useClientPortalAuth.ts
 */

import { trpc } from "@/lib/trpc";
import { useCallback, useEffect } from "react";
import { useLocation } from "wouter";

export function useClientPortalAuth(options?: { redirectIfUnauthenticated?: boolean }) {
  const { redirectIfUnauthenticated = false } = options ?? {};
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const meQuery = trpc.clientPortal.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.clientPortal.logout.useMutation({
    onSuccess: () => {
      utils.clientPortal.me.setData(undefined, null);
      setLocation("/portal/login");
    },
  });

  useEffect(() => {
    if (!redirectIfUnauthenticated) return;
    // Aguarda o carregamento inicial E qualquer refetch em andamento (ex: após login)
    if (meQuery.isLoading || meQuery.isFetching) return;
    if (meQuery.data) return;
    setLocation("/portal/login");
  }, [redirectIfUnauthenticated, meQuery.isLoading, meQuery.isFetching, meQuery.data, setLocation]);

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync();
  }, [logoutMutation]);

  return {
    user: meQuery.data ?? null,
    // loading = true enquanto carrega pela primeira vez OU durante refetch (ex: após login)
    loading: meQuery.isLoading || meQuery.isFetching,
    isAuthenticated: Boolean(meQuery.data),
    logout,
  };
}
