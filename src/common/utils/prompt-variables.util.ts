const DIAS_SEMANA = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

function getZonedDate(date: Date, timeZone = 'America/Sao_Paulo'): Date {
  try {
    const invdate = new Date(
      date.toLocaleString('en-US', {
        timeZone,
      }),
    );
    const diff = date.getTime() - invdate.getTime();
    return new Date(date.getTime() - diff);
  } catch {
    return date;
  }
}

function formatBrDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

export function addBusinessDays(startDate: Date, count: number): Date {
  const result = new Date(startDate.getTime());
  if (count === 0) {
    // Se count for 0, se for fim de semana avança para o próximo dia útil
    const day = result.getDay();
    if (day === 0) result.setDate(result.getDate() + 1);
    else if (day === 6) result.setDate(result.getDate() + 2);
    return result;
  }

  const step = count > 0 ? 1 : -1;
  let remaining = Math.abs(count);

  while (remaining > 0) {
    result.setDate(result.getDate() + step);
    const day = result.getDay();
    if (day !== 0 && day !== 6) {
      remaining--;
    }
  }

  return result;
}

export function resolveDynamicSystemVariable(
  rawKey: string,
  now = new Date(),
  timeZone = 'America/Sao_Paulo',
): string | null {
  const key = rawKey.trim().toLowerCase();
  const baseDate = getZonedDate(now, timeZone);

  // 1. Data Atual / Hoje / Dias Corridos (hoje, hoje+0, hoje+1, hoje-3, data_atual, dias_corridos+2)
  const hojeMatch = key.match(/^(?:hoje|data_atual|dias_corridos)([+-]\d+)?$/);
  if (hojeMatch) {
    const offset = hojeMatch[1] ? parseInt(hojeMatch[1], 10) : 0;
    const targetDate = new Date(baseDate.getTime());
    targetDate.setDate(targetDate.getDate() + offset);
    return formatBrDate(targetDate);
  }

  // 2. Dias Úteis (dias_uteis+1, dias_uteis+5, dias_uteis-2, dias_uteis)
  const diasUteisMatch = key.match(/^dias_uteis([+-]\d+)?$/);
  if (diasUteisMatch) {
    const offset = diasUteisMatch[1] ? parseInt(diasUteisMatch[1], 10) : 0;
    const targetDate = addBusinessDays(baseDate, offset);
    return formatBrDate(targetDate);
  }

  // 3. Próximo Dia Útil (proximo_dia_util)
  if (key === 'proximo_dia_util') {
    const day = baseDate.getDay();
    let addDays = 1;
    if (day === 5)
      addDays = 3; // sexta -> segunda
    else if (day === 6)
      addDays = 2; // sábado -> segunda
    else if (day === 0) addDays = 1; // domingo -> segunda
    const targetDate = new Date(baseDate.getTime());
    targetDate.setDate(targetDate.getDate() + addDays);
    return formatBrDate(targetDate);
  }

  // 4. É dia útil? (eh_dia_util, is_business_day)
  if (key === 'eh_dia_util' || key === 'is_business_day') {
    const day = baseDate.getDay();
    return day >= 1 && day <= 5 ? 'sim' : 'não';
  }

  // 5. Tipo de dia hoje (tipo_dia_hoje, tipo_dia)
  if (key === 'tipo_dia_hoje' || key === 'tipo_dia') {
    const day = baseDate.getDay();
    return day >= 1 && day <= 5 ? 'dia útil' : 'fim de semana';
  }

  // 6. Dia da Semana (dia_semana, dia_da_semana, dia_semana+1, dia_semana-1)
  const diaSemanaMatch = key.match(/^(?:dia_semana|dia_da_semana)([+-]\d+)?$/);
  if (diaSemanaMatch) {
    const offset = diaSemanaMatch[1] ? parseInt(diaSemanaMatch[1], 10) : 0;
    const targetDate = new Date(baseDate.getTime());
    targetDate.setDate(targetDate.getDate() + offset);
    return DIAS_SEMANA[targetDate.getDay()];
  }

  // 7. Dia da Semana Útil (dia_semana_util+1)
  const diaSemanaUtilMatch = key.match(/^dia_semana_util([+-]\d+)?$/);
  if (diaSemanaUtilMatch) {
    const offset = diaSemanaUtilMatch[1]
      ? parseInt(diaSemanaUtilMatch[1], 10)
      : 0;
    const targetDate = addBusinessDays(baseDate, offset);
    return DIAS_SEMANA[targetDate.getDay()];
  }

  // 8. Horário Atual (hora_atual, hora, hora_agora) -> HH:MM
  if (key === 'hora_atual' || key === 'hora' || key === 'hora_agora') {
    const h = String(baseDate.getHours()).padStart(2, '0');
    const m = String(baseDate.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  // 9. Hora Completa com Segundos (hora_completa) -> HH:MM:SS
  if (key === 'hora_completa') {
    const h = String(baseDate.getHours()).padStart(2, '0');
    const m = String(baseDate.getMinutes()).padStart(2, '0');
    const s = String(baseDate.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // 10. Data e Hora Atual (data_hora_atual, agora, data_e_hora) -> DD/MM/AAAA às HH:MM
  if (key === 'data_hora_atual' || key === 'agora' || key === 'data_e_hora') {
    const d = formatBrDate(baseDate);
    const h = String(baseDate.getHours()).padStart(2, '0');
    const m = String(baseDate.getMinutes()).padStart(2, '0');
    return `${d} às ${h}:${m}`;
  }

  // 11. Data por extenso (hoje_extenso, data_extenso) -> 23 de agosto de 2026
  if (key === 'hoje_extenso' || key === 'data_extenso') {
    const day = baseDate.getDate();
    const month = MESES[baseDate.getMonth()];
    const year = baseDate.getFullYear();
    return `${day} de ${month} de ${year}`;
  }

  // 12. Mês atual (mes_atual, mes)
  if (key === 'mes_atual' || key === 'mes') {
    return MESES[baseDate.getMonth()];
  }

  // 13. Ano atual (ano_atual, ano)
  if (key === 'ano_atual' || key === 'ano') {
    return String(baseDate.getFullYear());
  }

  // 14. Saudação por período do dia (saudacao_tempo, periodo_dia, turno_dia)
  if (
    key === 'saudacao_tempo' ||
    key === 'periodo_dia' ||
    key === 'turno_dia'
  ) {
    const hour = baseDate.getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  return null;
}

export function resolvePromptTemplateString(
  template: string,
  variables: Record<string, unknown> = {},
  now = new Date(),
  timeZone = 'America/Sao_Paulo',
): string {
  if (!template) return '';

  return template.replace(/\[\[([^\]]+)]]/g, (match, rawKey: string) => {
    const key = rawKey.trim();

    // 1. Check custom variables first
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      const val = variables[key];
      if (val === null || val === undefined) return '';
      return typeof val === 'string' ? val : JSON.stringify(val);
    }

    // 2. Check dynamic system variables
    const dynamicVal = resolveDynamicSystemVariable(key, now, timeZone);
    if (dynamicVal !== null) {
      return dynamicVal;
    }

    // 3. Keep raw placeholder if not resolved
    return match;
  });
}
