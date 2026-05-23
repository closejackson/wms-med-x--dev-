/**
 * Converte Date para formato MySQL DATE (YYYY-MM-DD)
 * @param date - Date object ou null
 * @returns String no formato YYYY-MM-DD ou null
 */
export function toMySQLDate(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  
  // Se já é string, extrair apenas a parte YYYY-MM-DD sem conversão de timezone
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (!trimmed) return null;
    // Aceitar formatos: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, YYYY-MM-DD HH:MM:SS
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }
  
  // Para objetos Date: usar UTC para evitar deslocamento de timezone
  // new Date("2030-12-20") cria UTC midnight, getUTCDate() retorna 20 corretamente
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Gera uniqueCode a partir de SKU e lote
 * @param sku - SKU do produto
 * @param batch - Lote do produto
 * @returns uniqueCode no formato SKU-LOTE
 */
export function getUniqueCode(sku: string, batch: string | null): string {
  // Normaliza para SKU-Lote, removendo sufixos extras e tratando nulos de forma consistente
  const cleanBatch = batch && batch !== 'null' && batch.trim() !== '' ? batch.trim() : 'null';
  return `${sku.trim()}-${cleanBatch}`;
}
