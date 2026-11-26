// HORAS DO SERVIÇO = O DOBRO DAS HORAS REAIS DAS DUTIES (Márcio, 26/11/2026, via CC Sidney: «o número de horas nos services tem
// que aparecer o dobro do que é nas duties» · «quem rege a precificação é o tempo das duties, nos itens é só pro cliente ver que
// é pica o serviço» · «isso é pra todas as invoices nos 2 apps» · «mostrando o dobro do real, que está nas duties»).
// SÓ EXIBIÇÃO: não entra em conta nenhuma, não muda preço nem a hora real da duty.
// O elo mora na DUTY (invoice_duties.service_id → invoice_services): um serviço pode juntar várias duties (tirar + instalar os
// coletores = «Headers Installation»). A hora vem SEMPRE de invoice_duties.estimated_seconds; o serviço não tem campo de horas
// (1 info = 1 campo). O serviço de MÃO DE OBRA DO PROJETO INTEIRO («Full Project Labor», «Mão de obra total do projeto», «Mão de
// obra») junta também toda duty que não aponta para outro serviço. Sem duty, ou duties sem tempo previsto → nada aparece.
// Isomórfico: o mesmo arquivo vive no app US e no app BR.
export const SERVICE_HOURS_FACTOR = 2

const plain = (t: unknown) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
/** «Full Project Labor» · «Mão de obra total (do projeto)» · «Mão de obra» — the labor of the whole job */
export const isWholeLabor = (description: unknown) => /^(full project labor|mao de obra( total( do projeto)?)?|labor)$/.test(plain(description))

type Svc = { id?: string | null; description?: string | null }
type Duty = { service_id?: string | null; estimated_seconds?: number | string | null }

/** service id → hours to SHOW (2× the real duty hours), only for services that have any */
export function servicesHours(services: Svc[], duties: Duty[]): Map<string, number> {
  const ids = new Set(services.map(s => String(s.id || '')).filter(Boolean))
  const secs = new Map<string, number>()
  let loose = 0
  for (const d of duties) {
    const s = Number(d.estimated_seconds) || 0
    if (!(s > 0)) continue
    const sid = d.service_id ? String(d.service_id) : ''
    if (sid && ids.has(sid)) secs.set(sid, (secs.get(sid) || 0) + s)
    else loose += s
  }
  const whole = services.find(s => s.id && isWholeLabor(s.description))
  if (whole && loose > 0) secs.set(String(whole.id), (secs.get(String(whole.id)) || 0) + loose)
  const out = new Map<string, number>()
  for (const [id, s] of secs) out.set(id, Math.round((s / 3600) * SERVICE_HOURS_FACTOR * 100) / 100)
  return out
}

/** "10 h" · "2.5 h" (en) / "2,5 h" (pt) */
export const fmtServiceHours = (h: number | null | undefined, lang: 'en' | 'pt' = 'en') =>
  h == null ? '' : `${lang === 'pt' ? String(h).replace('.', ',') : String(h)} h`
