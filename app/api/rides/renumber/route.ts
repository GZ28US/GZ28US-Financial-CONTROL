import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, cronOk, readKeyOk, selfCallHeaders } from '@/lib/apiAuth.server'
import { supabaseBRService } from '@/lib/supabaseBR.server'
import { streamDb } from '@/lib/stream.server'
import { ROOTS, sanitize, dbxAccessToken, dbx, findFolderByCode, ensureSubfolders, pathExists, recodeTree, recodeName } from '@/lib/dropboxRides.server'
import { renameRideMailFolders, ensureRideMailFolders } from '@/lib/rideMailFolders.server'
import { parseRideCode, checkRideCode, scaleOf } from '@/lib/rideCodes'

// RENUMERAR / RENOMEAR UM CARRO — UM CAMINHO SÓ (27/set/2026).
// Pedido da AutoBook GZ28US, aprovado pelo Márcio («everything»): a tela Edit Ride, a
// troca automática de prefixo pelo destino (US/SC/WV/PO) e a renumeração dos 23 carros
// passam todas por aqui. Antes a cascata morava dentro do saveChanges da tela e não
// conferia erro de invoice nem de dyno; a pasta «renomeada» podia ser uma pasta nova e
// vazia (ok:true com 'created (no old folder found)'), e o espelho do BR sobrescrevia o
// nome do carro lá.
//
// Corpo: { rideId, newCode?, newName?, dryRun?, retryFrom? }
//   newCode / newName — o que o carro passa a ser (ausente = fica como está)
//   dryRun            — só o PLANO: confere tudo e não mexe em nada
//   retryFrom         — RETOMADA: o carro já está com newCode no banco (uma chamada
//                       anterior parou no meio); refaz os passos de pasta/e-mail/recibo
//                       a partir do código antigo informado aqui
//
// Primeiro CONFERE tudo (código livre na escala, pinned, BR, pastas de destino livres,
// pastas de e-mail) e, se algo bloquear, devolve 409 SEM MEXER EM NADA. Depois aplica
// passo a passo e PARA no primeiro erro, devolvendo o relatório de cada passo.
// Histórico NÃO é reescrito (whatsapp_messages, data_fixes, bank_match_log, matched_note,
// stream_mail_moves, mail_processed, wa_send_log, auto_book_mail, quote_backups,
// duty_events); staff_code, season_code e categories.name são outro namespace.

export const maxDuration = 300

type Passo = { passo: string; ok: boolean; detalhe?: unknown }

export async function POST(req: NextRequest) {
  if (!cronOk(req) && !readKeyOk(req) && !(await requireUser(req))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const usUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const usKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!usUrl || !usKey) return NextResponse.json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY ausente no servidor do US.' }, { status: 503 })
  const us = createClient(usUrl, usKey, { auth: { persistSession: false } })
  const br = supabaseBRService()
  const temDropbox = !!(process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY)

  const b = await req.json().catch(() => ({}))
  const rideId = String(b?.rideId || '').trim()
  const dryRun = !!b?.dryRun
  if (!rideId) return NextResponse.json({ ok: false, error: 'rideId obrigatório.' }, { status: 400 })

  const { data: ride, error: eRide } = await us.from('rides').select('id, project_code, project_name, pinned').eq('id', rideId).maybeSingle()
  if (eRide) return NextResponse.json({ ok: false, error: 'Falha ao ler o ride: ' + eRide.message }, { status: 502 })
  if (!ride) return NextResponse.json({ ok: false, error: `Ride ${rideId} não existe.` }, { status: 404 })

  const atualCode = String(ride.project_code || '').trim()
  const atualName = String(ride.project_name || '').trim()
  const retryFrom = String(b?.retryFrom || '').trim()
  const newCode = String(b?.newCode ?? atualCode).trim()
  const newName = b?.newName != null ? String(b.newName).trim() : atualName
  // Retomada: o banco já tem o código novo; os passos de fora partem do código antigo.
  const retomada = !!retryFrom && retryFrom !== atualCode && atualCode === newCode
  const oldCode = retomada ? retryFrom : atualCode
  const oldName = retomada ? String(b?.retryFromName ?? atualName).trim() : atualName
  const mudaCodigo = oldCode !== newCode
  const mudaNome = oldName !== newName
  if (!mudaCodigo && !mudaNome) return NextResponse.json({ ok: true, result: 'nada a mudar', code: atualCode, name: atualName })

  const plano: Passo[] = []
  const bloqueios: string[] = []

  // ── 1. CONFERÊNCIA ──────────────────────────────────────────────────────────
  if (mudaCodigo && !retomada) {
    if (!parseRideCode(newCode)) bloqueios.push(`«${newCode}» não é um código das séries (US.### · SC.### · WV.### · PO.### · US.QT.### · SHP.###).`)
    const { data: todos, error: eTodos } = await us.from('rides').select('project_code')
    if (eTodos) return NextResponse.json({ ok: false, error: 'Falha ao ler os códigos: ' + eTodos.message }, { status: 502 })
    const colisao = checkRideCode(newCode, (todos || []).map((r: any) => r.project_code), oldCode)
    if (colisao) bloqueios.push(colisao)
    const po = parseRideCode(oldCode), pn = parseRideCode(newCode)
    const trocaNumero = !po || !pn || po.num !== pn.num || scaleOf(po.prefix) !== scaleOf(pn.prefix)
    if (ride.pinned && trocaNumero) bloqueios.push(`${oldCode} está PINNED — o número dele nunca é realocado. Só troca de prefixo na mesma escala é permitida.`)
  }

  // BR: carro COMUM vive nos dois apps com o MESMO código.
  let brRide: { id: string; project_name: string | null } | null = null
  if (br) {
    const { data: brs, error: eBr } = await br.from('rides').select('id, project_name').eq('project_code', retomada ? newCode : oldCode).limit(2)
    if (eBr) return NextResponse.json({ ok: false, error: 'Falha ao consultar o BR: ' + eBr.message }, { status: 502 })
    if ((brs || []).length > 1) bloqueios.push(`Há mais de um ride com o código ${oldCode} no BR — resolva lá antes.`)
    else if (brs?.length) brRide = { id: String(brs[0].id), project_name: brs[0].project_name }
    if (mudaCodigo && !retomada) {
      const { data: ocup } = await br.from('rides').select('id').eq('project_code', newCode).limit(1)
      if (ocup?.length && (!brRide || String(ocup[0].id) !== brRide.id)) bloqueios.push(`O código ${newCode} já existe no app BR em outro carro.`)
    }
  } else {
    plano.push({ passo: 'br', ok: false, detalhe: 'SUPABASE_BR_SERVICE_ROLE_KEY ausente — não dá pra saber se o carro é comum ao BR.' })
    bloqueios.push('Sem a chave do BR o espelho não pode ser conferido.')
  }
  const brName = String(brRide?.project_name || '').trim()

  // Pastas do Dropbox: a de origem tem de ser do carro (código E nome) e a de destino livre.
  let token = ''
  let usFrom: string | null = null, brFrom: string | null = null
  const usTarget = sanitize(`${newCode}${newName ? ' - ' + newName : ''}`)
  const brTarget = sanitize(`${newCode}${brName ? ' - ' + brName : ''}`)
  if (!temDropbox) {
    bloqueios.push('DROPBOX_* ausente no servidor — as pastas não podem ser conferidas.')
  } else {
    try {
      token = await dbxAccessToken()
      usFrom = await findFolderByCode(token, ROOTS.US, sanitize(oldCode), sanitize(oldName) || undefined)
      if (usFrom && usFrom !== usTarget && await pathExists(token, `${ROOTS.US}/${usTarget}`)) bloqueios.push(`Dropbox US: já existe a pasta «${usTarget}».`)
      plano.push({ passo: 'dropbox-us (plano)', ok: true, detalhe: usFrom ? `${usFrom} → ${usTarget}` : `sem pasta «${oldCode}${oldName ? ' - ' + oldName : ''}» — nada a mover` })
      if (usFrom && mudaCodigo) {
        const r = await recodeTree(token, `${ROOTS.US}/${usFrom}`, oldCode, newCode, true)
        plano.push({ passo: 'dropbox-us recode (plano)', ok: true, detalhe: `${r.planned} nome(s) com ${oldCode} dentro da pasta` })
      }
      if (brRide) {
        brFrom = await findFolderByCode(token, ROOTS.BR, sanitize(oldCode), sanitize(brName) || undefined)
        if (brFrom && brFrom !== brTarget && await pathExists(token, `${ROOTS.BR}/${brTarget}`)) bloqueios.push(`Dropbox BR: já existe a pasta «${brTarget}».`)
        plano.push({ passo: 'dropbox-br (plano)', ok: true, detalhe: brFrom ? `${brFrom} → ${brTarget}` : `sem pasta BR «${oldCode}${brName ? ' - ' + brName : ''}» — nada a mover` })
      }
    } catch (e) {
      bloqueios.push('Dropbox: ' + String((e as Error)?.message || e).slice(0, 200))
    }
  }

  // Pastas de e-mail (caixas 1, 2 e 4): colisão bloqueia.
  const mailPlano = await renameRideMailFolders(streamDb(), { oldCode, oldName, newCode, newName, dryRun: true })
  for (const m of mailPlano) for (const c of m.conflicts) bloqueios.push(`E-mail caixa ${m.slot}: ${c}`)
  plano.push({ passo: 'e-mail (plano)', ok: true, detalhe: mailPlano.map(m => ({ slot: m.slot, conta: m.account, planejado: m.planned, erros: m.errors })) })

  if (bloqueios.length) return NextResponse.json({ ok: false, result: 'bloqueado — nada foi alterado', bloqueios, plano, oldCode, newCode, oldName, newName }, { status: 409 })
  if (dryRun) return NextResponse.json({ ok: true, result: 'plano (dryRun) — nada foi alterado', plano, oldCode, newCode, oldName, newName, brComum: !!brRide })

  // ── 2. APLICAÇÃO — para no primeiro erro ────────────────────────────────────
  const passos: Passo[] = []
  const para = (passo: string, detalhe: unknown) => {
    passos.push({ passo, ok: false, detalhe })
    return NextResponse.json({ ok: false, result: `parou em «${passo}»`, falhouEm: passo, passos, oldCode, newCode, retomar: { rideId, newCode, retryFrom: oldCode, retryFromName: oldName } }, { status: 500 })
  }

  if (!retomada) {
    // 2a. Banco US
    const { error: eUpd } = await us.from('rides').update({ project_code: newCode, project_name: newName || null }).eq('id', rideId)
    if (eUpd) return para('us: rides', eUpd.message)
    await us.from('data_fixes').insert({ check_key: 'ride-renumber', table_name: 'rides', row_id: rideId, field: 'project_code/project_name', old_value: `${oldCode} | ${oldName}`, new_value: `${newCode} | ${newName}`, label: 'POST /api/rides/renumber' })
    passos.push({ passo: 'us: rides', ok: true, detalhe: `${oldCode} «${oldName}» → ${newCode} «${newName}»` })
    if (mudaCodigo) {
      const { data: invs, error: eInv } = await us.from('invoices').select('id, invoice_code').eq('ride_id', rideId)
      if (eInv) return para('us: invoices', eInv.message)
      const feitas: string[] = []
      for (const inv of invs || []) {
        if (!inv.invoice_code?.startsWith(oldCode + '.')) continue
        const novo = newCode + inv.invoice_code.slice(oldCode.length)
        const { error } = await us.from('invoices').update({ invoice_code: novo }).eq('id', inv.id)
        if (error) return para('us: invoices', `${inv.invoice_code}: ${error.message}`)
        feitas.push(`${inv.invoice_code} → ${novo}`)
      }
      passos.push({ passo: 'us: invoices', ok: true, detalhe: feitas })
      for (const t of ['dyno_pulls', 'ride_build_sheets', 'ride_builds']) {
        const { data, error } = await us.from(t).update({ ride_code: newCode }).eq('ride_code', oldCode).select('id')
        if (error) return para(`us: ${t}`, error.message)
        passos.push({ passo: `us: ${t}`, ok: true, detalhe: `${(data || []).length} linha(s)` })
      }
      // imported_from guarda o código do carro de onde o pull foi importado — o app BR
      // também lê (performance/[build]). Ninguém atualizava.
      const { data: imps, error: eImp } = await us.from('dyno_pulls').select('id, imported_from').ilike('imported_from', `%${oldCode}%`)
      if (eImp) return para('us: dyno_pulls.imported_from', eImp.message)
      let nImp = 0
      for (const r of imps || []) {
        const novo = recodeName(String(r.imported_from || ''), oldCode, newCode)
        if (novo === r.imported_from) continue
        const { error } = await us.from('dyno_pulls').update({ imported_from: novo }).eq('id', r.id)
        if (error) return para('us: dyno_pulls.imported_from', error.message)
        nImp++
      }
      passos.push({ passo: 'us: dyno_pulls.imported_from', ok: true, detalhe: `${nImp} linha(s)` })
    }

    // 2b. Banco BR — só o CÓDIGO; o nome do carro no BR é do BR.
    if (brRide && mudaCodigo && br) {
      const { error: eB } = await br.from('rides').update({ project_code: newCode }).eq('id', brRide.id)
      if (eB) return para('br: rides', eB.message)
      const { data: binvs, error: eBi } = await br.from('invoices').select('id, invoice_code').eq('ride_id', brRide.id)
      if (eBi) return para('br: invoices', eBi.message)
      const feitas: string[] = []
      for (const inv of binvs || []) {
        if (!inv.invoice_code?.startsWith(oldCode + '.')) continue
        const novo = newCode + inv.invoice_code.slice(oldCode.length)
        const { error } = await br.from('invoices').update({ invoice_code: novo }).eq('id', inv.id)
        if (error) return para('br: invoices', `${inv.invoice_code}: ${error.message}`)
        feitas.push(`${inv.invoice_code} → ${novo}`)
      }
      passos.push({ passo: 'br: rides + invoices', ok: true, detalhe: { ride: `${oldCode} → ${newCode} (nome BR «${brName}» mantido)`, invoices: feitas } })
    }
  }

  // 2c. Dropbox US: mover a pasta (conferindo o resultado) e recodar tudo que está dentro.
  if (usFrom && usFrom !== usTarget) {
    const mv = await dbx(token, 'files/move_v2', { from_path: `${ROOTS.US}/${usFrom}`, to_path: `${ROOTS.US}/${usTarget}`, autorename: false })
    if (!mv.ok) return para('dropbox-us: pasta', `${usFrom} → ${usTarget}: ${mv.text.slice(0, 200)}`)
    await ensureSubfolders(token, `${ROOTS.US}/${usTarget}`)
    passos.push({ passo: 'dropbox-us: pasta', ok: true, detalhe: `${usFrom} → ${usTarget}` })
  }
  const usPasta = usFrom ? usTarget : null
  if (usPasta && mudaCodigo) {
    const r = await recodeTree(token, `${ROOTS.US}/${usPasta}`, oldCode, newCode)
    if (r.conflicts.length || r.failures.length) return para('dropbox-us: recode', r)
    passos.push({ passo: 'dropbox-us: recode', ok: true, detalhe: `${r.renamed.length} nome(s)` })
  }

  // 2d. Dropbox BR (carro comum): a pasta é achada pelo NOME DO BR.
  if (brFrom && brFrom !== brTarget) {
    const mv = await dbx(token, 'files/move_v2', { from_path: `${ROOTS.BR}/${brFrom}`, to_path: `${ROOTS.BR}/${brTarget}`, autorename: false })
    if (!mv.ok) return para('dropbox-br: pasta', `${brFrom} → ${brTarget}: ${mv.text.slice(0, 200)}`)
    await ensureSubfolders(token, `${ROOTS.BR}/${brTarget}`)
    passos.push({ passo: 'dropbox-br: pasta', ok: true, detalhe: `${brFrom} → ${brTarget}` })
  }
  const brPasta = brFrom ? brTarget : null
  if (brPasta && mudaCodigo) {
    const r = await recodeTree(token, `${ROOTS.BR}/${brPasta}`, oldCode, newCode)
    if (r.conflicts.length || r.failures.length) return para('dropbox-br: recode', r)
    passos.push({ passo: 'dropbox-br: recode', ok: true, detalhe: `${r.renamed.length} nome(s)` })
  }

  // 2e. Recibos das invoices do US: o sincronizador renomeia pelo código/nome novos.
  const base = process.env.GZ28_SELF_URL || 'https://www.gz28us.com/ca'
  if (usPasta) {
    const { data: invs } = await us.from('invoices').select('id, invoice_code, is_quote').eq('ride_id', rideId)
    const recibos: unknown[] = []
    for (const inv of invs || []) {
      if (inv.is_quote) continue
      let volta = 0, ultimo: any = null
      do {
        const r = await fetch(`${base}/api/ride-folder`, { method: 'POST', headers: selfCallHeaders(), body: JSON.stringify({ action: 'invoice-receipts', zone: 'US', invoiceId: inv.id }) })
        ultimo = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        if (!r.ok || ultimo?.error) return para('recibos: invoice-receipts', { invoice: inv.invoice_code, erro: ultimo?.error || `HTTP ${r.status}` })
        volta++
      } while ((ultimo?.pending || 0) > 0 && volta < 10)
      if ((ultimo?.failed || []).length || (ultimo?.pending || 0) > 0) return para('recibos: invoice-receipts', { invoice: inv.invoice_code, pendentes: ultimo?.pending, falhas: ultimo?.failed })
      recibos.push({ invoice: inv.invoice_code, result: ultimo?.result, enviados: (ultimo?.uploaded || []).length })
    }
    passos.push({ passo: 'recibos: invoice-receipts', ok: true, detalhe: recibos })
  }

  // 2f. BoneStock TuneRepository (acervo plano) — US e, no carro comum, BR com o nome do BR.
  for (const z of brPasta || brRide ? ['US', 'BR'] : ['US']) {
    const nomeZ = z === 'BR' ? brName : ''
    const corpo = z === 'US'
      ? { action: 'retag', zone: 'US', code: newCode, name: newName, oldCode, oldName, newCode, newName, rootFolder: 'BoneStock TuneRepository' }
      : { action: 'retag', zone: 'BR', code: newCode, name: nomeZ, oldCode, oldName: nomeZ, newCode, newName: nomeZ, rootFolder: 'BoneStock TuneRepository' }
    if (z === 'BR' && !nomeZ) continue
    const r = await fetch(`${base}/api/ride-folder`, { method: 'POST', headers: selfCallHeaders(), body: JSON.stringify(corpo) })
    const j: any = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    if (!r.ok || j?.error || (j?.falhas || []).length) return para(`retag ${z}`, j)
    passos.push({ passo: `retag ${z}`, ok: true, detalhe: `${j?.renamed || 0} arquivo(s)` })
  }

  // 2g. Pastas de e-mail nas caixas 1, 2 e 4.
  const mail = await renameRideMailFolders(streamDb(), { oldCode, oldName, newCode, newName })
  const mailErro = mail.filter(m => m.errors.length || m.conflicts.length)
  passos.push({ passo: 'e-mail', ok: !mailErro.length, detalhe: mail.map(m => ({ slot: m.slot, conta: m.account, renomeadas: m.renamed, conflitos: m.conflicts, erros: m.errors })) })
  if (mailErro.length) return NextResponse.json({ ok: false, result: 'parou em «e-mail»', falhouEm: 'e-mail', passos, oldCode, newCode, retomar: { rideId, newCode, retryFrom: oldCode, retryFromName: oldName } }, { status: 500 })

  // 2h. A PASTA DE E-MAIL EXISTE? (Márcio, 05/out/2026 — sagrada). O passo acima só RENOMEIA pasta que já existia; quote
  // promovida a carro (US.QT.017 → US.047) nunca teve pasta e ficava sem. Quote e SHP continuam fora (decisão dele pendente).
  if (!/^(US\.QT|SHP)\./.test(newCode)) {
    const garante = await ensureRideMailFolders(streamDb(), [{ code: newCode, name: newName }]).catch(e => [{ slot: 0, account: '', provider: '', company: null, ok: 0, created: [], renamed: [], conflicts: [], misplaced: [], extras: [], foreign: [], errors: [String((e as Error)?.message || e).slice(0, 200)] }])
    const ruim = garante.filter(m => m.errors.length || m.conflicts.length)
    passos.push({ passo: 'e-mail (pasta do carro)', ok: !ruim.length, detalhe: garante.map(m => ({ slot: m.slot, conta: m.account, criadas: m.created, renomeadas: m.renamed, conflitos: m.conflicts, erros: m.errors })) })
  }

  return NextResponse.json({ ok: true, result: retomada ? 'retomado e concluído' : 'concluído', oldCode, newCode, oldName, newName, brComum: !!brRide, passos })
}
