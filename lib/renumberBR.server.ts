// SERVER-ONLY — RENUMERAR UM CARRO DO BR (BR.### que mora no banco do BR).
//
// Márcio, 13/10/2026 (pedido da AutoBook GZ28BR): «all legacy in the low block with no gaps, all app in the higher block,
// with no gaps. a gap just between the 2 blocks, no mixed cars in the 2 blocks.» · «always the lowest free numbers for the
// legacy ones» · bloco do app começa em BR.401. São 185 carros do app (BR.401–BR.585) e 360 pastas legadas (001–360).
//
// Por que mora no app US: é aqui que estão as duas chaves de serviço (US e BR), o recode de pastas do Dropbox e as caixas
// de e-mail (2 e 3 são do BR). A rota é a mesma de sempre — POST /api/rides/renumber — com { zone: 'BR', code, newCode }.
//
// Corpo: { zone: 'BR', code: 'BR.105', newCode: 'BR.401', dryRun?, retryFrom? }
//   retryFrom — RETOMADA: o banco já está com newCode (uma chamada anterior parou no meio); refaz pasta/e-mail/retag a
//               partir do código antigo informado aqui.
//
// O QUE MUDA (só o que é VIVO — histórico não se reescreve: data_fixes, mensagens, logs, duty_events, quote_backups,
// financeiro_inbox, mail_processed, auto_book_mail, last_event; staff_code e season_code são outro namespace):
//   banco BR  rides.project_code · invoices.invoice_code (prefixo) · financeiro_rules.value (legenda → carro) ·
//             invoice_expenses.stock_donor · inventory.donor/supplier (dono do estoque doado)
//   banco US  rides/invoices do carro COMUM (BR.1009, BR.1010) · dyno_pulls/ride_builds/ride_build_sheets/track_runs
//             .ride_code · dyno_pulls.imported_from · financeiro_rules.value · part_streams.where_label/placed_ref ·
//             supplier_orders.car_label
//   Dropbox   «GZ28BR Rides/BR.105 - Nome» → «BR.401 - Nome» + recode de tudo que está dentro (Invoices/, HB Tuning/…);
//             carro comum: a pasta US também · BoneStock TuneRepository (retag)
//   e-mail    pasta «Rides/BR.105 - Nome» nas caixas 2 e 3 (galpaoz28, gz28br)
// Texto livre (descrição de serviço, notas) NÃO é reescrito.
//
// Primeiro CONFERE tudo e, se algo bloquear, devolve 409 SEM MEXER EM NADA. Depois aplica e PARA no primeiro erro.
// O unique de rides não é deferrable: quem roda a lista toda roda na ordem segura (quem sobe, do maior para o menor;
// quem desce, do menor para o maior). Código de destino ocupado = 409.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ROOTS, sanitize, dbxAccessToken, dbx, findFolderByCode, ensureSubfolders, pathExists, recodeTree, recodeName, codeTokenRegex } from './dropboxRides.server'
import { renameRideMailFolders, ensureRideMailFolders } from './rideMailFolders.server'
import { selfCallHeaders } from './apiAuth.server'
import { streamDb } from './stream.server'

type Passo = { passo: string; ok: boolean; detalhe?: unknown }
export const CODIGO_BR = /^BR\.\d{3,4}$/

// Colunas de texto VIVAS que citam o código do carro, por banco. Troca só o TOKEN do código (BR.105 não pega BR.1050;
// BR.105.1 vira BR.401.1).
const TEXTO_BR: [string, string][] = [['financeiro_rules', 'value'], ['invoice_expenses', 'stock_donor'], ['inventory', 'donor'], ['inventory', 'supplier']]
const TEXTO_US: [string, string][] = [['financeiro_rules', 'value'], ['part_streams', 'where_label'], ['part_streams', 'placed_ref'], ['supplier_orders', 'car_label'], ['dyno_pulls', 'imported_from']]
const RIDE_CODE_US = ['dyno_pulls', 'ride_build_sheets', 'ride_builds', 'track_runs']

async function trocaTexto(db: SupabaseClient, tabela: string, coluna: string, oldCode: string, newCode: string, dryRun: boolean): Promise<{ n: number; erro?: string }> {
  const { data, error } = await db.from(tabela).select(`id, ${coluna}`).ilike(coluna, `%${oldCode}%`)
  if (error) return { n: 0, erro: error.message }
  let n = 0
  for (const r of (data || []) as unknown as Record<string, unknown>[]) {
    const velho = String(r[coluna] ?? '')
    if (!codeTokenRegex(oldCode).test(velho)) continue
    const novo = recodeName(velho, oldCode, newCode)
    if (novo === velho) continue
    n++
    if (dryRun) continue
    const { error: e } = await db.from(tabela).update({ [coluna]: novo }).eq('id', r.id as string)
    if (e) return { n, erro: `${tabela}.${coluna} ${r.id}: ${e.message}` }
  }
  return { n }
}

async function trocaPrefixoInvoices(db: SupabaseClient, rideId: string, oldCode: string, newCode: string): Promise<{ feitas: string[]; erro?: string }> {
  const { data, error } = await db.from('invoices').select('id, invoice_code').eq('ride_id', rideId)
  if (error) return { feitas: [], erro: error.message }
  const feitas: string[] = []
  for (const inv of (data || []) as { id: string; invoice_code: string | null }[]) {
    if (!inv.invoice_code?.startsWith(oldCode + '.')) continue
    const novo = newCode + inv.invoice_code.slice(oldCode.length)
    const { error: e } = await db.from('invoices').update({ invoice_code: novo }).eq('id', inv.id)
    if (e) return { feitas, erro: `${inv.invoice_code}: ${e.message}` }
    feitas.push(`${inv.invoice_code} → ${novo}`)
  }
  return { feitas }
}

export async function renumeraCarroBR(us: SupabaseClient, br: SupabaseClient | null, b: Record<string, unknown>): Promise<NextResponse> {
  if (!br) return NextResponse.json({ ok: false, error: 'SUPABASE_BR_SERVICE_ROLE_KEY ausente no servidor do US.' }, { status: 503 })
  const temDropbox = !!(process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY)
  const dryRun = !!b.dryRun
  const pedido = String(b.code || '').trim()
  const newCode = String(b.newCode || '').trim()
  const retryFrom = String(b.retryFrom || '').trim()
  if (!CODIGO_BR.test(newCode)) return NextResponse.json({ ok: false, error: `newCode «${newCode}» não é BR.### .` }, { status: 400 })
  const retomada = !!retryFrom && retryFrom !== newCode
  const oldCode = retomada ? retryFrom : pedido
  if (!CODIGO_BR.test(oldCode)) return NextResponse.json({ ok: false, error: `code «${oldCode}» não é BR.### .` }, { status: 400 })
  if (oldCode === newCode) return NextResponse.json({ ok: true, result: 'nada a mudar', code: oldCode })

  // ── 1. CONFERÊNCIA ────────────────────────────────────────────────────────────────────────────────────────────────
  const bloqueios: string[] = []
  const plano: Passo[] = []
  const { data: brs, error: eBr } = await br.from('rides').select('id, project_name, is_quote').eq('project_code', retomada ? newCode : oldCode).limit(2)
  if (eBr) return NextResponse.json({ ok: false, error: 'Falha ao ler o BR: ' + eBr.message }, { status: 502 })
  if (!brs?.length) return NextResponse.json({ ok: false, error: `Não há ride ${retomada ? newCode : oldCode} no BR.` }, { status: 404 })
  if (brs.length > 1) bloqueios.push(`Há mais de um ride ${oldCode} no BR.`)
  const brRide = { id: String(brs[0].id), name: String(brs[0].project_name || '').trim() }
  if (!retomada) {
    const { data: ocupBR } = await br.from('rides').select('id').eq('project_code', newCode).limit(1)
    if (ocupBR?.length) bloqueios.push(`${newCode} já existe no app BR (outro carro) — rode a lista na ordem segura.`)
    const { data: ocupUS } = await us.from('rides').select('id').eq('project_code', newCode).limit(1)
    if (ocupUS?.length) bloqueios.push(`${newCode} já existe no app US.`)
  }
  // Carro COMUM (o mesmo BR.### também no banco US — BR.1009, BR.1010).
  const { data: uss } = await us.from('rides').select('id, project_name').eq('project_code', retomada ? newCode : oldCode).limit(2)
  if ((uss || []).length > 1) bloqueios.push(`Há mais de um ride ${oldCode} no US.`)
  const usRide = uss?.length ? { id: String(uss[0].id), name: String(uss[0].project_name || '').trim() } : null

  // O que muda nos textos vivos (contagem, sem escrever).
  const textos: Record<string, number> = {}
  for (const [t, c] of TEXTO_BR) { const r = await trocaTexto(br, t, c, oldCode, newCode, true); if (r.erro) bloqueios.push(`br ${t}.${c}: ${r.erro}`); else textos[`br:${t}.${c}`] = r.n }
  for (const [t, c] of TEXTO_US) { const r = await trocaTexto(us, t, c, oldCode, newCode, true); if (r.erro) bloqueios.push(`us ${t}.${c}: ${r.erro}`); else textos[`us:${t}.${c}`] = r.n }
  const rideCodes: Record<string, number> = {}
  for (const t of RIDE_CODE_US) {
    const { count, error } = await us.from(t).select('id', { count: 'exact', head: true }).eq('ride_code', oldCode)
    if (error) bloqueios.push(`us ${t}: ${error.message}`); else rideCodes[t] = count || 0
  }
  plano.push({ passo: 'banco (plano)', ok: true, detalhe: { brRide: `${oldCode} «${brRide.name}» → ${newCode}`, usComum: usRide ? `${usRide.name}` : null, textos, rideCodes } })

  // Dropbox: pasta de origem do carro (código E nome) e destino livre.
  let token = ''
  let brFrom: string | null = null, usFrom: string | null = null
  const brTarget = sanitize(`${newCode}${brRide.name ? ' - ' + brRide.name : ''}`)
  const usTarget = usRide ? sanitize(`${newCode}${usRide.name ? ' - ' + usRide.name : ''}`) : ''
  if (!temDropbox) bloqueios.push('DROPBOX_* ausente no servidor.')
  else {
    try {
      token = await dbxAccessToken()
      brFrom = await findFolderByCode(token, ROOTS.BR, sanitize(oldCode), sanitize(brRide.name) || undefined)
      if (brFrom && brFrom !== brTarget && await pathExists(token, `${ROOTS.BR}/${brTarget}`)) bloqueios.push(`Dropbox BR: já existe «${brTarget}».`)
      const rc = brFrom ? await recodeTree(token, `${ROOTS.BR}/${brFrom}`, oldCode, newCode, true) : null
      plano.push({ passo: 'dropbox-br (plano)', ok: true, detalhe: brFrom ? `${brFrom} → ${brTarget} · ${rc?.planned ?? 0} nome(s) com ${oldCode} dentro` : `sem pasta «${oldCode} - ${brRide.name}» — nada a mover` })
      if (usRide) {
        usFrom = await findFolderByCode(token, ROOTS.US, sanitize(oldCode), sanitize(usRide.name) || undefined)
        if (usFrom && usFrom !== usTarget && await pathExists(token, `${ROOTS.US}/${usTarget}`)) bloqueios.push(`Dropbox US: já existe «${usTarget}».`)
        plano.push({ passo: 'dropbox-us (plano)', ok: true, detalhe: usFrom ? `${usFrom} → ${usTarget}` : 'sem pasta US — nada a mover' })
      }
    } catch (e) { bloqueios.push('Dropbox: ' + String((e as Error)?.message || e).slice(0, 200)) }
  }

  // E-mail: caixas do BR (2 e 3).
  const mailPlano = await renameRideMailFolders(streamDb(), { oldCode, oldName: brRide.name, newCode, newName: brRide.name, slots: [2, 3], dryRun: true })
  for (const m of mailPlano) for (const c of m.conflicts) bloqueios.push(`E-mail caixa ${m.slot}: ${c}`)
  plano.push({ passo: 'e-mail (plano)', ok: true, detalhe: mailPlano.map(m => ({ slot: m.slot, conta: m.account, planejado: m.planned, erros: m.errors })) })

  if (bloqueios.length) return NextResponse.json({ ok: false, result: 'bloqueado — nada foi alterado', bloqueios, plano, oldCode, newCode }, { status: 409 })
  if (dryRun) return NextResponse.json({ ok: true, result: 'plano (dryRun) — nada foi alterado', plano, oldCode, newCode, usComum: !!usRide })

  // ── 2. APLICAÇÃO — para no primeiro erro ──────────────────────────────────────────────────────────────────────────
  const passos: Passo[] = []
  const retomar = { zone: 'BR', code: newCode, newCode, retryFrom: oldCode }
  const para = (passo: string, detalhe: unknown) => {
    passos.push({ passo, ok: false, detalhe })
    return NextResponse.json({ ok: false, result: `parou em «${passo}»`, falhouEm: passo, passos, oldCode, newCode, retomar }, { status: 500 })
  }
  const label = 'POST /api/rides/renumber (BR) — blocos: legado 001–360, app BR.401+ (Márcio 13/10/2026)'

  if (!retomada) {
    const { error: e1 } = await br.from('rides').update({ project_code: newCode }).eq('id', brRide.id)
    if (e1) return para('br: rides', e1.message)
    await br.from('data_fixes').insert({ check_key: 'ride-renumber-blocos', table_name: 'rides', row_id: brRide.id, field: 'project_code', old_value: oldCode, new_value: newCode, label })
    const ib = await trocaPrefixoInvoices(br, brRide.id, oldCode, newCode)
    if (ib.erro) return para('br: invoices', ib.erro)
    passos.push({ passo: 'br: rides + invoices', ok: true, detalhe: { ride: `${oldCode} → ${newCode}`, invoices: ib.feitas } })
    for (const [t, c] of TEXTO_BR) {
      const r = await trocaTexto(br, t, c, oldCode, newCode, false)
      if (r.erro) return para(`br: ${t}.${c}`, r.erro)
      if (r.n) passos.push({ passo: `br: ${t}.${c}`, ok: true, detalhe: `${r.n} linha(s)` })
    }
    if (usRide) {
      const { error: e2 } = await us.from('rides').update({ project_code: newCode }).eq('id', usRide.id)
      if (e2) return para('us: rides', e2.message)
      await us.from('data_fixes').insert({ check_key: 'ride-renumber-blocos', table_name: 'rides', row_id: usRide.id, field: 'project_code', old_value: oldCode, new_value: newCode, label })
      const iu = await trocaPrefixoInvoices(us, usRide.id, oldCode, newCode)
      if (iu.erro) return para('us: invoices', iu.erro)
      passos.push({ passo: 'us: rides + invoices (carro comum)', ok: true, detalhe: iu.feitas })
    }
    for (const t of RIDE_CODE_US) {
      const { data, error } = await us.from(t).update({ ride_code: newCode }).eq('ride_code', oldCode).select('id')
      if (error) return para(`us: ${t}`, error.message)
      if ((data || []).length) passos.push({ passo: `us: ${t}`, ok: true, detalhe: `${(data || []).length} linha(s)` })
    }
    for (const [t, c] of TEXTO_US) {
      const r = await trocaTexto(us, t, c, oldCode, newCode, false)
      if (r.erro) return para(`us: ${t}.${c}`, r.erro)
      if (r.n) passos.push({ passo: `us: ${t}.${c}`, ok: true, detalhe: `${r.n} linha(s)` })
    }
  }

  // Dropbox BR: move a pasta e recoda o que está dentro.
  if (brFrom && brFrom !== brTarget) {
    const mv = await dbx(token, 'files/move_v2', { from_path: `${ROOTS.BR}/${brFrom}`, to_path: `${ROOTS.BR}/${brTarget}`, autorename: false })
    if (!mv.ok) return para('dropbox-br: pasta', `${brFrom} → ${brTarget}: ${mv.text.slice(0, 200)}`)
    await ensureSubfolders(token, `${ROOTS.BR}/${brTarget}`)
    passos.push({ passo: 'dropbox-br: pasta', ok: true, detalhe: `${brFrom} → ${brTarget}` })
  }
  const brPasta = brFrom ? brTarget : (retomada && token && await pathExists(token, `${ROOTS.BR}/${brTarget}`) ? brTarget : null)
  if (brPasta) {
    const r = await recodeTree(token, `${ROOTS.BR}/${brPasta}`, oldCode, newCode)
    if (r.conflicts.length || r.failures.length) return para('dropbox-br: recode', r)
    passos.push({ passo: 'dropbox-br: recode', ok: true, detalhe: `${r.renamed.length} nome(s)` })
  }
  if (usRide && usFrom && usFrom !== usTarget) {
    const mv = await dbx(token, 'files/move_v2', { from_path: `${ROOTS.US}/${usFrom}`, to_path: `${ROOTS.US}/${usTarget}`, autorename: false })
    if (!mv.ok) return para('dropbox-us: pasta', `${usFrom} → ${usTarget}: ${mv.text.slice(0, 200)}`)
    await ensureSubfolders(token, `${ROOTS.US}/${usTarget}`)
    const r = await recodeTree(token, `${ROOTS.US}/${usTarget}`, oldCode, newCode)
    if (r.conflicts.length || r.failures.length) return para('dropbox-us: recode', r)
    passos.push({ passo: 'dropbox-us: pasta + recode', ok: true, detalhe: `${usFrom} → ${usTarget} · ${r.renamed.length} nome(s)` })
  }

  // BoneStock TuneRepository (acervo plano do BR).
  if (brRide.name) {
    const base = process.env.GZ28_SELF_URL || 'https://www.gz28us.com/ca'
    const r = await fetch(`${base}/api/ride-folder`, { method: 'POST', headers: selfCallHeaders(), body: JSON.stringify({ action: 'retag', zone: 'BR', code: newCode, name: brRide.name, oldCode, oldName: brRide.name, newCode, newName: brRide.name, rootFolder: 'BoneStock TuneRepository' }) })
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` })) as Record<string, unknown>
    if (!r.ok || j?.error || ((j?.falhas as unknown[]) || []).length) return para('retag BR', j)
    passos.push({ passo: 'retag BR', ok: true, detalhe: `${j?.renamed || 0} arquivo(s)` })
  }

  // Pasta de e-mail do carro nas caixas 2 e 3 (renomeia; se não existia, cria — é sagrada).
  const mail = await renameRideMailFolders(streamDb(), { oldCode, oldName: brRide.name, newCode, newName: brRide.name, slots: [2, 3] })
  const mailErro = mail.filter(m => m.errors.length || m.conflicts.length)
  passos.push({ passo: 'e-mail', ok: !mailErro.length, detalhe: mail.map(m => ({ slot: m.slot, conta: m.account, renomeadas: m.renamed, conflitos: m.conflicts, erros: m.errors })) })
  if (mailErro.length) return NextResponse.json({ ok: false, result: 'parou em «e-mail»', falhouEm: 'e-mail', passos, oldCode, newCode, retomar }, { status: 500 })
  if (brRide.name) {
    const garante = await ensureRideMailFolders(streamDb(), [{ code: newCode, name: brRide.name }]).catch(e => [{ slot: 0, errors: [String((e as Error)?.message || e).slice(0, 200)], conflicts: [] as string[], created: [] as string[] }])
    const ruim = (garante as { errors: string[]; conflicts: string[] }[]).filter(m => m.errors.length || m.conflicts.length)
    passos.push({ passo: 'e-mail (pasta do carro)', ok: !ruim.length, detalhe: garante })
  }

  return NextResponse.json({ ok: true, result: retomada ? 'retomado e concluído' : 'concluído', oldCode, newCode, usComum: !!usRide, passos })
}
