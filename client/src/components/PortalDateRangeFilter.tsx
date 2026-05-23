/**
 * PortalDateRangeFilter.tsx
 *
 * Componente reutilizável de filtro de período (data inicial e data final)
 * para os módulos do Portal do Cliente.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, X } from "lucide-react";
import { format, subDays, startOfDay, endOfDay } from "date-fns";

export interface DateRange {
  from: string | undefined; // ISO date string YYYY-MM-DD
  to: string | undefined;   // ISO date string YYYY-MM-DD
}

interface PortalDateRangeFilterProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /** Atalhos de período rápido. Padrão: Hoje, 7d, 30d */
  shortcuts?: Array<{ label: string; days: number }>;
}

const DEFAULT_SHORTCUTS = [
  { label: "Hoje", days: 0 },
  { label: "7 dias", days: 7 },
  { label: "30 dias", days: 30 },
  { label: "90 dias", days: 90 },
];

function toInputDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function PortalDateRangeFilter({
  value,
  onChange,
  shortcuts = DEFAULT_SHORTCUTS,
}: PortalDateRangeFilterProps) {
  const [activeShortcut, setActiveShortcut] = useState<number | null>(null);

  function applyShortcut(days: number) {
    setActiveShortcut(days);
    if (days === 0) {
      const today = toInputDate(new Date());
      onChange({ from: today, to: today });
    } else {
      onChange({
        from: toInputDate(subDays(new Date(), days)),
        to: toInputDate(new Date()),
      });
    }
  }

  function handleFromChange(v: string) {
    setActiveShortcut(null);
    onChange({ ...value, from: v || undefined });
  }

  function handleToChange(v: string) {
    setActiveShortcut(null);
    onChange({ ...value, to: v || undefined });
  }

  function clearFilter() {
    setActiveShortcut(null);
    onChange({ from: undefined, to: undefined });
  }

  const hasFilter = value.from || value.to;

  return (
    <div className="flex flex-wrap items-end gap-2">
      {/* Atalhos rápidos */}
      <div className="flex items-center gap-1">
        <CalendarDays className="h-4 w-4 text-slate-400 mr-1" />
        {shortcuts.map((s) => (
          <Button
            key={s.days}
            variant={activeShortcut === s.days ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs px-3 ${
              activeShortcut === s.days
                ? "bg-blue-600 hover:bg-blue-700 text-white border-blue-600"
                : "text-slate-600 hover:text-slate-900"
            }`}
            onClick={() => applyShortcut(s.days)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {/* Separador */}
      <span className="text-slate-300 text-sm hidden sm:inline">|</span>

      {/* Inputs de data */}
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-slate-500 font-medium">De</Label>
          <Input
            type="date"
            value={value.from ?? ""}
            onChange={(e) => handleFromChange(e.target.value)}
            className="h-8 text-xs w-36"
            max={value.to ?? toInputDate(new Date())}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-slate-500 font-medium">Até</Label>
          <Input
            type="date"
            value={value.to ?? ""}
            onChange={(e) => handleToChange(e.target.value)}
            className="h-8 text-xs w-36"
            min={value.from}
            max={toInputDate(new Date())}
          />
        </div>
        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-slate-500 hover:text-red-600 px-2"
            onClick={clearFilter}
            title="Limpar filtro de período"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Badge indicador de filtro ativo */}
      {hasFilter && (
        <Badge
          variant="outline"
          className="text-xs bg-blue-50 text-blue-700 border-blue-200 h-8 px-2 flex items-center gap-1"
        >
          <CalendarDays className="h-3 w-3" />
          {value.from && value.to && value.from === value.to
            ? format(new Date(value.from + "T00:00:00"), "dd/MM/yyyy")
            : [
                value.from ? format(new Date(value.from + "T00:00:00"), "dd/MM") : "início",
                value.to ? format(new Date(value.to + "T00:00:00"), "dd/MM/yyyy") : "hoje",
              ].join(" – ")}
        </Badge>
      )}
    </div>
  );
}
