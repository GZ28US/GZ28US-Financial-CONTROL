// lib/packPerformance.server.ts — A PERFORMANCE NASCE COM A INVOICE DO PACK VALIDADO (18/10/2026).
//
// Márcio (18/10/2026, via Parts & Packs): «para os packs shop locked, que já estiverem validados, quando uma invoice de um carro
// for aberta já com este pack, o app já deve criar em performance, o BoneStock, o Pack novo e a build sheet. OBS: O BoneStock não
// deve ter BuildSheet, uma vez que é BoneStock, não tem nenhuma mod.»
//
// QUANDO: invoice de verdade (não quote) de um CARRO, aberta com um pack shop_locked que tem packs.validated_by. Chamado pela tela
// de nova invoice (depois do applyPack) e pelo editor quando a quote vira invoice — /api/performance/seed-pack. Idempotente: se o
// carro já tem um build com o nome do pack, não faz nada.
// O QUE CRIA (tabelas compartilhadas por ride_code — ride_builds / dyno_pulls / ride_build_sheets):
//   1. BoneStock — só se o carro ainda não tem linha de base. Mora no build_no 1 (os builds que existirem sobem uma casa, como o
//      «+ BUILD» da tela faz). A puxada da base: a BoneStock ESCANEADA de um carro idêntico (mesmo brand/model/version — a mesma
//      importação da tela, com imported_from), senão a PREVISÃO da fábrica (BASELINE_PREDICTION, potência de fábrica × perda
//      padrão). SEM build sheet — a base não tem mod (lei de 09/10).
//   2. O build do pack — ride_builds.name = o nome do pack (a meta sai do nome, packTargetBhp). Aparece como Build.01.
//   3. A Build Sheet desse build — copiada de packs.build_sheet (o modelo que a Parts & Packs preenche). Sem modelo = build sem
//      sheet, e o resultado diz isso.
// Trilha em data_fixes ('pack-performance-seed').
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isBaselineName, BASELINE_PREDICTION } from '@/lib/utils'
import { factorySpecs } from '@/lib/factorySpecs.server'

// As colunas da Build Sheet (BS_FIELDS de app/rides/[id]/performance/[build]/page.tsx + power_source). Só elas saem do modelo.
const SHEET_KEYS = ['power_source', 'intake', 'throttle_body', 'intake_manifold', 'snout', 'supercharger', 'pulley_size', 'lower_pulley_size',
  'fuel_rails', 'injectors', 'spark_plugs', 'map_sensor', 'heads', 'cam', 'vvt', 'displacement', 'compression_ratio', 'headers', 'cats', 'catback',
  'fuel_pump', 'bap', 'fuel_line', 'fuel_press_regulator', 'flex_sensor', 'fuel', 'transmission', 'traction_tires', 'os_update', 'notes'] as const

export type SeedResult = { ok: boolean; skipped?: string; ride_code?: string; pack?: string; bonestock?: string; build_no?: number; sheet?: string; errors: string[] }

const isTrueBoneStock = (p: Row) => String(p.pack || '').trim().toLowerCase() === 'bonestock'
type Row = Record<string, any>

// A perda padrão do carro — a mesma régua do defaultLoss da tela do build: Durango 20%, Hellcat/Redeye WideBody (não SuperStock) 17%, resto 15%.
function perdaPadrao(ride: Row): number {
  const txt = [ride.brand, ride.model, ride.version, ride.special_edition].filter(Boolean).join(' ').toLowerCase()
  if (/durango/.test(txt)) return 20
  if (/(challenger|charger)/.test(txt) && /(hellcat|red\s*eye)/.test(txt) && /(wide\s*body)/.test(txt) && !/(super\s*stock)/.test(txt)) return 17
  return 15
}

async function trilha(db: SupabaseClient, rideCode: string, field: string, value: string, label: string) {
  await db.from('data_fixes').insert({ check_key: 'pack-performance-seed', table_name: 'ride_builds', row_id: rideCode, field, old_value: null, new_value: value, label: label.slice(0, 500) }).then(() => undefined, () => undefined)
}

export async function seedPackPerformance(db: SupabaseClient, invoiceId: string): Promise<SeedResult> {
  const r: SeedResult = { ok: true, errors: [] }
  const { data: inv, error: eInv } = await db.from('invoices').select('id, invoice_code, ride_id, is_quote, pack_id, service').eq('id', invoiceId).maybeSingle()
  if (eInv) return { ok: false, errors: ['invoice: ' + eInv.message] }
  if (!inv) return { ok: false, errors: ['invoice não existe'] }
  if (inv.is_quote) return { ...r, skipped: 'quote — a performance nasce quando vira invoice' }
  if (!inv.ride_id) return { ...r, skipped: 'invoice sem carro' }

  // O pack: o pack_id gravado na abertura; invoice antiga (sem pack_id) cai no nome exato do SERVICE.
  let pack: Row | null = null
  if (inv.pack_id) pack = (await db.from('packs').select('id, name, shop_locked, validated_by, build_sheet').eq('id', inv.pack_id).maybeSingle()).data
  else if (inv.service) {
    const { data } = await db.from('packs').select('id, name, shop_locked, validated_by, build_sheet').eq('name', String(inv.service).trim()).eq('shop_locked', true)
    if (data?.length === 1) pack = data[0]
  }
  if (!pack) return { ...r, skipped: 'invoice sem pack' }
  if (!pack.shop_locked) return { ...r, skipped: `pack ${pack.name} não é GZ28 Shop LOCKED` }
  if (!String(pack.validated_by || '').trim()) return { ...r, skipped: `pack ${pack.name} ainda não é validado (packs.validated_by vazio)` }
  r.pack = pack.name

  const { data: ride, error: eRide } = await db.from('rides').select('id, project_code, manufacturer, brand, model, version, year, special_edition').eq('id', inv.ride_id).maybeSingle()
  if (eRide || !ride) return { ok: false, errors: ['ride: ' + (eRide?.message || 'não existe')] }
  const code = String(ride.project_code || '')
  if (!code) return { ...r, skipped: 'carro sem project_code' }
  r.ride_code = code

  const { data: builds0, error: eB } = await db.from('ride_builds').select('id, build_no, name').eq('ride_code', code)
  if (eB) return { ok: false, errors: ['ride_builds: ' + eB.message] }
  let builds = (builds0 || []) as Row[]
  const nomePack = String(pack.name).trim().toLowerCase()
  if (builds.some(b => String(b.name || '').trim().toLowerCase() === nomePack)) return { ...r, skipped: `o carro já tem o build ${pack.name}` }

  // ── 1. BoneStock ──
  const { data: pulls } = await db.from('dyno_pulls').select('id, build_no, pack').eq('ride_code', code)
  const temBasePuxada = (pulls || []).some((p: Row) => isBaselineName(p.pack))
  const temBaseBuild = builds.some(b => isBaselineName(b.name))
  if (!temBaseBuild && !temBasePuxada) {
    // a base mora no build_no 1: os builds que já existem sobem uma casa, do maior para o menor (sem colisão)
    for (const n of builds.map(b => Number(b.build_no)).sort((a, b) => b - a)) {
      for (const t of ['ride_builds', 'dyno_pulls', 'ride_build_sheets']) {
        const { error } = await db.from(t).update({ build_no: n + 1 }).eq('ride_code', code).eq('build_no', n)
        if (error) return { ok: false, errors: [`abrir espaço para a BoneStock (${t} ${n}→${n + 1}): ${error.message}`] }
      }
    }
    builds = builds.map(b => ({ ...b, build_no: Number(b.build_no) + 1 }))
    const { error: eIns } = await db.from('ride_builds').insert([{ ride_code: code, build_no: 1, name: 'BoneStock' }])
    if (eIns) return { ok: false, errors: ['criar a BoneStock: ' + eIns.message] }
    builds.push({ build_no: 1, name: 'BoneStock' })

    // a puxada: BoneStock escaneada de carro idêntico (original, não importada) → previsão de fábrica
    const { data: twins } = await db.from('rides').select('project_code, project_name').eq('brand', ride.brand || '').eq('model', ride.model || '').eq('version', ride.version || '').neq('project_code', code)
    const codes = (twins || []).map((t: Row) => t.project_code).filter(Boolean)
    let ref: Row | null = null
    if (codes.length) {
      const { data: bones } = await db.from('dyno_pulls').select('*').in('ride_code', codes).not('whp', 'is', null).is('imported_from', null).order('created_at', { ascending: false })
      const verdadeiras = ((bones || []) as Row[]).filter(isTrueBoneStock)
      ref = verdadeiras.find(b => b.loss_pct != null) || verdadeiras[0] || null
    }
    if (ref) {
      const { error } = await db.from('dyno_pulls').insert([{ ride_code: code, build_no: 1, origin: ref.origin || 'US', pack: 'BoneStock', whp: ref.whp, wnm: ref.wnm, loss_pct: ref.loss_pct,
        bhp: ref.bhp, bnm: ref.bnm, correction_factor: ref.correction_factor ?? null, pull_date: ref.pull_date, dyno: ref.dyno, document_url: ref.document_url, imported_from: ref.ride_code }])
      if (error) r.errors.push('BoneStock importada: ' + error.message)
      r.bonestock = `importada de ${ref.ride_code} (BoneStock escaneada, perda ${ref.loss_pct ?? '?'}%)`
    } else {
      let hp: number | null = null, nm: number | null = null
      try { ({ hp, nm } = await factorySpecs(ride)) } catch (e) { r.errors.push('potência de fábrica: ' + String((e as Error).message || e)) }
      const loss = perdaPadrao(ride), lf = 1 - loss / 100
      const linha = code.startsWith('BR.')
        ? (() => { const CORR = 1.11, kgfm = nm != null ? nm / 9.80665 : null
          return { origin: 'BR', whp: hp != null ? Math.round((hp * lf / CORR) * 100) / 100 : null, wnm: kgfm != null ? Math.round((kgfm * lf / CORR) * 100) / 100 : null, correction_factor: CORR, bhp: hp, bnm: kgfm != null ? Math.round(kgfm * 100) / 100 : null } })()
        : (() => { const lbft = nm != null ? nm / 1.3558179 : null
          return { origin: 'US', whp: hp != null ? Math.round(hp * lf * 100) / 100 : null, wnm: lbft != null ? Math.round(lbft * lf * 100) / 100 : null, bhp: hp, bnm: lbft != null ? Math.round(lbft * 100) / 100 : null } })()
      const { error } = await db.from('dyno_pulls').insert([{ ride_code: code, build_no: 1, pack: BASELINE_PREDICTION, loss_pct: loss, pull_date: null, dyno: null, document_url: null, ...linha }])
      if (error) r.errors.push('BoneStock prevista: ' + error.message)
      r.bonestock = hp != null ? `previsão de fábrica (${hp} hp, perda ${loss}%)` : `previsão SEM potência de fábrica (perda ${loss}%) — complete na tela`
    }
    await trilha(db, code, 'BoneStock', 'build_no 1', `${inv.invoice_code} · ${pack.name}: BoneStock ${r.bonestock}`)
  } else r.bonestock = 'o carro já tinha linha de base'

  // ── 2. O build do pack ──
  const next = Math.max(0, ...builds.map(b => Number(b.build_no))) + 1
  const { error: eBuild } = await db.from('ride_builds').insert([{ ride_code: code, build_no: next, name: pack.name }])
  if (eBuild) return { ...r, ok: false, errors: [...r.errors, 'criar o build do pack: ' + eBuild.message] }
  r.build_no = next
  await trilha(db, code, 'build', `build_no ${next}`, `${inv.invoice_code}: build ${pack.name} criado pela invoice (pack validado: ${pack.validated_by})`)

  // ── 3. A Build Sheet do build do pack (nunca da BoneStock) ──
  const modelo = pack.build_sheet && typeof pack.build_sheet === 'object' ? pack.build_sheet as Row : null
  if (!modelo) r.sheet = 'o pack ainda não tem modelo de Build Sheet (packs.build_sheet) — build criado sem sheet'
  else {
    const payload: Row = { ride_code: code, build_no: next, updated_at: new Date().toISOString() }
    for (const k of SHEET_KEYS) if (modelo[k] != null && String(modelo[k]).trim() !== '') payload[k] = modelo[k]
    const { error } = await db.from('ride_build_sheets').upsert(payload, { onConflict: 'ride_code,build_no' })
    if (error) r.errors.push('Build Sheet: ' + error.message)
    else r.sheet = `Build Sheet copiada do pack (${Object.keys(payload).length - 3} campos)`
  }
  r.ok = !r.errors.length
  return r
}
