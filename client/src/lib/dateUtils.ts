/**
 * Formata uma data para o formato brasileiro dd/MM/yyyy
 * @param date - Data em qualquer formato aceito por Date()
 * @returns String no formato dd/MM/yyyy ou string vazia se inválida
 */
export function formatDateBR(date: string | Date | null | undefined): string {
  if (!date) return '';
  
  try {
    // Se for string no formato YYYY-MM-DD (sem horário), extrair diretamente
    // para evitar deslocamento de timezone (new Date("2030-10-20") é UTC midnight,
    // que em UTC-3 se torna 19/10/2030)
    if (typeof date === 'string') {
      const isoMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${day}/${month}/${year}`;
      }
    }
    
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    
    // Para objetos Date, usar UTC para evitar deslocamento
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();
    
    return `${day}/${month}/${year}`;
  } catch {
    return '';
  }
}

/**
 * Converte data do formato brasileiro dd/MM/yyyy para yyyy-MM-dd (HTML input date)
 * @param dateBR - Data no formato dd/MM/yyyy
 * @returns String no formato yyyy-MM-dd ou string vazia se inválida
 */
export function parseDateBR(dateBR: string): string {
  if (!dateBR) return '';
  
  const parts = dateBR.split('/');
  if (parts.length !== 3) return '';
  
  const [day, month, year] = parts;
  if (!day || !month || !year) return '';
  
  // Validar se é uma data válida
  const date = new Date(`${year}-${month}-${day}`);
  if (isNaN(date.getTime())) return '';
  
  return `${year}-${month}-${day}`;
}

/**
 * Converte data do formato yyyy-MM-dd (HTML input date) para dd/MM/yyyy
 * @param dateISO - Data no formato yyyy-MM-dd
 * @returns String no formato dd/MM/yyyy ou string vazia se inválida
 */
export function isoToBR(dateISO: string): string {
  if (!dateISO) return '';
  
  const parts = dateISO.split('-');
  if (parts.length !== 3) return '';
  
  const [year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

/**
 * Converte data do formato dd/MM/yyyy para yyyy-MM-dd (alias para parseDateBR)
 * @param dateBR - Data no formato dd/MM/yyyy
 * @returns String no formato yyyy-MM-dd ou string vazia se inválida
 */
export function brToISO(dateBR: string): string {
  return parseDateBR(dateBR);
}
