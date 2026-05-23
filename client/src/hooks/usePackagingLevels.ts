/**
 * usePackagingLevels
 *
 * Hook centralizado para buscar os níveis de embalagem (packagingLevels) do servidor.
 * Substitui os SelectItem hardcoded (UN, CX, PL, etc.) em todos os formulários de produto.
 *
 * Uso:
 *   const { levels, isLoading, getLabel } = usePackagingLevels();
 *
 * Retorna:
 *   - levels: PackagingLevel[] ordenados por rank
 *   - isLoading: boolean
 *   - getLabel(code): string — ex: getLabel("CX") → "Caixa (CX)"
 *   - unitOptions: opções no formato { value, label } para uso em Select
 *   - pickingOptions: opções no formato { value: "box"|"unit", label } para seletores de picking
 */

import { trpc } from "@/lib/trpc";
import { useMemo } from "react";

export interface PackagingLevelOption {
  value: string;
  label: string;
  code: string;
  name: string;
  rank: number;
}

/** Mapeamento de código de nível de embalagem para valor de picking ("box" | "unit") */
const PICKING_VALUE_MAP: Record<string, "box" | "unit"> = {
  UN: "unit",
  // Todos os demais níveis acima de UN são tratados como "box" (embalagem)
};

/** Fallback estático caso o banco ainda não tenha dados em packagingLevels */
const FALLBACK_LEVELS: PackagingLevelOption[] = [
  { value: "UN", label: "Unidade (UN)", code: "UN", name: "Unidade", rank: 1 },
  { value: "PCT", label: "Pacote (PCT)", code: "PCT", name: "Pacote", rank: 2 },
  { value: "CX", label: "Caixa (CX)", code: "CX", name: "Caixa", rank: 3 },
  { value: "FD", label: "Fardo (FD)", code: "FD", name: "Fardo", rank: 4 },
  { value: "PL", label: "Pallet (PL)", code: "PL", name: "Pallet", rank: 5 },
  { value: "KG", label: "Quilograma (KG)", code: "KG", name: "Quilograma", rank: 6 },
  { value: "G", label: "Grama (G)", code: "G", name: "Grama", rank: 7 },
  { value: "MG", label: "Miligrama (MG)", code: "MG", name: "Miligrama", rank: 8 },
  { value: "L", label: "Litro (L)", code: "L", name: "Litro", rank: 9 },
  { value: "ML", label: "Mililitro (ML)", code: "ML", name: "Mililitro", rank: 10 },
];

export function usePackagingLevels() {
  const { data, isLoading, error } = trpc.unitConversion.getPackagingLevels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // 5 minutos — dados raramente mudam
    retry: 2,
  });

  const levels: PackagingLevelOption[] = useMemo(() => {
    if (!data || data.length === 0) return FALLBACK_LEVELS;
    return data.map((l) => ({
      value: l.code,
      label: `${l.name} (${l.code})`,
      code: l.code,
      name: l.name,
      rank: l.rank,
    }));
  }, [data]);

  /**
   * Retorna o label formatado para um código de unidade.
   * Ex: getLabel("CX") → "Caixa (CX)"
   */
  const getLabel = (code: string): string => {
    const found = levels.find((l) => l.code === code);
    return found ? found.label : code;
  };

  /**
   * Opções de picking: transforma os níveis em { value: "box"|"unit", label }
   * para os seletores de criação de pedidos de picking e portal do cliente.
   * UN → "unit", todos os demais → "box" com nome do nível como label.
   */
  const pickingOptions = useMemo(() => {
    return levels.map((l) => ({
      value: (PICKING_VALUE_MAP[l.code] ?? "box") as "box" | "unit",
      label: l.name,
      code: l.code,
      // Valor original para resolvePickingFactor (ex: "FD", "PL")
      rawCode: l.code,
    }));
  }, [levels]);

  /**
   * Opções de picking sem duplicatas de value (box/unit).
   * Útil para seletores simples que só precisam de "Caixa" e "Unidade".
   */
  const simplePickingOptions = useMemo(() => [
    { value: "unit" as const, label: "Unidade" },
    { value: "box" as const, label: "Caixa" },
  ], []);

  return {
    levels,
    isLoading,
    error,
    getLabel,
    pickingOptions,
    simplePickingOptions,
  };
}
