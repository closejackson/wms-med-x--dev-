/**
 * useBarcodeScan
 *
 * Hook reutilizável para campos de leitura de código de barras no coletor.
 *
 * Comportamento:
 * - Qualquer digitação no campo agenda um auto-submit após `debounceMs` ms sem nova tecla.
 * - Enter sempre dispara imediatamente (independente do debounce).
 * - O campo exibe o valor digitado em tempo real (controlled input).
 * - Após submeter, o campo é limpo e o foco é MANTIDO automaticamente.
 * - O foco é restaurado quando a mutation termina (disabled volta para false).
 * - O foco é restaurado via listener de blur quando o campo perde o foco para
 *   elementos não-interativos (ex: toast, animações, re-renders).
 *
 * Uso:
 * ```tsx
 * const barcode = useBarcodeScan({
 *   onSubmit: (code) => myMutation.mutate({ labelCode: code }),
 *   disabled: myMutation.isPending,
 * });
 * <Input ref={barcode.ref} value={barcode.value} onChange={barcode.onChange} onKeyDown={barcode.onKeyDown} />
 * ```
 */
import { useState, useRef, useCallback, useEffect } from "react";

interface UseBarcodeScanOptions {
  /** Chamado quando o código está pronto para ser processado */
  onSubmit: (code: string) => void;
  /** Desabilita o auto-submit quando true (ex: mutation em andamento) */
  disabled?: boolean;
  /**
   * Tempo em ms sem nova digitação para disparar o auto-submit.
   * @default 300
   */
  debounceMs?: number;
  /**
   * Quando true, o campo recupera o foco automaticamente sempre que o perde
   * para um elemento não-interativo (body, div, etc.). Útil para telas de
   * coletor onde o campo deve estar sempre pronto para receber bipagem.
   * @default true
   */
  persistFocus?: boolean;
}

interface UseBarcodeScanReturn {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  ref: React.RefObject<HTMLInputElement | null>;
  /** Limpa o campo manualmente */
  clear: () => void;
  /** Foca o input */
  focus: () => void;
}

/** Elementos interativos que NÃO devem ser roubados pelo persistFocus */
const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);

export function useBarcodeScan({
  onSubmit,
  disabled = false,
  debounceMs = 300,
  persistFocus = true,
}: UseBarcodeScanOptions): UseBarcodeScanReturn {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  };

  const refocus = useCallback(() => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    // Duplo requestAnimationFrame + setTimeout para garantir que o DOM
    // (incluindo toasts e re-renders) terminou antes de refocar
    focusTimer.current = setTimeout(() => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }, 50);
  }, []);

  const submit = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed || disabled) return;
      clearTimer();
      setValue("");
      onSubmit(trimmed);
      // Refocar após limpar o campo (o onSuccess da mutation também chama focus,
      // mas este garante o foco imediato antes da resposta do servidor)
      refocus();
    },
    [disabled, onSubmit, refocus]
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      if (!newValue.trim()) {
        clearTimer();
        return;
      }

      // Sempre agendar auto-submit após debounceMs sem nova digitação
      clearTimer();
      debounceTimer.current = setTimeout(() => {
        const currentValue = inputRef.current?.value ?? newValue;
        submit(currentValue);
      }, debounceMs);
    },
    [submit, debounceMs]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Cancelar o timer de debounce ANTES de chamar submit para evitar
        // duplo disparo: Enter (imediato) + debounce timer (300ms depois)
        clearTimer();
        submit(value);
      }
    },
    [submit, value]
  );

  const clear = useCallback(() => {
    clearTimer();
    setValue("");
  }, []);

  const focus = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Restaurar foco quando a mutation termina (disabled volta para false)
  const prevDisabled = useRef(disabled);
  useEffect(() => {
    if (prevDisabled.current && !disabled) {
      refocus();
    }
    prevDisabled.current = disabled;
  }, [disabled, refocus]);

  // Listener de blur: recuperar foco quando o campo perde para elemento não-interativo
  useEffect(() => {
    if (!persistFocus) return;
    const el = inputRef.current;
    if (!el) return;

    const handleBlur = (e: FocusEvent) => {
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      // Se o foco foi para um elemento interativo (botão, input, etc.), não interferir
      if (relatedTarget && INTERACTIVE_TAGS.has(relatedTarget.tagName)) return;
      // Se o foco foi para um elemento com role interativo, não interferir
      if (relatedTarget && relatedTarget.getAttribute("role") === "dialog") return;
      if (relatedTarget && relatedTarget.closest("[role='dialog']")) return;
      // Refocar após um pequeno delay para não interferir com cliques em botões
      refocus();
    };

    el.addEventListener("blur", handleBlur);
    return () => el.removeEventListener("blur", handleBlur);
  }, [persistFocus, refocus]);

  // Limpar timers ao desmontar
  useEffect(() => {
    return () => {
      clearTimer();
      if (focusTimer.current) clearTimeout(focusTimer.current);
    };
  }, []);

  return { value, onChange, onKeyDown, ref: inputRef, clear, focus };
}
