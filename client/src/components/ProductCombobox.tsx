import { Combobox, ComboboxOption } from "@/components/ui/combobox";

interface Product {
  id: number | string;
  sku: string;
  internalCode?: string | null;
  description: string;
}

interface ProductComboboxProps {
  products: Product[] | undefined;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Retorna o label de exibição do produto seguindo a regra:
 * - Se tiver internalCode: "{internalCode} - {description}"
 * - Fallback: "{sku} - {description}"
 */
export function getProductLabel(product: Pick<Product, "sku" | "internalCode" | "description">): string {
  const code = product.internalCode?.trim() || product.sku;
  return `${code} - ${product.description}`;
}

/**
 * Retorna o código de exibição (internalCode com fallback para SKU)
 */
export function getProductCode(product: Pick<Product, "sku" | "internalCode">): string {
  return product.internalCode?.trim() || product.sku;
}

export function ProductCombobox({
  products,
  value,
  onValueChange,
  placeholder = "Selecione um produto",
  disabled = false,
  className,
}: ProductComboboxProps) {
  const options: ComboboxOption[] = (products || []).map((product) => {
    const code = product.internalCode?.trim() || product.sku;
    return {
      value: String(product.id),
      label: `${code} - ${product.description}`,
      // Inclui sku, internalCode e description nos termos de busca para multicritério
      searchTerms: `${product.sku} ${product.internalCode ?? ""} ${product.description}`.toLowerCase(),
    };
  });

  return (
    <Combobox
      options={options}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      emptyText="Nenhum produto encontrado"
      searchPlaceholder="Buscar por SKU, Cód. Interno ou Descrição..."
      disabled={disabled}
      className={className}
    />
  );
}
