// HORAS DO SERVIÇO = O DOBRO DAS HORAS DA DUTY (Márcio, 26/11/2026, via CC Sidney: «o número de horas nos services tem que
// aparecer o dobro do que é nas duties» · «quem rege a precificação é o tempo das duties, nos itens é só pro cliente ver que é
// pica o serviço»). SÓ EXIBIÇÃO: não entra em conta nenhuma, não muda preço nem a hora real da duty.
// O serviço aponta para a sua duty (invoice_services.duty_id); a hora vem SEMPRE de invoice_duties.estimated_seconds —
// nenhum campo de horas no serviço (1 info = 1 campo). Sem duty ligada, ou duty sem tempo previsto → nada aparece.
export const SERVICE_HOURS_FACTOR = 2

export function serviceHours(dutyId: string | null | undefined, dutySecs: Map<string, number> | Record<string, number>): number | null {
  if (!dutyId) return null
  const s = Number(dutySecs instanceof Map ? dutySecs.get(dutyId) : dutySecs[dutyId]) || 0
  if (!(s > 0)) return null
  return Math.round((s / 3600) * SERVICE_HOURS_FACTOR * 100) / 100
}

/** "10 h" · "2.5 h" (en) / "2,5 h" (pt) */
export const fmtServiceHours = (h: number | null | undefined, lang: 'en' | 'pt' = 'en') =>
  h == null ? '' : `${lang === 'pt' ? String(h).replace('.', ',') : String(h)} h`
