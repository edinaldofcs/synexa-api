export function applyExtractModifier(
  value: unknown,
  modifier?: string,
): unknown {
  if (value === null || value === undefined || value === '') return value;

  switch (modifier) {
    case 'currency_brl': {
      const num = Number(value);
      if (isNaN(num)) return value;
      return num.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });
    }
    case 'date_format_br': {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) return value;
      return d.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    case 'mask_cpf': {
      const digits = String(value).replace(/\D/g, '');
      if (digits.length === 11) {
        return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      }
      return value;
    }
    case 'mask_cnpj': {
      const digits = String(value).replace(/\D/g, '');
      if (digits.length === 14) {
        return digits.replace(
          /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
          '$1.$2.$3/$4-$5',
        );
      }
      return value;
    }
    case 'mask_phone': {
      const digits = String(value).replace(/\D/g, '');
      if (digits.length === 11) {
        return digits.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
      }
      if (digits.length === 10) {
        return digits.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
      }
      return value;
    }
    case 'uppercase':
      return String(value).toUpperCase();
    case 'lowercase':
      return String(value).toLowerCase();
    case 'trim':
      return String(value).trim();
    default:
      return value;
  }
}
