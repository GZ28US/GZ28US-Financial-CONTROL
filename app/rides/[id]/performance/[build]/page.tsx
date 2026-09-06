'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/Header'
import { supabase } from '@/lib/supabase'
import { BASE_PATH, toWaNumber, packTargetBhp, isBaselineName, isPredictedBaseline, BASELINE_PREDICTION } from '@/lib/utils'
import { fileForScan } from '@/lib/scanFile'

// DYNO primeiro e por padrão (ordem do usuário, 17/ago/2026): dentro de um pack é a
// página principal — é ela que diz onde o carro está e quanto falta pra meta.
const TABS = ['DYNO', 'BUILD SHEET', '1/4 MILE', '1/8 MILE', '100-200'] as const
type Tab = typeof TABS[number]

const DYNO_OPTIONS = ['DynoSolutions DynoJet', 'GZ28US DynoJet', 'GZ28BR ServiTec', 'ArteCarros ServiTec', 'Absoluto']

const MONTHS: [string, string][] = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'], ['05', 'May'], ['06', 'June'],
  ['07', 'July'], ['08', 'August'], ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))
const YEARS = Array.from({ length: new Date().getFullYear() - 2025 + 1 }, (_, i) => String(new Date().getFullYear() - i))

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}
function fmtDate(d: string | null) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
// Crank value = wheel value / (1 - loss%). e.g. 850 whp @ 15% loss => 1000 bhp (same for torque)
function applyLoss(wheel: string, loss: string): number | null {
  const w = parseFloat(wheel)
  if (!isFinite(w)) return null
  const l = loss === '' ? 0 : parseFloat(loss)
  if (!isFinite(l)) return null
  const denom = 1 - l / 100
  if (denom <= 0) return null
  return Math.round((w / denom) * 100) / 100
}

// `borrowed` = a BoneStock do carro EMPRESTADA de outro build: aparece na tabela como a
// linha de base, mas não é editável nem removível daqui — a dona é o build de origem.
type DynoPull = { id: string; ride_code?: string; build_no?: number; pack: string | null; whp: number | null; wnm: number | null; loss_pct: number | null; bhp: number | null; bnm: number | null; pull_date: string | null; dyno: string | null; document_url: string | null; origin?: string | null; correction_factor?: number | null; imported_from?: string | null; foreign?: boolean; borrowed?: boolean; linked?: string; linkedName?: string }

// BR-recorded pulls store UNCORRECTED wheel figures, torque in kgf·m and an SAE correction
// factor; this app shows corrected STD figures with torque in lb·ft. Convert once at load —
// everything downstream (table, gains, PDF, reports) then speaks the local dialect.
// BoneStock included: US always shows STD, so even the factory baseline reads ×1.04 vs BR's SAE.
const KGFM_TO_LBFT = 9.80665 / 1.3558179 // kgf·m → lb·ft
const SAE_TO_STD = 1.04
function toLocalDialect(p: DynoPull): DynoPull {
  if (p.origin !== 'BR') return p
  const r2 = (x: number) => Math.round(x * 100) / 100
  const denom = p.loss_pct != null && p.loss_pct < 100 ? 1 - p.loss_pct / 100 : null
  const cf = (p.correction_factor ?? 1) * SAE_TO_STD
  const whp = p.whp != null ? r2(p.whp * cf) : null
  const wnm = p.wnm != null ? r2(p.wnm * cf * KGFM_TO_LBFT) : null
  return {
    ...p,
    whp, wnm,
    bhp: whp != null && denom != null ? r2(whp / denom) : null,
    bnm: wnm != null && denom != null ? r2(wnm / denom) : null,
    foreign: true,
  }
}

// A linha de BASE é identificada pelo PACK: "BoneStock" (fábrica) ou "Stock" (a base
// DESTE carro — mesmo comportamento, só não é oferecida aos outros; ver isBaselineName).
function isBoneStock(p: { pack: string | null }) { return isBaselineName(p.pack) }
// Estrito: só a BoneStock de verdade pode ser emprestada a OUTROS carros.
function isTrueBoneStock(p: { pack: string | null }) { return (p.pack || '').trim().toLowerCase() === 'bonestock' }

// BONESTOCK VIVA (user law 21/aug/2026): an imported baseline is a POINTER to the origin
// car — the figures are read THERE, now. Changed at the origin → changed everywhere
// (dyno table, loss label, BuildSheet FROM/TARGET, PDF). Only ORIGINALS can be a
// source; the origin's current baseline follows the origin page's own pin rule (newest,
// preferring one with a loss on file); predictions never propagate.
async function resolveLiveBaselines(list: DynoPull[]): Promise<DynoPull[]> {
  const srcCodes = [...new Set(list.filter((p) => p.imported_from && isBoneStock(p)).map((p) => String(p.imported_from)))]
  if (srcCodes.length === 0) return list
  const [{ data: srcRows }, { data: srcRides }] = await Promise.all([
    supabase.from('dyno_pulls').select('*').in('ride_code', srcCodes).is('imported_from', null).order('created_at', { ascending: false }),
    supabase.from('rides').select('project_code, project_name').in('project_code', srcCodes),
  ])
  const names = new Map<string, string>(((srcRides || []) as any[]).map((r) => [String(r.project_code), String(r.project_name || '')]))
  const current = new Map<string, DynoPull>()
  for (const code of srcCodes) {
    const own = ((srcRows || []) as DynoPull[]).filter((r) => r.ride_code === code && isTrueBoneStock(r))
    const pick = own.find((r) => r.loss_pct != null) ?? own[0]
    if (pick) current.set(code, pick)
  }
  return list.map((p) => {
    const src = p.imported_from && isBoneStock(p) ? current.get(String(p.imported_from)) : undefined
    if (!src) return p
    // THIS row keeps its identity (id / ride_code / build_no / imported_from); every
    // measured figure comes from the origin.
    return { ...p, pack: src.pack, whp: src.whp, wnm: src.wnm, loss_pct: src.loss_pct, bhp: src.bhp, bnm: src.bnm, correction_factor: src.correction_factor ?? null, pull_date: src.pull_date, dyno: src.dyno, document_url: src.document_url, origin: src.origin, linked: String(p.imported_from), linkedName: names.get(String(p.imported_from)) || '' }
  })
}


// Every performance-page report (dyno pulls, DynoData receipt, DataSheet) goes to
// this WhatsApp group ONLY — never the default group.
const REPORTS_GROUP = 'GZ28US - Tcal'

function DynoSection({ rideId, rideCode, rideTitle, buildNo, defaultLoss, packName }: { rideId: string; rideCode: string; rideTitle: string; buildNo: number; defaultLoss: string; packName: string }) {
  const [pulls, setPulls] = useState<DynoPull[]>([])
  // A PERDA DO CARRO (ordem do usuário, 17/ago/2026): quando o carro tem uma puxada
  // BoneStock — em QUALQUER build — a perda dela é A perda do carro (deduzida da potência
  // de fábrica). Os outros packs não pedem perda nenhuma e ela não é editável: BoneStock
  // define, o resto consome.
  const [carLoss, setCarLoss] = useState<number | null>(null)
  // De qual baseline a perda veio ("BoneStock" ou "Stock") — só pro rótulo na tela.
  const [carLossFrom, setCarLossFrom] = useState('BoneStock')
  // IMPORT BoneStock (ordem do usuário, 17/ago/2026): carro SEM baseline própria, mas com
  // CARROS IDÊNTICOS no sistema que têm BoneStock — oferece importar a de um deles como
  // referência. `carHasBone` começa true (pessimista) pra o botão nunca piscar antes do load.
  const [carHasBone, setCarHasBone] = useState(true)
  const [importables, setImportables] = useState<{ row: DynoPull; label: string; whp: number | null }[]>([])
  const [showImport, setShowImport] = useState(false)
  const [importing, setImporting] = useState(false)
  const [predicting, setPredicting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ pack: '', whp: '', wnm: '', loss: defaultLoss, dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ pack: '', whp: '', wnm: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
  const editBhp = applyLoss(editForm.whp, editForm.loss)
  const editBnm = applyLoss(editForm.wnm, editForm.loss)

  // ---- META DO PACK -----------------------------------------------------------------
  // O nome do build (camada anterior) é o pacote contratado e diz a meta em bhp de virabrequim:
  // "Z1250sc Alpha170 Pack" = 1250 bhp. O dinamômetro mede RODA, então a meta é convertida
  // pela MESMA perda que o carro já usa nas puxadas — não uma perda inventada.
  // Pack EFETIVO do formulário (o do build, ou o que ele digitou) — é ele que decide se
  // esta puxada é a linha de fábrica.
  const bonestockPack = isBoneStock({ pack: (form.pack.trim() || packName || '') })

  const targetBhp = packTargetBhp(packName)
  // Perda em uso: a da puxada mais recente do carro (as linhas vêm em created_at DESC, com
  // a BoneStock fixada no topo — por isso ela é pulada primeiro). Sem puxada nenhuma, vale a
  // que estiver no formulário (ou o padrão do carro), para a meta já aparecer no carro novo.
  const lossInUse = (() => {
    // A perda da BoneStock do carro manda em tudo, quando existe.
    if (carLoss != null) return carLoss
    const real = pulls.filter(p => !isBoneStock(p) && p.loss_pct != null)
    if (real.length) return Number(real[0].loss_pct)
    const anyPull = pulls.find(p => p.loss_pct != null)
    if (anyPull) return Number(anyPull.loss_pct)
    const typed = parseFloat(form.loss)
    return Number.isFinite(typed) ? typed : NaN
  })()
  const targetWhp = targetBhp != null && Number.isFinite(lossInUse) && lossInUse > 0 && lossInUse < 100
    ? targetBhp * (1 - lossInUse / 100)
    : null
  // "Quanto falta" é medido contra o MELHOR whp já feito pelo carro (recorde da máquina).
  // "MELHOR" É PUXADA DE VERDADE: a linha de base não é puxada do pacote, é o ponto de
  // partida — contá-la como "best pull" faz um carro sem puxada nenhuma parecer que já
  // rodou (era o que o PDF do GoldenEye mostrava: baseline e best iguais).
  const bestWhp = pulls.reduce((max, p) => (isBoneStock(p) ? max : Math.max(max, Number(p.whp) || 0)), 0)
  const baseWhp = pulls.reduce((max, p) => (isBoneStock(p) ? Math.max(max, Number(p.whp) || 0) : max), 0)
  // Mas o QUE FALTA se mede de onde o carro ESTÁ: sem puxada, ele está na linha de base.
  const fromWhp = Math.max(bestWhp, baseWhp)
  const gapWhp = targetWhp != null ? targetWhp - fromWhp : null
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scannedFile, setScannedFile] = useState<File | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)
  const [client, setClient] = useState<{ name: string | null; email: string | null; phone: string | null; country: string | null; preferred_message_method: string | null; instagram: string | null; facebook: string | null } | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  // After a pull is saved, ask whether to report it on WhatsApp (and optionally to the client).
  const [reportPull, setReportPull] = useState<DynoPull | null>(null)
  const [reportToClient, setReportToClient] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [car, setCar] = useState<{ manufacturer: string | null; brand: string | null; model: string | null; version: string | null; special_edition: string | null; year: number | null } | null>(null)
  // "SEND DYNO DATA" — generate the full sheet PDF and WhatsApp it (group + optionally client).
  const [dynoSendOpen, setDynoSendOpen] = useState(false)
  const [dynoSendToClient, setDynoSendToClient] = useState(false)
  const [dynoSending, setDynoSending] = useState(false)
  // Loss (crank→wheel) is a per-ride CONSTANT — entered once, shown above the table, not a column.
  const [editingLoss, setEditingLoss] = useState(false)
  const [lossDraft, setLossDraft] = useState(defaultLoss)
  const rideLoss = pulls.find((p) => p.loss_pct != null)?.loss_pct ?? null
  // Display order = chronological: BoneStock (the baseline) first, then every other pull
  // OLDEST → NEWEST. `pulls` itself stays newest-first so the "latest pull" logic (gains,
  // receipt) keeps working; only what's shown/printed reads oldest-first.
  const orderedPulls = (() => {
    const bs = pulls.find(isBoneStock)
    const others = pulls.filter((p) => !isBoneStock(p)).slice().reverse()
    return [...(bs ? [bs] : []), ...others]
  })()

  useEffect(() => {
    (async () => {
      const { data: rideRow } = await supabase.from('rides').select('client_id, manufacturer, brand, model, version, special_edition, year').eq('id', rideId).single()
      if (rideRow) {
        setCar({ manufacturer: rideRow.manufacturer, brand: rideRow.brand, model: rideRow.model, version: rideRow.version, special_edition: (rideRow as any).special_edition ?? null, year: rideRow.year })
        if (rideRow.client_id) {
          const { data: c } = await supabase.from('clients').select('name, email, phone, country, preferred_message_method, instagram, facebook').eq('id', rideRow.client_id).single()
          if (c) setClient(c as typeof client)
        }
      }
    })()
  }, [])

  async function handleScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setScanning(true)
    try {
      const { base64, mediaType } = await fileForScan(file)
      const res = await fetch(`${BASE_PATH}/api/scan-dyno`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mediaType: mediaType || 'application/octet-stream' }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { alert(data.error || 'Scan failed.'); return }
      const m = String(data.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)

      // BONESTOCK É 100% PELO SCAN (só neste caso; packs normais seguem o fluxo manual).
      // A perda não se chuta, se DEDUZ: o BoneStock É o carro de fábrica, então o bhp da
      // conta TEM que bater com a potência declarada — a única incógnita é a perda:
      //   loss = (1 − whp / hp_fábrica) × 100, arredondada de 0,5 em 0,5 (12,97% -> 13%).
      // Deduziu, GRAVA sozinho — não existe botão de inserir neste caminho.
      const effPack = (form.pack.trim() || data.pack || packName || '').trim()
      const scannedWhp = parseFloat(String(data.whp ?? '')) || 0
      if (isBoneStock({ pack: effPack })) {
        if (!(scannedWhp > 0)) { alert('The scan found no WHP figure on this sheet — BoneStock cannot be saved without it. Scan a clearer sheet.'); return }
        if (!car) { alert('Car identity not loaded yet — try again in a second.'); return }
        let hp = 0
        try {
          const fr = await fetch(`${BASE_PATH}/api/factory-specs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(car),
          })
          const fs = await fr.json().catch(() => ({}))
          hp = Number(fs?.hp) || 0
        } catch { /* tratado abaixo */ }
        if (!(hp > 0)) { alert('Could not fetch the factory power rating for this car — BoneStock needs it to deduce the loss. Try again.'); return }
        if (scannedWhp >= hp) {
          // Roda medindo mais que o virabrequim de fábrica: ou o carro não está stock,
          // ou a folha não é deste carro. Não inventa perda negativa — não grava nada.
          alert(`This pull reads ${scannedWhp} whp, but the factory rates ${hp} hp at the crank.\n\nOn BoneStock the wheels must read LESS than the factory figure — check the sheet (or the car isn't stock). Nothing was saved.`)
          return
        }
        const loss = Math.round((1 - scannedWhp / hp) * 100 * 2) / 2
        await savePull({
          pack: effPack,
          whp: String(scannedWhp),
          wnm: String(data.wnm ?? ''),
          loss: String(loss),
          dmonth: m ? m[2] : '',
          dday: m ? m[3] : '',
          dyear: m ? m[1] : '',
          dyno: data.dyno || 'GZ28US DynoJet',
        }, file)
        return
      }

      // Pack normal em carro COM BoneStock: a perda já é conhecida e travada, então não
      // sobra nada a conferir — o scan GRAVA direto, sem ADD PULL (ordem do usuário,
      // 17/ago/2026). O report continua sendo oferecido depois, como em toda puxada.
      if (carLoss != null && scannedWhp > 0) {
        await savePull({
          pack: effPack,
          whp: String(scannedWhp),
          wnm: String(data.wnm ?? ''),
          loss: String(carLoss),
          dmonth: m ? m[2] : '',
          dday: m ? m[3] : '',
          dyear: m ? m[1] : '',
          dyno: data.dyno || 'GZ28US DynoJet',
        }, file)
        return
      }

      // Carro ainda sem BoneStock (ou folha sem WHP legível): o scan pré-preenche e o
      // usuário confere, entra a perda se for o primeiro pull, e clica ADD — como sempre.
      setForm((f) => ({
        ...f,
        // O PACK é NOSSO: vem do nome do pack do build (ou do que ele digitou) e o scan
        // NUNCA sobrescreve. A folha do dinamômetro traz o rótulo que o operador digitou
        // lá na máquina — não é o nome do pacote contratado. Só preenche se estiver vazio.
        pack: f.pack.trim() || data.pack || '',
        whp: data.whp || f.whp,
        wnm: data.wnm || f.wnm,
        dmonth: m ? m[2] : f.dmonth,
        dday: m ? m[3] : f.dday,
        dyear: m ? m[1] : f.dyear,
        dyno: data.dyno || f.dyno,
      }))
      setScannedFile(file)
    } catch (err) {
      alert('Scan failed: ' + String(err))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => { load() }, [])

  // O PACK da puxada já nasce preenchido com o nome do pack do build (camada anterior) —
  // é sempre ele que se está puxando. Chega assíncrono do pai, e só preenche enquanto o
  // campo estiver vazio: o que ele digitar nunca é sobrescrito.
  useEffect(() => {
    if (packName) setForm(f => (f.pack.trim() ? f : { ...f, pack: packName }))
  }, [packName])

  async function load() {
    const [{ data }, { data: rideWide }] = await Promise.all([
      supabase
        .from('dyno_pulls')
        .select('*')
        .eq('ride_code', rideCode)
        .eq('build_no', buildNo)
        .order('pull_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
      // A BoneStock do CARRO mora em qualquer build — a query acima é só deste.
      supabase
        .from('dyno_pulls')
        .select('*')
        .eq('ride_code', rideCode)
        .order('created_at', { ascending: false }),
    ])
    const [liveData, liveWide] = await Promise.all([resolveLiveBaselines((data || []) as DynoPull[]), resolveLiveBaselines((rideWide || []) as DynoPull[])])
    const rows = liveData.map(toLocalDialect)
    // BoneStock baseline is always pinned as the first row.
    rows.sort((a, b) => (isBoneStock(b) ? 1 : 0) - (isBoneStock(a) ? 1 : 0))
    // A BoneStock do carro: define a perda E aparece em TODO pack (ordem do usuário,
    // 17/ago/2026). Preferindo a que tem perda gravada, se houver mais de uma.
    const bsAll = liveWide.filter(isBoneStock)
    const bsCar = bsAll.find((p) => p.loss_pct != null) ?? bsAll[0] ?? null
    setCarLoss(bsCar?.loss_pct != null ? Number(bsCar.loss_pct) : null)
    // O rótulo diz de QUAL baseline a perda veio — "from Stock" quando a base é a Stock.
    // De outro carro? O rótulo diz de qual: "US.042 - SublimeHell BoneStock" (ordem 21/ago/2026).
    setCarLossFrom(bsCar?.linked ? `${bsCar.linked}${bsCar.linkedName ? ` - ${bsCar.linkedName}` : ''} ${bsCar.pack || 'BoneStock'}` : (bsCar?.pack || 'BoneStock'))
    setCarHasBone(bsAll.length > 0)
    // Build sem BoneStock própria mostra a do carro EMPRESTADA, fixada no topo —
    // read-only (sem EDIT/REMOVE): a dona é o build de origem.
    if (bsCar && !rows.some(isBoneStock)) rows.unshift({ ...toLocalDialect(bsCar), borrowed: true })
    setPulls(rows)
    setLoading(false)
  }

  // CARROS IDÊNTICOS com BoneStock: mesmo brand/model/version (o version nomeia o motor —
  // "SRT Demon 170 6.2"), qualquer ano — o ano aparece na lista e quem escolhe é o usuário.
  // Só roda quando ESTE carro não tem baseline nenhuma; o resultado decide se o botão existe.
  useEffect(() => {
    if (!car || carHasBone) { setImportables([]); return }
    ;(async () => {
      const { data: twins } = await supabase
        .from('rides')
        .select('project_code, project_name, year')
        .eq('brand', car.brand || '')
        .eq('model', car.model || '')
        .eq('version', car.version || '')
        .neq('project_code', rideCode)
      const codes = (twins || []).map((t: any) => t.project_code).filter(Boolean)
      if (codes.length === 0) { setImportables([]); return }
      const { data: bones } = await supabase
        .from('dyno_pulls')
        .select('*')
        .in('ride_code', codes)
        .not('whp', 'is', null)
        .is('imported_from', null) // cópia importada NÃO se propaga — só ORIGINAIS
        .order('pull_date', { ascending: false, nullsFirst: false })
      const byCode = new Map((twins || []).map((t: any) => [t.project_code, t]))
      setImportables(((bones || []) as DynoPull[]).filter(isTrueBoneStock).map((row) => {
        const t: any = byCode.get(row.ride_code || '')
        return {
          row, // linha CRUA — a importação copia como está (dialeto BR incluso)
          label: `${row.ride_code || '—'}${t?.project_name ? ` — ${t.project_name}` : ''}${t?.year ? ` (${t.year})` : ''}`,
          whp: toLocalDialect(row).whp, // só pra EXIBIR comparável
        }
      }))
    })()
  }, [car, carHasBone]) // eslint-disable-line react-hooks/exhaustive-deps

  // Copia a BoneStock escolhida para ESTE carro (ride_code/build atuais), campos como
  // estão — perda, torque, fator de correção, dialeto e a folha (document_url) juntos.
  // Daí em diante a máquina toda já existente assume: perda do carro, linha emprestada
  // nos outros builds, meta do pack em WHP.
  async function importBoneStock(c: { row: DynoPull; label: string }) {
    setImporting(true)
    try {
      const s = c.row
      const { error } = await supabase.from('dyno_pulls').insert([{
        ride_code: rideCode,
        build_no: buildNo,
        origin: s.origin || 'US',
        pack: 'BoneStock',
        whp: s.whp, wnm: s.wnm,
        loss_pct: s.loss_pct,
        bhp: s.bhp, bnm: s.bnm,
        correction_factor: s.correction_factor ?? null,
        pull_date: s.pull_date,
        dyno: s.dyno,
        document_url: s.document_url,
        // PROVENIÊNCIA (lei 17/ago/2026): cópia importada carrega de quem veio — e cópia
        // NUNCA é oferecida a outros carros; só ORIGINAIS são compartilháveis.
        imported_from: s.ride_code || null,
      }])
      if (error) { alert(error.message); return }
      setShowImport(false)
      await load()
    } finally {
      setImporting(false)
    }
  }


  // BONESTOCK PREDICTION (ordem do usuário, 17/ago/2026): carro que ainda não passou no
  // dinamômetro não tem linha de base — e sem base não há perda, nem meta em roda, nem ganho.
  // Aqui o usuário informa a perda PREVISTA e o app deriva a baseline da potência de fábrica
  // (a mesma conta da createBoneStock). Fica marcada como PREVISÃO: vale como base DESTE carro,
  // mas nunca é oferecida a outro — previsão não é prova, só a folha escaneada é.
  async function addBoneStockPrediction() {
    if (!car) { alert('Car identity not loaded yet — try again in a second.'); return }
    const msg = 'LOSS PREDICTION (%) — the crank\u2192wheel loss you expect for this car.\n\nThe baseline is derived from the factory power rating at this loss and marked as a PREDICTION until a real dyno sheet is scanned.'
    const raw = prompt(msg, defaultLoss || '15')
    if (raw === null) return
    const loss = parseFloat(String(raw).replace(',', '.'))
    if (!Number.isFinite(loss) || loss <= 0 || loss >= 100) { alert('Enter a loss between 0 and 100 (e.g. 15).'); return }
    setPredicting(true)
    try {
      await createBoneStock(String(loss), BASELINE_PREDICTION)
      await load()
    } finally {
      setPredicting(false)
    }
  }

  // Auto-create the BoneStock baseline (factory crank specs → wheel via the entered loss).
  async function createBoneStock(lossStr: string, packLabel: string = 'BoneStock') {
    let hp: number | null = null, nm: number | null = null
    if (car) {
      try {
        const res = await fetch(`${BASE_PATH}/api/factory-specs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(car) })
        const data = await res.json().catch(() => ({}))
        if (Number.isFinite(Number(data.hp))) hp = Number(data.hp)
        if (Number.isFinite(Number(data.nm))) nm = Number(data.nm)
      } catch { /* leave null — still create the row so every table has a BoneStock */ }
    }
    const loss = lossStr === '' ? 15 : (parseFloat(lossStr) || 15)
    const lf = 1 - loss / 100
    // The factory baseline anchors on the CAR's home country: US.xxx cars are recorded in the
    // US dialect (factory hp / lb·ft as-is), BR.xxx cars in the BR one (SAE raw + correction).
    if (rideCode.startsWith('BR.')) {
      const CORR = 1.11 // default SAE correction factor for a BR baseline
      const kgfm = nm != null ? nm / 9.80665 : null
      await supabase.from('dyno_pulls').insert([{
        ride_code: rideCode,
        build_no: buildNo,
        origin: 'BR',
        pack: packLabel,
        whp: hp != null ? Math.round((hp * lf / CORR) * 100) / 100 : null,
        wnm: kgfm != null ? Math.round((kgfm * lf / CORR) * 100) / 100 : null,
        loss_pct: loss,
        correction_factor: CORR,
        bhp: hp, // factory crank hp (SAE)
        bnm: kgfm != null ? Math.round(kgfm * 100) / 100 : null, // factory crank torque (kgf·m)
        pull_date: null, dyno: null, document_url: null,
      }])
      return
    }
    const lbft = nm != null ? nm / 1.3558179 : null // factory-specs API reports N·m; US stores lb·ft
    const whp = hp != null ? Math.round(hp * lf * 100) / 100 : null
    const wnm = lbft != null ? Math.round(lbft * lf * 100) / 100 : null
    await supabase.from('dyno_pulls').insert([{
      ride_code: rideCode,
      build_no: buildNo,
      origin: 'US',
      pack: packLabel,
      whp, wnm,
      loss_pct: loss,
      bhp: hp, // factory crank hp
      bnm: lbft != null ? Math.round(lbft * 100) / 100 : null, // factory crank torque (lb·ft)
      pull_date: null, dyno: null, document_url: null,
    }])
  }

  // Edit the ride-constant loss: re-peg BoneStock to factory crank, re-derive crank for measured pulls.
  async function saveLoss() {
    const v = parseFloat(lossDraft)
    if (!Number.isFinite(v)) { alert('Enter a valid loss %.'); return }
    const lf = 1 - v / 100
    for (const p of pulls) {
      // BR-recorded rows hold raw BR figures in the bank — the in-memory values here are the
      // converted STD/lb·ft display. Only sync the shared loss %; never write converted numbers back.
      if (p.foreign) {
        await supabase.from('dyno_pulls').update({ loss_pct: v }).eq('id', p.id)
      } else if (isBoneStock(p)) {
        const whp = p.bhp != null ? Math.round(p.bhp * lf * 100) / 100 : p.whp
        const wnm = p.bnm != null ? Math.round(p.bnm * lf * 100) / 100 : p.wnm
        await supabase.from('dyno_pulls').update({ loss_pct: v, whp, wnm }).eq('id', p.id)
      } else {
        await supabase.from('dyno_pulls').update({ loss_pct: v, bhp: applyLoss(p.whp != null ? String(p.whp) : '', String(v)), bnm: applyLoss(p.wnm != null ? String(p.wnm) : '', String(v)) }).eq('id', p.id)
      }
    }
    setEditingLoss(false)
    load()
  }

  // Grava a puxada a partir de valores EXPLÍCITOS — não do estado do formulário. É o que
  // permite o SCAN do BoneStock gravar sozinho: logo depois de um setState os valores novos
  // ainda não estão em `form`, então quem escaneou passa o que leu direto para cá.
  type PullVals = { pack: string; whp: string; wnm: string; loss: string; dmonth: string; dday: string; dyear: string; dyno: string }
  async function savePull(vals: PullVals, file: File | null) {
    setSaving(true)
    try {
      let documentUrl: string | null = null
      if (file) {
        const ext = file.name.split('.').pop() || 'pdf'
        const path = `dyno/${rideId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage.from('dyno-charts').upload(path, file, { upsert: true })
        if (upErr) { alert('Document upload failed: ' + upErr.message); return }
        const { data: urlData } = supabase.storage.from('dyno-charts').getPublicUrl(path)
        documentUrl = urlData.publicUrl
      }
      const pullDate = vals.dyear && vals.dmonth && vals.dday ? `${vals.dyear}-${vals.dmonth}-${vals.dday}` : null
      // A perda é do CARRO: a BoneStock define (a dela é a deduzida da fábrica, sempre a
      // própria), todo outro pack CONSOME a perda da BoneStock quando ela existe. Sem
      // BoneStock ainda, vale o comportamento antigo: digitada no primeiro pull, reusada.
      const effLoss = isBoneStock({ pack: vals.pack.trim() })
        ? vals.loss
        : carLoss != null ? String(carLoss)
        : pulls.length === 0 ? vals.loss
        : (rideLoss != null ? String(rideLoss) : vals.loss)
      const { data: inserted, error } = await supabase.from('dyno_pulls').insert([{
        ride_code: rideCode,
        build_no: buildNo,
        origin: 'US',
        pack: vals.pack.trim() || null,
        whp: vals.whp ? parseFloat(vals.whp) : null,
        wnm: vals.wnm ? parseFloat(vals.wnm) : null,
        loss_pct: effLoss ? parseFloat(effLoss) : null,
        bhp: applyLoss(vals.whp, effLoss),
        bnm: applyLoss(vals.wnm, effLoss),
        pull_date: pullDate,
        dyno: vals.dyno || null,
        document_url: documentUrl,
      }]).select().single()
      if (error) { alert(error.message); return }

      // Every ride's table leads with a BoneStock baseline row — create it once, on the first
      // pull. Mas se a puxada que acabou de entrar JÁ É a BoneStock (escaneada), não se cria
      // outra por cima: seriam duas linhas de fábrica no mesmo build.
      if (!isBoneStock({ pack: vals.pack.trim() }) && !pulls.some(isBoneStock)) { await createBoneStock(effLoss) }

      // Volta com o PACK do build já preenchido: a próxima puxada é do mesmo pacote.
      setForm({ pack: packName || '', whp: '', wnm: '', loss: '', dmonth: '', dday: '', dyear: '', dyno: 'GZ28US DynoJet' })
      setScannedFile(null)
      load()
      // Ask whether to report it (instead of auto-sending).
      setReportToClient(false)
      setReportPull(inserted as DynoPull)
    } finally {
      setSaving(false)
    }
  }

  async function addPull() {
    if (!form.pack.trim() && !form.whp) { alert('Enter at least a PACK or a WHP figure.'); return }
    // BONESTOCK É SÓ POR SCAN (ordem do usuário, 17/ago/2026): "that's how it's a real proof
    // of veracity". A linha de fábrica é a base de TODOS os ganhos do carro — ela não pode
    // nascer de número digitado à mão, tem que vir da folha do dinamômetro. Esta trava é a
    // segunda barreira, para o caso de o pack virar BoneStock com o formulário já preenchido.
    if (bonestockPack && !scannedFile) {
      alert('BoneStock only goes in by SCAN — the dyno sheet is the proof.\n\nPress SCAN PULL and pick the sheet.')
      return
    }
    // Loss is set ONCE for the whole ride (on the first pull) — required so the pull and the
    // auto BoneStock share the exact same crank→wheel conversion. Com a perda da BoneStock
    // do carro já conhecida, não se pede nada: ela é usada direto.
    if (carLoss == null && pulls.length === 0 && !form.loss.trim()) { alert('Enter the crank→wheel LOSS % — it is set once for the whole ride.'); return }
    await savePull(form, scannedFile)
  }

  async function removePull(id: string) {
    if (!window.confirm('Remove this pull?')) return
    const { error } = await supabase.from('dyno_pulls').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setPulls(prev => prev.filter(p => p.id !== id))
  }

  function startEdit(p: DynoPull) {
    const m = (p.pull_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    setEditForm({
      pack: p.pack || '',
      whp: p.whp != null ? String(p.whp) : '',
      wnm: p.wnm != null ? String(p.wnm) : '',
      loss: p.loss_pct != null ? String(p.loss_pct) : '',
      dmonth: m ? m[2] : '', dday: m ? m[3] : '', dyear: m ? m[1] : '',
      dyno: p.dyno || 'GZ28US DynoJet',
    })
    setEditingId(p.id)
  }

  async function saveEdit(id: string) {
    const pullDate = editForm.dyear && editForm.dmonth && editForm.dday ? `${editForm.dyear}-${editForm.dmonth}-${editForm.dday}` : null
    const { error } = await supabase.from('dyno_pulls').update({
      pack: editForm.pack.trim() || null,
      whp: editForm.whp ? parseFloat(editForm.whp) : null,
      wnm: editForm.wnm ? parseFloat(editForm.wnm) : null,
      loss_pct: editForm.loss ? parseFloat(editForm.loss) : null,
      bhp: applyLoss(editForm.whp, editForm.loss),
      bnm: applyLoss(editForm.wnm, editForm.loss),
      pull_date: pullDate,
      dyno: editForm.dyno || null,
    }).eq('id', id)
    if (error) { alert(error.message); return }
    setEditingId(null)
    load()
  }

  // TARGET IN THE REPORTS (user order 21/aug/2026): the GZ28US group ALWAYS sees the
  // target and how much is still missing (or MET + the surplus); the CLIENT only hears
  // about the target once it is reached — then with the surplus.
  function targetLines(whpNow: number | null | undefined, audience: 'group' | 'client'): string[] {
    if (targetBhp == null || targetWhp == null || whpNow == null) return []
    const diff = whpNow - targetWhp
    if (audience === 'client') return diff >= 0 ? [`🎯 *TARGET REACHED:* ${targetBhp} BHP pack target — *+${diff.toFixed(1)} WHP over*`] : []
    return diff >= 0
      ? [`🎯 *TARGET MET:* ${targetWhp.toFixed(1)} WHP (${targetBhp} BHP @ ${lossInUse}% loss) — *+${diff.toFixed(1)} WHP over*`]
      : [`🎯 *TARGET:* ${targetWhp.toFixed(1)} WHP (${targetBhp} BHP @ ${lossInUse}% loss) — *${(-diff).toFixed(1)} WHP to go*`]
  }
  function pullReport(p: DynoPull, audience: 'group' | 'client' = 'group'): string {
    return [
      '🏁 *DYNO PULL*',
      rideTitle ? `*Ride:* ${rideTitle}` : null,
      p.pack ? `*Pack:* ${p.pack}` : null,
      p.whp != null ? `*WHP:* ${p.whp.toFixed(2)}` : null,
      p.wnm != null ? `*WTQ:* ${p.wnm.toFixed(2)} lb·ft` : null,
      p.loss_pct != null ? `*Loss:* ${p.loss_pct}%` : null,
      p.bhp != null ? `*BHP:* ${p.bhp.toFixed(2)}` : null,
      p.bnm != null ? `*BTQ:* ${p.bnm.toFixed(2)} lb·ft` : null,
      p.pull_date ? `*Date:* ${fmtDate(p.pull_date)}` : null,
      p.dyno ? `*Dyno:* ${p.dyno}` : null,
      ...(isBoneStock(p) ? [] : targetLines(p.whp, audience)),
    ].filter(Boolean).join('\n') + '\n\nSent by GZ28 Control App'
  }

  function docFilename(p: DynoPull) {
    return `dyno-chart.${(p.document_url || '').split('?')[0].split('.').pop() || 'pdf'}`
  }

  // Post the report to the WhatsApp reports group. Returns true on success.
  async function sendGroupReport(p: DynoPull): Promise<boolean> {
    const payload: { toGroupName: string; body: string; documentUrl?: string; filename?: string } = { toGroupName: REPORTS_GROUP, body: pullReport(p, 'group') }
    if (p.document_url) { payload.documentUrl = p.document_url; payload.filename = docFilename(p) }
    try {
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) { alert('WhatsApp report failed: ' + (data?.detail?.error ? JSON.stringify(data.detail.error) : (data.error || `HTTP ${res.status}`))); return false }
      return true
    } catch (e) { alert('WhatsApp report failed: ' + String(e)); return false }
  }

  // The "Report this pull?" dialog Send button.
  async function confirmReport() {
    if (!reportPull) return
    setReporting(true)
    try {
      await sendGroupReport(reportPull)
      if (reportToClient && client) await sendPull(reportPull)
    } finally {
      setReporting(false)
      setReportPull(null)
    }
  }

  async function sendPull(p: DynoPull) {
    if (!client) { alert('This ride has no client on file to send to. Assign a client on the ride page first.'); return }
    const method = client.preferred_message_method || 'WhatsApp'
    const report = pullReport(p, 'client')
    const plain = report.replace(/\*/g, '') + (p.document_url ? `\n\nChart: ${p.document_url}` : '')

    if (method === 'WhatsApp') {
      const to = toWaNumber(client.phone, client.country)
      if (!to) { alert('This client has no phone number for WhatsApp.\nAdd a phone on the client page, or change their preferred method to SMS / E-Mail.'); return }
      setSendingId(p.id)
      try {
        const payload: { to: string; body: string; documentUrl?: string; filename?: string } = { to, body: report }
        if (p.document_url) {
          payload.documentUrl = p.document_url
          payload.filename = `dyno-chart.${(p.document_url.split('?')[0].split('.').pop() || 'pdf')}`
        }
        const res = await fetch(`${BASE_PATH}/api/whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!data.ok) {
          const detailErr = data?.detail?.error
          alert('WhatsApp send failed:\n' + (typeof detailErr === 'object' ? JSON.stringify(detailErr) : String(detailErr || data?.error || `HTTP ${res.status}`)))
          return
        }
        alert(`Report sent to ${client.name || 'client'} via WhatsApp.`)
      } finally {
        setSendingId(null)
      }
      return
    }

    if (method === 'SMS') {
      window.location.href = `sms:${client.phone || ''}?&body=${encodeURIComponent(plain)}`
      return
    }

    if (method === 'E-Mail') {
      const subject = `Dyno Pull${rideTitle ? ` — ${rideTitle}` : ''}`
      window.location.href = `mailto:${client.email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
      return
    }

    // Instagram / Facebook: copy the text and open the client's DM to paste.
    // Any other method: plain copy for manual paste.
    await openSocialOrCopy(method, plain)
  }

  // Honor the client's preferred SOCIAL channel: copy the text, then open the
  // client's Instagram profile / Facebook page (or the DM inbox as fallback)
  // so the paste is one tap away. Unknown methods just copy.
  async function openSocialOrCopy(method: string, plain: string) {
    try { await navigator.clipboard.writeText(plain) } catch { /* clipboard may be blocked */ }
    if (method === 'Instagram') {
      const handle = (client?.instagram || '').replace(/^@/, '').trim()
      window.open(handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/direct/inbox/', '_blank')
      alert('Text copied. Open the client’s Instagram DM and paste to send.')
      return
    }
    if (method === 'Facebook') {
      const fb = (client?.facebook || '').trim()
      let url = 'https://www.facebook.com/messages/'
      if (fb) {
        if (/^https?:\/\//i.test(fb)) url = fb
        else if (fb.includes('facebook.com')) url = `https://${fb.replace(/^\/+/, '')}`
        else url = `https://www.facebook.com/${fb.replace(/^@/, '').trim()}`
      }
      window.open(url, '_blank')
      alert('Text copied. Open the client’s Facebook / Messenger and paste to send.')
      return
    }
    alert(`This client prefers ${method}, which can't be sent automatically.\nThe text was copied to your clipboard — paste it into ${method}.`)
  }

  // Title for the dyno sheet, built from the car + ride (auto).
  function sheetTitle(): string {
    const carName = [car?.year, car?.brand, car?.model, car?.version].filter(Boolean).join(' ')
    return [carName, rideTitle].filter((s) => s && String(s).trim()).join(' — ')
  }

  // Load the white-background GZ28 logo as a data URL (for embedding in the PDF). Null if it can't load.
  async function loadLogo(): Promise<{ data: string; w: number; h: number } | null> {
    try {
      const img = new window.Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = `${BASE_PATH}/logo_gz28.jpg` })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d'); if (!ctx) return null
      ctx.drawImage(img, 0, 0)
      return { data: canvas.toDataURL('image/jpeg', 0.92), w: img.naturalWidth, h: img.naturalHeight }
    } catch { return null }
  }

  // Build the styled dyno-data sheet (landscape A4) and return it as a PDF Blob.
  async function buildDynoPdf(): Promise<Blob> {
    const { jsPDF } = await import('jspdf')
    const autoTable = (await import('jspdf-autotable')).default
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    const logo = await loadLogo()
    if (logo) {
      // NEVER distort: scale by the single smaller fit factor so width:height stays exact.
      const maxW = 48, maxH = 17
      const s = Math.min(maxW / logo.w, maxH / logo.h)
      doc.addImage(logo.data, 'JPEG', 8, 5, logo.w * s, logo.h * s)
    } else { doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(20); doc.setTextColor(225, 29, 29); doc.text('GZ', 8, 17); const gx = 8 + doc.getTextWidth('GZ'); doc.setTextColor(23, 70, 200); doc.text('28', gx, 17) }

    doc.setFont('helvetica', 'italic'); doc.setFontSize(13); doc.setTextColor(20, 20, 20)
    doc.text(sheetTitle() || 'Dyno Data', pageW / 2, 12, { align: 'center', maxWidth: pageW - 120 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120)
    doc.text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), pageW / 2, 17.5, { align: 'center' })
    // Encoding-safe label: jsPDF's standard fonts carry no Unicode arrow glyph (→ renders as garbage).
    // Sits just above the table's top-right corner (table starts at y=22), right-aligned to its edge.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20, 20, 20)
    doc.text(`Crank-to-Wheel LOSS:  ${rideLoss != null ? Number(rideLoss) : '—'}%`, pageW - 8, 20, { align: 'right' })

    const REDFILL: [number, number, number] = [255, 0, 0], BLUEFILL: [number, number, number] = [36, 51, 194]
    const lighten = (c: [number, number, number]): [number, number, number] => [Math.round(c[0] + (255 - c[0]) * 0.55), Math.round(c[1] + (255 - c[1]) * 0.55), Math.round(c[2] + (255 - c[2]) * 0.55)]
    const f2 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toFixed(2))
    // WHP/WTQ are the WHEEL columns (red); BHP/BTQ are the ENGINE/crank columns (blue). Torque in lb·ft.
    const cols: Array<{ f: (p: DynoPull) => string; fill: [number, number, number] }> = [
      { f: (p) => f2(p.whp), fill: REDFILL },
      { f: (p) => f2(p.wnm), fill: REDFILL },
      { f: (p) => f2(p.bhp), fill: BLUEFILL },
      { f: (p) => f2(p.bnm), fill: BLUEFILL },
    ]
    const bs = pulls.find(isBoneStock)
    const others = pulls.filter((p) => !isBoneStock(p)).slice().reverse() // oldest -> newest
    const ordered = [...(bs ? [bs] : []), ...others]
    type Cell = { content: string; styles: Record<string, unknown> }
    const WHITE: [number, number, number] = [255, 255, 255]
    const body: Cell[][] = ordered.map((p) => {
      const stock = isBoneStock(p)
      const nameCell: Cell = { content: stock ? 'BoneStock' : (p.pack || '—'), styles: { halign: 'center', fontStyle: 'bold', textColor: (stock ? lighten([40, 40, 40]) : [40, 40, 40]), fillColor: WHITE } }
      const cells: Cell[] = cols.map((col) => ({ content: col.f(p), styles: { textColor: WHITE, fontStyle: 'bold', fillColor: col.fill } }))
      return [nameCell, ...cells]
    })
    // Only real pulls are rendered — no empty placeholder rows (they read as unfinished).

    // Gains: latest pull minus BoneStock (whole row black).
    let foot: Array<{ content: string; styles: Record<string, unknown> }> | null = null
    if (bs && others.length) {
      const a = others[others.length - 1], b = bs
      const n = (v: number | null | undefined) => v ?? 0
      const gv = [f2(n(a.whp) - n(b.whp)), f2(n(a.wnm) - n(b.wnm)), f2(n(a.bhp) - n(b.bhp)), f2(n(a.bnm) - n(b.bnm))]
      foot = [{ content: 'GAINS', styles: { halign: 'center', fontStyle: 'bold', textColor: [255, 255, 255], fillColor: [0, 0, 0] } }, ...gv.map((t) => ({ content: t, styles: { fillColor: [0, 0, 0], textColor: [46, 204, 113], fontStyle: 'bold' } }))]
    }

    const noBorder = { fillColor: WHITE, lineWidth: 0 }
    const head = [
      [
        { content: '', styles: { ...noBorder } },
        { content: 'WHEELS', colSpan: 2, styles: { fillColor: [255, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 } },
        { content: 'ENGINE (Crank)', colSpan: 2, styles: { fillColor: [36, 51, 194], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 } },
      ],
      [
        { content: '', styles: { ...noBorder } },
        'WHP', 'WTQ (lb·ft)', 'BHP', 'BTQ (lb·ft)',
      ],
    ]

    autoTable(doc, {
      startY: 22,
      head: head as never,
      body: body as never,
      foot: (foot ? [foot] : undefined) as never,
      theme: 'grid',
      styles: { fontSize: 9, halign: 'center', valign: 'middle', cellPadding: 2.6, lineColor: [150, 150, 150], lineWidth: 0.2, textColor: [40, 40, 40] },
      headStyles: { fillColor: [224, 224, 224], textColor: [55, 55, 55], fontStyle: 'bold', fontSize: 9, halign: 'center', lineColor: [120, 120, 120], lineWidth: 0.2 },
      footStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold', lineColor: [120, 120, 120], lineWidth: 0.2 },
      columnStyles: { 0: { cellWidth: 60 } },
      margin: { left: 8, right: 8 },
    })

    return doc.output('blob')
  }

  // SEND DYNO DATA dialog confirm: build the PDF, upload it, WhatsApp it to the group (+ client).
  async function confirmSendDynoData() {
    setDynoSending(true)
    try {
      const blob = await buildDynoPdf()
      const rideLabel = (rideTitle || sheetTitle() || 'DynoData RECEIPT').replace(/\s*—\s*/g, ' ').trim()
      const fileLabel = `GZ28 V8 SpeedShop DynoData RECEIPT - ${rideLabel}`
      const filename = `${fileLabel}.pdf`
      const slug = (fileLabel.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)) || 'dyno-data'
      const path = `reports/${rideId}/${slug}-${Date.now()}.pdf`
      const { error: upErr } = await supabase.storage.from('dyno-charts').upload(path, blob, { upsert: true, contentType: 'application/pdf' })
      if (upErr) { alert('PDF upload failed: ' + upErr.message); return }
      const { data: urlData } = supabase.storage.from('dyno-charts').getPublicUrl(path)
      const url = urlData.publicUrl
      // Also save the DynoData PDF into the ride's Dropbox PERFORMANCE folder
      // (best-effort — the WhatsApp send still goes out if this fails).
      try {
        const b64: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result).split(',')[1] || '')
          r.onerror = reject
          r.readAsDataURL(blob)
        })
        await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', zone: 'US', code: rideCode, filename, subfolder: 'Performance', contentBase64: b64 }) })
      } catch { /* non-fatal */ }
      // Receipt lines: BoneStock corrected → latest pull corrected (pulls are sorted newest first).
      const bs = pulls.find(isBoneStock)
      const latest = pulls.filter((p) => !isBoneStock(p))[0]
      const f2 = (x: number | null) => (x == null ? '—' : x.toFixed(2))
      const gain = (a: number | null, b: number | null) => (a != null && b != null ? (a - b).toFixed(2) : '—')
      const captionBase = [
        '🏁 *GZ28US · DynoData RECEIPT:*',
        sheetTitle() ? `*${sheetTitle()}*` : null,
        bs && latest ? `WHP: FROM ${f2(bs.whp)} TO *${f2(latest.whp)}* - GAIN: *${gain(latest.whp, bs.whp)}*` : null,
        bs && latest ? `BHP: FROM ${f2(bs.bhp)} TO *${f2(latest.bhp)}* - GAIN: *${gain(latest.bhp, bs.bhp)}*` : null,
        bs && latest ? `BTQ (lb·ft): FROM ${f2(bs.bnm)} TO *${f2(latest.bnm)}* - GAIN: *${gain(latest.bnm, bs.bnm)}*` : null,
      ].filter(Boolean) as string[]
      const footer = '\n\nSent by GZ28 Control App'
      // Group: target + to-go always. Client: target only once it is reached.
      const caption = [...captionBase, ...targetLines(latest?.whp ?? null, 'group')].join('\n') + footer
      const captionClient = [...captionBase, ...targetLines(latest?.whp ?? null, 'client')].join('\n') + footer

      const group = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toGroupName: REPORTS_GROUP, body: caption, documentUrl: url, filename }) })
      const gd = await group.json().catch(() => ({}))
      if (!gd.ok) { alert('WhatsApp send failed: ' + (gd?.detail?.error ? JSON.stringify(gd.detail.error) : (gd.error || `HTTP ${group.status}`))); return }

      if (dynoSendToClient && client) {
        // Honor the client's preferred channel (SMS-only clients aren't on WhatsApp).
        // SMS / E-Mail / manual channels can't attach the PDF, so they carry its public link.
        const method = client.preferred_message_method || 'WhatsApp'
        const plain = captionClient.replace(/\*/g, '') + `\n\nReceipt: ${url}`
        if (method === 'WhatsApp') {
          const to = toWaNumber(client.phone, client.country)
          if (!to) { alert('Sent to the group. The client has no WhatsApp number on file, so the receipt was not sent to them.') }
          else {
            const cli = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: captionClient, documentUrl: url, filename }) })
            const cd = await cli.json().catch(() => ({}))
            if (!cd.ok) { alert('Sent to the group, but the client WhatsApp send failed: ' + (cd?.detail?.error ? JSON.stringify(cd.detail.error) : (cd.error || `HTTP ${cli.status}`))); return }
          }
        } else if (method === 'SMS') {
          if (!client.phone) { alert('Sent to the group. The client has no phone number on file for SMS.') }
          else { window.location.href = `sms:${client.phone}?&body=${encodeURIComponent(plain)}` }
        } else if (method === 'E-Mail') {
          const subject = `GZ28US DynoData RECEIPT${sheetTitle() ? ` — ${sheetTitle()}` : ''}`
          window.location.href = `mailto:${client.email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}`
        } else {
          // Instagram / Facebook open the client's DM with the text copied;
          // anything else copies for manual paste.
          await openSocialOrCopy(method, plain)
        }
      }
    } catch (e) {
      alert('Could not generate/send the dyno data: ' + String(e))
    } finally {
      setDynoSending(false)
      setDynoSendOpen(false)
    }
  }

  const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 text-lg'
  const editInput = 'bg-gray-800 border border-gray-700 rounded-xl px-2 py-1 text-base'

  // Final GAINS row: latest pull minus the BoneStock baseline.
  function gainsRow() {
    const bs = pulls.find(isBoneStock)
    const last = pulls.find((p) => !isBoneStock(p))
    if (!bs || !last) return null
    const n = (v: number | null | undefined) => v ?? 0
    const cell = (v: number) => (
      <td className={`py-3 pr-4 font-bold ${v >= 0 ? 'text-green-400' : 'text-red-400'}`}>{(v >= 0 ? '+' : '') + v.toFixed(2)}</td>
    )
    return (
      <tr className="border-t-2 border-gray-600 bg-green-900/10">
        <td className="py-3 pr-4 font-bold text-green-300">GAINS</td>
        {cell(n(last.whp) - n(bs.whp))}
        {cell(n(last.wnm) - n(bs.wnm))}
        {cell(n(last.bhp) - n(bs.bhp))}
        {cell(n(last.bnm) - n(bs.bnm))}
        <td className="py-3 pr-4"></td>
        <td className="py-3 pr-4"></td>
        <td className="py-3 pr-4"></td>
        <td className="py-3"></td>
      </tr>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      {/* REPORT THIS PULL TO WHATSAPP? */}
      {/* IMPORT BoneStock — as BoneStock dos carros idênticos; o usuário escolhe qual
          vira a referência DESTE carro. Colunas pedidas: Car, WHP, Dyno, Date. */}
      {showImport && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-2xl max-h-[85vh] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-amber-400">IMPORT BoneStock</h2>
              <button onClick={() => setShowImport(false)} className="text-gray-400 hover:text-white text-xl font-bold">✕</button>
            </div>
            <p className="text-gray-400 text-base">Identical cars in the system with a BoneStock pull — pick the one to use as THIS car&apos;s factory baseline.</p>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-400 text-sm border-b border-gray-700">
                    <th className="py-2 pr-4 font-bold">CAR</th>
                    <th className="py-2 pr-4 font-bold">WHP</th>
                    <th className="py-2 pr-4 font-bold">LOSS</th>
                    <th className="py-2 pr-4 font-bold">DYNO</th>
                    <th className="py-2 pr-4 font-bold">DATE</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {importables.map((c) => (
                    <tr key={c.row.id} className="border-b border-gray-800">
                      <td className="py-3 pr-4 font-bold">{c.label}</td>
                      <td className="py-3 pr-4">{c.whp != null ? c.whp.toFixed(2) : '—'}</td>
                      <td className="py-3 pr-4">{c.row.loss_pct != null ? `${c.row.loss_pct}%` : '—'}</td>
                      <td className="py-3 pr-4">{c.row.dyno || '—'}</td>
                      <td className="py-3 pr-4 text-gray-400">{fmtDate(c.row.pull_date)}</td>
                      <td className="py-3 text-right">
                        <button onClick={() => importBoneStock(c)} disabled={importing} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded-2xl font-bold text-sm">{importing ? 'IMPORTING…' : 'USE'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {reportPull && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
            <h2 className="text-2xl font-bold">REPORT THIS PULL TO WHATSAPP?</h2>
            <label className="flex items-center gap-3 text-lg cursor-pointer">
              <input type="checkbox" checked={reportToClient} onChange={(e) => setReportToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              Send to the client too?
            </label>
            {reportToClient && !client && <p className="text-sm text-yellow-400">This ride has no client on file — only the group report will be sent.</p>}
            <div className="flex gap-3 pt-1">
              <button onClick={() => setReportPull(null)} disabled={reporting} className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">SKIP</button>
              <button onClick={confirmReport} disabled={reporting} className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{reporting ? 'SENDING…' : 'SEND'}</button>
            </div>
          </div>
        </div>
      )}

      {/* PACK TARGET — the build's pack name states the goal in crank bhp; the dyno reads
          wheel, so the goal is converted at the loss this car is actually running. */}
      {targetBhp != null && (
        <div className={`rounded-3xl border p-5 mb-6 ${gapWhp != null && gapWhp <= 0 ? 'bg-green-950/40 border-green-700' : 'bg-fuchsia-950/30 border-fuchsia-800'}`}>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs font-bold text-fuchsia-300 tracking-wide">🎯 PACK TARGET · {packName}</p>
              <p className="text-3xl font-bold mt-1">
                {targetWhp != null ? `${targetWhp.toFixed(1)} WHP` : '—'}
                <span className="text-base font-normal text-gray-400 ml-3">
                  = {targetBhp} BHP{Number.isFinite(lossInUse) ? ` @ ${lossInUse}% loss` : ''}
                </span>
              </p>
            </div>
            <div className="text-right">
              {targetWhp == null ? (
                <p className="text-amber-300 font-bold">Enter a LOSS % to see the WHP target</p>
              ) : gapWhp != null && gapWhp > 0 ? (
                <>
                  <p className="text-2xl font-bold text-amber-300">+{gapWhp.toFixed(1)} WHP to go</p>
                  <p className="text-sm text-gray-400">
                    {bestWhp > 0
                      ? `best so far ${bestWhp.toFixed(1)} WHP · ${((gapWhp / bestWhp) * 100).toFixed(1)}% more`
                      : baseWhp > 0
                        ? `no pulls yet — measured from the baseline, ${baseWhp.toFixed(1)} WHP`
                        : '— no pulls yet'}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-green-400">✅ TARGET MET</p>
                  <p className="text-sm text-gray-400">best {bestWhp.toFixed(1)} WHP · {Math.abs(gapWhp || 0).toFixed(1)} WHP over</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add a pull */}
      <div className="flex flex-wrap gap-3 items-start mb-6">
        <div className="flex-1 min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">PACK</label>
          <input value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} className={inputClass} placeholder="e.g. Stage 2" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">WHP</label>
          <input value={form.whp} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, whp: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        <div className="w-28">
          <label className="block mb-1 text-sm text-gray-400 font-bold">WTQ (lb·ft)</label>
          <input value={form.wnm} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, wnm: e.target.value }) }} className={inputClass} placeholder="0" />
        </div>
        {/* Com a BoneStock do carro no banco, a perda já é conhecida — o campo some. */}
        {pulls.length === 0 && carLoss == null && (
          <div className="w-28">
            <label className="block mb-1 text-sm text-gray-400 font-bold">LOSS (%)</label>
            <input value={form.loss} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setForm({ ...form, loss: e.target.value }) }} className={inputClass} placeholder="0" />
          </div>
        )}
        <div className="min-w-[300px] flex-1">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DATE</label>
          <div className="flex gap-2">
            <select value={form.dmonth} onChange={(e) => setForm({ ...form, dmonth: e.target.value })} className={inputClass}>
              <option value="">Month</option>
              {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={form.dday} onChange={(e) => setForm({ ...form, dday: e.target.value })} className={inputClass}>
              <option value="">Day</option>
              {DAYS.map((d) => <option key={d} value={d}>{parseInt(d, 10)}</option>)}
            </select>
            <select value={form.dyear} onChange={(e) => setForm({ ...form, dyear: e.target.value })} className={inputClass}>
              <option value="">Year</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>
        <div className="min-w-[160px]">
          <label className="block mb-1 text-sm text-gray-400 font-bold">DYNO</label>
          <select value={form.dyno} onChange={(e) => setForm({ ...form, dyno: e.target.value })} className={inputClass}>
            {DYNO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        {/* BoneStock é 100% pelo SCAN (lê a folha, deduz a perda e grava sozinho) — o botão
            de inserir à mão não existe nesse caso. Packs normais seguem com o ADD normal. */}
        {!bonestockPack && (
          <div>
            <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">ADD</label>
            <button onClick={addPull} disabled={saving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{saving ? 'SAVING…' : '+ ADD PULL'}</button>
          </div>
        )}
        <div>
          <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">SCAN</label>
          <button onClick={() => scanInputRef.current?.click()} disabled={scanning} className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{scanning ? 'SCANNING…' : 'SCAN PULL'}</button>
          <input ref={scanInputRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={handleScanFile} />
        </div>
        {/* Carro sem baseline, mas com CARRO IDÊNTICO já medido no sistema: dá pra importar
            a BoneStock dele como referência em vez de rodar o dinamômetro de novo. */}
        {!carHasBone && importables.length > 0 && (
          <div>
            <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">IMPORT</label>
            <button onClick={() => setShowImport(true)} className="bg-amber-600 hover:bg-amber-500 text-black px-5 py-3 rounded-2xl font-bold text-lg">IMPORT BoneStock</button>
          </div>
        )}
        {/* Carro que nunca passou no dinamômetro: sem baseline não há perda, nem meta em
            roda, nem ganho. A PREVISÃO destrava tudo isso a partir da potência de fábrica. */}
        {!carHasBone && (
          <div>
            <label className="block mb-1 text-sm font-bold invisible" aria-hidden="true">PREDICT</label>
            <button onClick={addBoneStockPrediction} disabled={predicting} className="bg-fuchsia-700 hover:bg-fuchsia-600 disabled:opacity-50 px-5 py-3 rounded-2xl font-bold text-lg">{predicting ? 'PREDICTING…' : 'BoneStock Prediction'}</button>
          </div>
        )}
      </div>

      {/* Diz POR QUE não há botão de inserir — senão parece bug. */}
      {bonestockPack && (
        <p className="text-sm text-amber-300 font-bold -mt-3 mb-6">
          🔒 The baseline (BoneStock/Stock) is SCAN ONLY — the dyno sheet is the proof of veracity. SCAN PULL reads
          the sheet, deduces the loss from the factory rating and saves the pull by itself.
        </p>
      )}

      {scannedFile && (
        <p className="text-sm text-purple-300 mb-4">📎 Chart attached: <span className="font-bold">{scannedFile.name}</span> — saved with this pull on ADD.
          <button onClick={() => setScannedFile(null)} className="ml-2 text-gray-400 hover:text-gray-200 underline">remove</button>
        </p>
      )}

      {/* Loss is a per-ride constant — shown here once, never as a per-pull column.
          Vinda da BoneStock do carro, ela é FATO deduzido da potência de fábrica, não
          escolha: mostra em roxo, travada, sem botão de editar. */}
      <div className="flex items-center gap-3 mb-4 text-lg">
        <span className="text-gray-400 font-bold">Crank → wheel loss:</span>
        {carLoss != null ? (
          <span className={`font-bold ${isPredictedBaseline(carLossFrom) ? 'text-fuchsia-300' : 'text-purple-300'}`}>{carLoss}% <span className={`font-normal text-sm ${isPredictedBaseline(carLossFrom) ? 'text-fuchsia-400' : 'text-purple-400'}`}>{isPredictedBaseline(carLossFrom) ? '📐 predicted — scan a sheet to make it real' : `🔒 from ${carLossFrom}`}</span></span>
        ) : editingLoss ? (
          <>
            <input value={lossDraft} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setLossDraft(e.target.value) }} className="w-20 bg-gray-800 border border-gray-700 rounded-xl px-3 py-1" placeholder="%" />
            <button onClick={saveLoss} className="bg-green-700 hover:bg-green-600 px-4 py-1 rounded-xl font-bold text-sm">SAVE</button>
            <button onClick={() => setEditingLoss(false)} className="bg-gray-600 hover:bg-gray-500 px-4 py-1 rounded-xl font-bold text-sm">CANCEL</button>
          </>
        ) : (
          <>
            <span className="font-bold text-white">{rideLoss != null ? `${rideLoss}%` : '— (set on the first pull)'}</span>
            {rideLoss != null && <button onClick={() => { setLossDraft(String(rideLoss)); setEditingLoss(true) }} className="bg-blue-700 hover:bg-blue-600 px-4 py-1 rounded-xl font-bold text-sm">EDIT</button>}
          </>
        )}
      </div>

      {/* Pulls table */}
      {loading ? (
        <p className="text-lg text-gray-400">Loading...</p>
      ) : pulls.length === 0 ? (
        <p className="text-lg text-gray-400">No pulls recorded yet.</p>
      ) : (
        <>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-gray-400 text-sm border-b border-gray-700">
                <th className="py-2 pr-4 font-bold">PACK</th>
                <th className="py-2 pr-4 font-bold">WHP</th>
                <th className="py-2 pr-4 font-bold">WTQ (lb·ft)</th>
                <th className="py-2 pr-4 font-bold">BHP</th>
                <th className="py-2 pr-4 font-bold">BTQ (lb·ft)</th>
                <th className="py-2 pr-4 font-bold">DATE</th>
                <th className="py-2 pr-4 font-bold">DYNO</th>
                <th className="py-2 pr-4 font-bold">DOC</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {orderedPulls.map((p) => editingId === p.id ? (
                <tr key={p.id} className="border-b border-gray-800 bg-gray-950/40">
                  <td className="py-2 pr-2"><input value={editForm.pack} onChange={(e) => setEditForm({ ...editForm, pack: e.target.value })} className={`${editInput} w-full`} placeholder="PACK" /></td>
                  <td className="py-2 pr-2"><input value={editForm.whp} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setEditForm({ ...editForm, whp: e.target.value }) }} className={`${editInput} w-20`} placeholder="0" /></td>
                  <td className="py-2 pr-2"><input value={editForm.wnm} inputMode="decimal" onChange={(e) => { if (isNumeric(e.target.value)) setEditForm({ ...editForm, wnm: e.target.value }) }} className={`${editInput} w-20`} placeholder="0" /></td>
                  <td className="py-2 pr-2 text-gray-400">{editBhp != null ? editBhp.toFixed(2) : '—'}</td>
                  <td className="py-2 pr-2 text-gray-400">{editBnm != null ? editBnm.toFixed(2) : '—'}</td>
                  <td className="py-2 pr-2">
                    <div className="flex gap-1">
                      <select value={editForm.dmonth} onChange={(e) => setEditForm({ ...editForm, dmonth: e.target.value })} className={editInput}>
                        <option value="">Mon</option>
                        {MONTHS.map(([v, l]) => <option key={v} value={v}>{l.slice(0, 3)}</option>)}
                      </select>
                      <select value={editForm.dday} onChange={(e) => setEditForm({ ...editForm, dday: e.target.value })} className={editInput}>
                        <option value="">Day</option>
                        {DAYS.map((d) => <option key={d} value={d}>{parseInt(d, 10)}</option>)}
                      </select>
                      <select value={editForm.dyear} onChange={(e) => setEditForm({ ...editForm, dyear: e.target.value })} className={editInput}>
                        <option value="">Year</option>
                        {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <select value={editForm.dyno} onChange={(e) => setEditForm({ ...editForm, dyno: e.target.value })} className={editInput}>
                      {DYNO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="py-2 pr-2">{p.document_url ? <a href={p.document_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a> : '—'}</td>
                  <td className="py-2 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => saveEdit(p.id)} className="bg-green-700 hover:bg-green-600 px-3 py-1 rounded-xl font-bold text-sm">SAVE</button>
                      <button onClick={() => setEditingId(null)} className="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded-xl font-bold text-sm">CANCEL</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={p.id} className={`border-b border-gray-800 ${isBoneStock(p) ? 'bg-gray-800/40' : ''}`}>
                  <td className={`py-3 pr-4 font-bold ${isBoneStock(p) ? (p.borrowed ? 'text-purple-300' : 'text-amber-300') : ''}`}>{p.pack || '—'}{p.borrowed ? <span className="ml-2 text-xs font-normal text-purple-400" title="A BoneStock do carro, gravada em outro build — só leitura aqui">🔒</span> : null}{p.linked ? <span className="ml-2 text-xs font-normal text-cyan-300" title={`BoneStock LIVE from ${p.linked}${p.linkedName ? ` - ${p.linkedName}` : ''} — read at the origin car; change it there`}>🔗 {p.linked}{p.linkedName ? ` - ${p.linkedName}` : ''}</span> : null}{isPredictedBaseline(p.pack) ? <span className="ml-2 text-xs font-normal text-fuchsia-300" title="PREVISÃO: derivada da potência de fábrica com a perda estimada — não é folha medida">📐 predicted</span> : null}{p.foreign ? <span className="ml-2 text-xs font-normal text-green-400" title="Recorded in the BR app — converted to STD / lb·ft">🇧🇷 BR</span> : null}</td>
                  <td className="py-3 pr-4">{p.whp != null ? `${p.whp.toFixed(2)} whp` : '—'}</td>
                  <td className="py-3 pr-4">{p.wnm != null ? `${p.wnm.toFixed(2)} lb·ft` : '—'}</td>
                  <td className="py-3 pr-4">{p.bhp != null ? `${p.bhp.toFixed(2)} bhp` : '—'}</td>
                  <td className="py-3 pr-4">{p.bnm != null ? `${p.bnm.toFixed(2)} lb·ft` : '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{fmtDate(p.pull_date)}</td>
                  <td className="py-3 pr-4">{p.dyno || '—'}</td>
                  <td className="py-3 pr-4">{p.document_url ? <a href={p.document_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-bold">VIEW</a> : '—'}</td>
                  <td className="py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      {/* Linha EMPRESTADA (a BoneStock do carro, de outro build): só leitura
                          aqui — edição/remoção acontecem no build de origem. */}
                      {!p.foreign && !p.borrowed && !p.linked && <button onClick={() => startEdit(p)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>}
                      {/* BoneStock is removable even when foreign (shared table) — Márcio 03/ago. */}
                      {(!p.foreign || isBoneStock(p)) && !p.borrowed && <button onClick={() => removePull(p.id)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>}
                      <button onClick={() => { setReportToClient(false); setReportPull(p) }} disabled={sendingId === p.id} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-3 py-1 rounded-xl font-bold text-sm">{sendingId === p.id ? 'SENDING…' : 'SEND'}</button>
                    </div>
                  </td>
                </tr>
              ))}
              {gainsRow()}
            </tbody>
          </table>
        </div>
        <div className="flex justify-center mt-6">
          <button onClick={() => { setDynoSendToClient(false); setDynoSendOpen(true) }} className="bg-green-700 hover:bg-green-600 px-6 py-3 rounded-2xl font-bold text-lg">SEND DYNO DATA</button>
        </div>
        </>
      )}

      {/* SEND DYNO DATA TO WHATSAPP? */}
      {dynoSendOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-6 w-full max-w-md flex flex-col gap-5">
            <h2 className="text-2xl font-bold">SEND DYNO DATA TO WHATSAPP?</h2>
            <p className="text-sm text-gray-400">Generates the full dyno sheet (BoneStock + every pull + gains) as a PDF and sends it to the reports group.</p>
            <label className="flex items-center gap-3 text-lg cursor-pointer">
              <input type="checkbox" checked={dynoSendToClient} onChange={(e) => setDynoSendToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              Send to the client too?
            </label>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDynoSendOpen(false)} disabled={dynoSending} className="bg-gray-600 hover:bg-gray-500 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">SKIP</button>
              <button onClick={confirmSendDynoData} disabled={dynoSending} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold">{dynoSending ? 'SENDING…' : 'SEND'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── BUILD SHEET ──────────────────────────────────────────────────────────────
// The car's full mechanical spec. Every open field is [Stock/Other]: choosing
// Other reveals a text input. Enum fields carry their own options. Fields
// show/hide by Power Source (Roots: Snout instead of Intake Manifold; blower
// fields only on SuperCharged sources). Saved one row per ride (upsert).
// TURBO BORN x TURBO FITTED (Márcio, 31/ago/2026): o carro que já nasceu turbo
// e o que foi turbinado depois são fichas diferentes de montagem — no FITTED o
// coletor de admissão original some do carro, então a ficha não pergunta por ele.
const POWER_SOURCES = ['Naturally Aspirated', 'Roots SuperCharged', 'Centrifugal SuperCharger', 'Turbo Born', 'Turbo Fitted']
const BS_FUEL_OPTIONS = ['93', 'E85', '91']

// 'so' = Stock/Other com texto livre · 'enum' = lista fechada · 'text' = campo aberto,
// pro que a ficha não pergunta (NOTES). 'text' não tem valor de fábrica: em branco é
// em branco, e não conta como modificação em lugar nenhum.
type BSField = { key: string; label: string; kind: 'so' | 'enum' | 'text'; options?: string[]; show?: (ps: string) => boolean }
const BS_FIELDS: BSField[] = [
  { key: 'intake', label: 'Intake', kind: 'so', show: (ps) => ps !== 'Turbo Fitted' },
  { key: 'throttle_body', label: 'Throttle-Body', kind: 'so' },
  { key: 'intake_manifold', label: 'Intake Manifold', kind: 'so', show: (ps) => ps !== 'Roots SuperCharged' },
  { key: 'snout', label: 'Snout', kind: 'so', show: (ps) => ps === 'Roots SuperCharged' },
  { key: 'supercharger', label: 'SuperCharger', kind: 'so', show: (ps) => ps === 'Roots SuperCharged' || ps === 'Centrifugal SuperCharger' },
  { key: 'pulley_size', label: 'Upper Pulley Size', kind: 'so', show: (ps) => ps === 'Roots SuperCharged' || ps === 'Centrifugal SuperCharger' },
  { key: 'lower_pulley_size', label: 'Lower Pulley Size', kind: 'so', show: (ps) => ps === 'Roots SuperCharged' || ps === 'Centrifugal SuperCharger' },
  { key: 'fuel_rails', label: 'FuelRails', kind: 'so' },
  // Os Injector Dynamics que a casa usa viram opção; o resto (FIC, OEM D170,
  // XDI…) continua entrando por Other, no texto livre.
  { key: 'injectors', label: 'Injectors', kind: 'so', options: ['ID1050XDS', 'ID1300XDS', 'ID1750XDS', 'ID2600XDS'] },
  { key: 'spark_plugs', label: 'SparkPlugs + Gaps', kind: 'so' },
  { key: 'map_sensor', label: 'MAP Sensor', kind: 'so' },
  { key: 'heads', label: 'Heads', kind: 'so' },
  { key: 'cam', label: 'Cam', kind: 'so' },
  { key: 'vvt', label: 'VVT', kind: 'so' },
  { key: 'displacement', label: 'Displacement', kind: 'so' },
  { key: 'compression_ratio', label: 'Compression Ratio', kind: 'so' },
  { key: 'headers', label: 'Headers', kind: 'so' },
  { key: 'cats', label: 'Cats', kind: 'enum', options: ['Stock', 'HighFlow', 'CatDelete'] },
  { key: 'catback', label: 'CatBack', kind: 'so' },
  { key: 'fuel_pump', label: 'FuelPump', kind: 'so' },
  { key: 'bap', label: 'BAP', kind: 'enum', options: ['NO', 'YES'] },
  { key: 'fuel_line', label: 'FuelLine', kind: 'so' },
  { key: 'fuel_press_regulator', label: 'FuelPress Regulator', kind: 'enum', options: ['Stock', 'External'] },
  { key: 'flex_sensor', label: 'FlexSensor', kind: 'enum', options: ['Stock', 'ECU Wired', 'Gauge Wired', 'NO'] },
  { key: 'fuel', label: 'Fuel', kind: 'enum', options: BS_FUEL_OPTIONS },
  { key: 'transmission', label: 'Transmission', kind: 'so' },
  // Último campo (pedido 17/ago/2026): Stock/Other + texto livre quando Other.
  { key: 'traction_tires', label: 'Traction Tires Size', kind: 'so' },
  // Últimos campos (pedido 06/set/2026): a atualização de OS do módulo, e um espaço
  // aberto pro que a ficha não tem coluna.
  { key: 'os_update', label: 'OS Update', kind: 'so' },
  { key: 'notes', label: 'Notes', kind: 'text' },
]

// GZ28 logo as a JPEG data-URI for the PDF header (canvas round-trip keeps jsPDF happy).
async function loadPdfLogo(): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = `${BASE_PATH}/logo_gz28.jpg` })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d'); if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    return { data: canvas.toDataURL('image/jpeg', 0.92), w: img.naturalWidth, h: img.naturalHeight }
  } catch { return null }
}

function BuildSheetSection({ rideCode, rideName, rideTitle, carLine, tuneBase, buildNo, client }: { rideCode: string; rideName: string; rideTitle: string; carLine: string; tuneBase: string; buildNo: number; client: { name: string | null; phone: string | null; country: string | null; preferred_message_method: string | null } | null }) {
  const [sheet, setSheet] = useState<Record<string, string>>({})
  const [otherMode, setOtherMode] = useState<Record<string, boolean>>({})
  const [bsLoading, setBsLoading] = useState(true)
  const [bsSaving, setBsSaving] = useState(false)
  const [bsSending, setBsSending] = useState(false)
  // SEND DATASHEET confirm dialog + "also send to the client" choice.
  const [sheetSendOpen, setSheetSendOpen] = useState(false)
  const [sheetToClient, setSheetToClient] = useState(false)
  // The build's given name (ride_builds.name) — printed on the BuildSheet PDF header.
  const [buildName, setBuildName] = useState('')
  // A META DO PACK na Build Sheet (ordem do usuário, 17/ago/2026): a sheet é o documento
  // do pacote, então ela declara o alvo. Os números saem EXATAMENTE da mesma conta da aba
  // DYNO — mesma perda, mesmo "melhor até agora" — pra as duas telas nunca discordarem.
  const [dyno, setDyno] = useState<{ loss: number | null; best: number; baseWhp: number | null; baseBhp: number | null; baseName: string }>({ loss: null, best: 0, baseWhp: null, baseBhp: null, baseName: '' })

  // BoneStock TUNE — picked here, uploaded to the car's Dropbox HB Tuning folder on SAVE.
  const [tuneFile, setTuneFile] = useState<File | null>(null)
  const [tuneExisting, setTuneExisting] = useState<string[]>([])

  useEffect(() => {
    void loadSheet(); void loadTuneStatus(); void loadDynoTarget()
    supabase.from('ride_builds').select('name').eq('ride_code', rideCode).eq('build_no', buildNo).maybeSingle().then(({ data }) => setBuildName(data?.name || ''))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A perda vem da baseline do CARRO (qualquer build); o "melhor" é o mesmo conjunto que a
  // aba DYNO mostra: as puxadas DESTE build mais a baseline emprestada quando ele não tem.
  async function loadDynoTarget() {
    const { data } = await supabase.from('dyno_pulls').select('*').eq('ride_code', rideCode)
    const rows = (await resolveLiveBaselines((data || []) as DynoPull[])).map(toLocalDialect)
    const mine = rows.filter((p) => p.build_no === buildNo)
    const bsAll = rows.filter(isBoneStock)
    const bsCar = bsAll.find((p) => p.loss_pct != null) ?? bsAll[0] ?? null
    const shown = mine.some(isBoneStock) || !bsCar ? mine : [bsCar, ...mine]
    setDyno({
      loss: bsCar?.loss_pct != null ? Number(bsCar.loss_pct) : (rows.find((p) => p.loss_pct != null)?.loss_pct ?? null),
      // Só puxada DE VERDADE conta como "best pull" — a linha de base é o ponto de partida,
      // não uma puxada do pacote (senão FROM e NOW saem iguais num carro que nunca rodou).
      best: shown.reduce((m, p) => (isBoneStock(p) ? m : Math.max(m, Number(p.whp) || 0)), 0),
      // DE ONDE O CARRO SAIU: a linha de fábrica (BoneStock, Stock ou a prevista). Sem ela o
      // tuner não sabe quanto já ganhou — só quanto falta, que é meia história.
      baseWhp: bsCar?.whp != null ? Number(bsCar.whp) : null,
      baseBhp: bsCar?.bhp != null ? Number(bsCar.bhp) : null,
      baseName: bsCar?.pack || '',
    })
  }

  const tgtBhp = packTargetBhp(buildName)
  const tgtLoss = dyno.loss
  const tgtWhp = tgtBhp != null && tgtLoss != null && tgtLoss > 0 && tgtLoss < 100 ? tgtBhp * (1 - tgtLoss / 100) : null
  // O que falta se mede de onde o carro ESTÁ: sem puxada nenhuma, ele está na linha de base.
  const tgtGap = tgtWhp != null ? tgtWhp - Math.max(dyno.best, dyno.baseWhp || 0) : null
  // O que o carro JÁ ganhou sobre a linha de fábrica (só quando há puxada real acima dela).
  const gainWhp = dyno.baseWhp != null && dyno.best > dyno.baseWhp ? dyno.best - dyno.baseWhp : null

  // Which BoneStock tune files already exist in the car's HB Tuning folder(s)?
  async function loadTuneStatus() {
    if (!rideCode) return
    const found = new Set<string>()
    await Promise.all(['US'].map(async (zone) => {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'find', zone, code: rideCode, match: 'bonestock tune' }) })
        const d = await res.json().catch(() => ({}))
        for (const f of d.files || []) found.add(String(f))
      } catch { /* status display only */ }
    }))
    setTuneExisting([...found].sort())
  }

  // Upload the picked BoneStock tune into the car's Dropbox HB Tuning folder(s), overwrite mode.
  // Lido do Dropbox em 06/set/2026: a pasta JÁ EXISTE nas duas raízes de Rides
  // com este nome exato — "BoneStock TuneRepository", sem espaço entre as duas
  // palavras finais. Escrever "Tune Repository" criaria uma segunda pasta.
  const BONESTOCK_REPO = 'BoneStock TuneRepository'

  async function uploadTuneFile(file: File): Promise<boolean> {
    if (file.size > 3 * 1024 * 1024) { alert('Tune file too big (max 3 MB).'); return false }
    const b64: string = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = reject
      r.readAsDataURL(file)
    })
    const ext = file.name.split('.').pop() || 'hpt'
    // "[manufacturer] [year] [brand] [model] [version] [transmission] [code] - [name] BoneStock Tune"
    const filename = `${tuneBase ? tuneBase + ' ' : ''}${rideCode}${rideName ? ' - ' + rideName : ''} BoneStock Tune.${ext}`
    // O MESMO ARQUIVO EM DOIS LUGARES (Márcio, 06/set/2026): a pasta do carro,
    // como sempre, E o acervo da casa — que fica na RAIZ de Rides e existe nas
    // DUAS zonas ("todos os carros dos 2 apps, BR e US salvam nas 2 pastas").
    // O nome da pasta foi lido do Dropbox, não inventado.
    const put = async (extra: Record<string, unknown>): Promise<boolean> => {
      try {
        const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', code: rideCode, name: rideName, filename, contentBase64: b64, ...extra }) })
        const d = await res.json().catch(() => ({}))
        return d.ok && d.result === 'uploaded'
      } catch { return false }
    }
    // 1) a pasta do carro — esta é a que não pode falhar
    const noCarro = await put({ zone: 'US' })
    // 2) o acervo, nas duas zonas. O nome que o app gera já traz marca, ano,
    //    modelo, versão, câmbio, código e nome do carro: é único por construção,
    //    então numa pasta plana não colide com o tune de outro carro. E o upload
    //    é overwrite, então regravar o mesmo carro substitui em vez de acumular.
    const faltou: string[] = []
    for (const zone of ['US', 'BR']) {
      if (!(await put({ zone, rootFolder: BONESTOCK_REPO }))) faltou.push(zone)
    }
    if (!noCarro) { alert('The BoneStock tune could not be saved to the Dropbox HB Tuning folder.'); return false }
    // O tune está salvo no carro; o acervo é cópia. Avisa sem derrubar o SAVE.
    if (faltou.length) alert(`BoneStock tune saved to the car folder, but the copy to BoneStock TuneRepository failed on: ${faltou.join(', ')}.`)
    return true
  }

  async function loadSheet() {
    const { data } = await supabase.from('ride_build_sheets').select('*').eq('ride_code', rideCode).eq('build_no', buildNo).maybeSingle()
    const s: Record<string, string> = {}
    const om: Record<string, boolean> = {}
    s.power_source = data?.power_source || POWER_SOURCES[0]
    for (const f of BS_FIELDS) {
      let v = data ? (data[f.key] ?? '') : ''
      // Regional fuel dialect: a sheet written in the BR app stores BR pump fuels —
      // shown here as their US equivalents (Podium → 93 premium, Comum → 91 regular).
      if (f.key === 'fuel') v = ({ 'Podium': '93', 'Comum': '91' } as Record<string, string>)[v] || v
      s[f.key] = v || (f.kind === 'so' ? 'Stock' : f.kind === 'text' ? '' : (f.options as string[])[0])
      // 'so' COM LISTA: o valor que bate com um conhecido seleciona a OPÇÃO —
      // só cai no Other (texto livre) o que não está na lista.
      if (f.kind === 'so' && s[f.key] !== 'Stock' && v && !(f.options || []).includes(v)) om[f.key] = true
    }
    setSheet(s)
    setOtherMode(om)
    setBsLoading(false)
  }

  async function saveSheet() {
    setBsSaving(true)
    // try/finally: o SAVE toca Dropbox e FileReader depois de gravar. Sem o finally,
    // uma rejeição em qualquer um deles pulava o setBsSaving(false) e o botão ficava
    // preso em "SAVING…" até recarregar a página — a ficha até gravava, mas a tela
    // dizia que não. O estado da tela tem que voltar mesmo quando o resto falha.
    try {
      const payload: Record<string, unknown> = { ride_code: rideCode, build_no: buildNo, power_source: sheet.power_source, updated_at: new Date().toISOString() }
      for (const f of BS_FIELDS) {
        // Fields hidden by the current Power Source save as null (keeps rows clean).
        payload[f.key] = f.show && !f.show(sheet.power_source) ? null : (sheet[f.key] || null)
      }
      const { error } = await supabase.from('ride_build_sheets').upsert(payload, { onConflict: 'ride_code,build_no' })
      if (error) { alert(error.message); return }
      // Mirror the sheet as a PDF into the car's Dropbox HB Tuning folder (every save re-syncs it).
      await syncSheetPdf()
      // A picked BoneStock tune rides along on the same SAVE.
      if (tuneFile && await uploadTuneFile(tuneFile)) { setTuneFile(null); await loadTuneStatus() }
      // success is silent — errors alert above / inside the sync
    } finally {
      setBsSaving(false)
    }
  }

  // Render the build sheet as a portrait A4 PDF (modded specs in bold).
  async function buildSheetPdf(): Promise<Blob> {
    const { jsPDF } = await import('jspdf')
    const autoTable = (await import('jspdf-autotable')).default
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()
    const logo = await loadPdfLogo()
    if (logo) {
      const maxW = 40, maxH = 14
      const s = Math.min(maxW / logo.w, maxH / logo.h)
      doc.addImage(logo.data, 'JPEG', 8, 6, logo.w * s, logo.h * s)
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(0, 0, 0)
    doc.text('BUILD SHEET', pageW - 8, 12, { align: 'right' })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90, 90, 90)
    doc.text(rideTitle, pageW - 8, 18, { align: 'right' })
    if (carLine) doc.text(carLine, pageW - 8, 23, { align: 'right' })
    doc.text(`Build.${String(buildNo).padStart(2, '0')}${buildName ? ` — ${buildName}` : ''} · ${new Date().toLocaleDateString('en-US')}`, pageW - 8, carLine ? 28 : 23, { align: 'right' })
    const rows: Array<{ label: string; value: string; modded: boolean }> = [
      { label: 'Power Source', value: sheet.power_source || '—', modded: false },
      ...BS_FIELDS.filter((f) => !f.show || f.show(sheet.power_source)).map((f) => {
        const v = (sheet[f.key] || '').trim() || '—'
        const stockVal = f.kind === 'so' ? 'Stock' : f.kind === 'text' ? '' : (f.options as string[])[0]
        return { label: f.label, value: v, modded: f.kind !== 'text' && v !== '—' && v !== stockVal }
      }),
    ]
    // A META no PDF — a Build Sheet impressa abre com a mesma jornada da tela: DE ONDE o
    // carro saiu, ONDE está e ONDE tem que chegar. Sem meta no nome do pack, nada é
    // desenhado e a tabela sobe pro lugar de sempre.
    let tableY = carLine ? 33 : 28
    if (tgtBhp != null) {
      const x = 8, w = pageW - 16, y = tableY, h = 30
      const met = tgtGap != null && tgtGap <= 0
      doc.setFillColor(248, 248, 250); doc.setDrawColor(215, 215, 222); doc.setLineWidth(0.3)
      doc.roundedRect(x, y, w, h, 2, 2, 'FD')
      // faixa de cor na borda esquerda: verde quando a meta caiu, magenta enquanto falta
      if (met) doc.setFillColor(22, 140, 60); else doc.setFillColor(160, 32, 160)
      doc.rect(x, y, 1.6, h, 'F')
      // título
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(150, 60, 150)
      doc.text('PACK TARGET' + (buildName ? '  ·  ' + buildName.toUpperCase() : ''), x + 5, y + 5)
      // O QUE FALTA, GRANDE, no canto superior direito da moldura — mesmo lugar e mesmo
      // peso que na tela: é o número que o tuner procura primeiro. Encolhe sozinho se o
      // texto crescer, pra nunca invadir o título à esquerda.
      const headline = tgtGap == null ? '' : tgtGap > 0 ? `+${tgtGap.toFixed(1)} WHP TO GO` : 'TARGET MET'
      if (headline) {
        // Grande, mas com FOLGA: a 13pt a linha ocupa ~4,6mm e termina em y+7,5, enquanto o
        // rótulo da 3ª coluna só começa em y+11 — não se tocam mais (era 17pt em y+9,5).
        doc.setFont('helvetica', 'bold')
        let hsz = 13
        doc.setFontSize(hsz)
        while (doc.getTextWidth(headline) > w * 0.42 && hsz > 8) { hsz -= 1; doc.setFontSize(hsz) }
        if (met) doc.setTextColor(22, 140, 60); else doc.setTextColor(196, 110, 0)
        doc.text(headline, x + w - 5, y + 7.5, { align: 'right' })
      }
      // três estágios
      const colW = (w - 10) / 3
      const stage = (i: number, label: string, big: string, unit: string, sub: string, note: string, rgb: [number, number, number]) => {
        const cx = x + 5 + colW * i
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6); doc.setTextColor(140, 140, 148)
        doc.text(label, cx, y + 11)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(rgb[0], rgb[1], rgb[2])
        doc.text(big, cx, y + 18)
        const bw = doc.getTextWidth(big)
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(150, 150, 158)
        doc.text(unit, cx + bw + 1.5, y + 18)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(70, 70, 78)
        doc.text(sub, cx, y + 22.5)
        if (note) { doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(rgb[0], rgb[1], rgb[2]); doc.text(note, cx, y + 26.5) }
      }
      stage(0, 'FROM  ·  BASELINE', dyno.baseWhp != null ? dyno.baseWhp.toFixed(1) : '—', 'WHP',
        dyno.baseBhp != null ? `${Number(dyno.baseBhp).toFixed(0)} BHP` : 'no baseline yet',
        dyno.baseName || '', [120, 60, 170])
      stage(1, 'NOW  ·  BEST PULL', dyno.best > 0 ? dyno.best.toFixed(1) : '—', 'WHP',
        tgtLoss != null && dyno.best > 0 ? `${(dyno.best / (1 - tgtLoss / 100)).toFixed(0)} BHP` : 'no pulls yet',
        gainWhp != null ? `+${gainWhp.toFixed(1)} WHP gained` : '', [25, 25, 30])
      stage(2, 'TARGET  ·  PACK', tgtWhp != null ? tgtWhp.toFixed(1) : '—', 'WHP',
        `= ${tgtBhp} BHP${tgtLoss != null ? ` @ ${tgtLoss}% loss` : ''}`,
        '', // o que falta agora é a manchete no topo da moldura
        met ? [22, 140, 60] : [160, 32, 160])
      // barra de progresso rente ao rodapé da caixa
      if (tgtWhp != null && tgtWhp > 0) {
        const bx = x + 5, bw2 = w - 10, by = y + h - 2.2, bh = 1.2
        doc.setFillColor(225, 225, 232); doc.rect(bx, by, bw2, bh, 'F')
        const pctBase = Math.max(0, Math.min(1, (dyno.baseWhp || 0) / tgtWhp))
        const pctNow = Math.max(0, Math.min(1, dyno.best / tgtWhp))
        doc.setFillColor(150, 110, 200); doc.rect(bx, by, bw2 * pctBase, bh, 'F')
        if (met) doc.setFillColor(22, 140, 60); else doc.setFillColor(190, 60, 190)
        doc.rect(bx + bw2 * pctBase, by, bw2 * Math.max(0, pctNow - pctBase), bh, 'F')
      }
      tableY = y + h + 4
    }
    autoTable(doc, {
      startY: tableY,
      head: [['ITEM', 'SPEC']],
      body: rows.map((r) => [r.label, r.value]),
      theme: 'grid',
      headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 10, cellPadding: 2, textColor: [40, 40, 40] },
      columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
      didParseCell: (h: any) => {
        if (h.section === 'body' && h.column.index === 1 && rows[h.row.index]?.modded) h.cell.styles.fontStyle = 'bold'
      },
    })
    return doc.output('blob')
  }

  // Upload the PDF into the car's folder(s) — common cars have a folder in BOTH
  // archives, so try both zones; the route skips zones without a folder.
  async function syncSheetPdf() {
    try {
      const blob = await buildSheetPdf()
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] || '')
        r.onerror = reject
        r.readAsDataURL(blob)
      })
      const packTag = ((buildName || '').trim() || `Build.${String(buildNo).padStart(2, '0')}`).replace(/[\/:*?"<>|]/g, '')
      const filename = `${rideCode}${rideName ? ' - ' + rideName : ''} ${packTag} BuildSheet.pdf`
      const results = await Promise.all(['US'].map(async (zone) => {
        try {
          const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', zone, code: rideCode, name: rideName, filename, contentBase64: b64 }) })
          const d = await res.json().catch(() => ({}))
          return d.ok ? String(d.result) : 'error'
        } catch { return 'error' }
      }))
      if (!results.includes('uploaded')) alert('Build sheet saved, but the PDF could not be synced to the Dropbox HB Tuning folder.')
    } catch (e) {
      alert('Build sheet saved, but the PDF sync failed: ' + String(e))
    }
  }

  // WhatsApp the full build sheet to the technical group — every visible field,
  // with the MODDED values (anything not Stock / not the field's stock default) in bold.
  async function sendSheet(alsoClient: boolean) {
    setSheetSendOpen(false)
    setBsSending(true)
    try {
      // The PDF file goes ATTACHED, regenerated from the on-screen sheet so no stale file goes out.
      const blob = await buildSheetPdf()
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] || '')
        r.onerror = reject
        r.readAsDataURL(blob)
      })
      const buildTag = `Build.${String(buildNo).padStart(2, '0')}`
      // O arquivo carrega o NOME DO PACK, não Build.XX (ordem do usuário, 17/ago/2026).
      const packTag = ((buildName || '').trim() || buildTag).replace(/[\\/:*?"<>|]/g, '')
      const filename = `${rideCode}${rideName ? ' - ' + rideName : ''} ${packTag} BuildSheet.pdf`
      // Re-sync to the Dropbox HB Tuning folder first — the caption reports where it landed.
      const ROOT_LABEL = 'Dropbox\\001 - GZ28US\\GZ28US Rides'
      const savedIn: string[] = []
      for (const zone of ['US']) {
        try {
          const res = await fetch(`${BASE_PATH}/api/ride-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', zone, code: rideCode, name: rideName, filename, contentBase64: b64 }) })
          const d = await res.json().catch(() => ({}))
          if (d.ok && d.result === 'uploaded' && typeof d.path === 'string') {
            const folderOnly = d.path.split('/').slice(0, -1).join('\\')
            savedIn.push(`${ROOT_LABEL}\\${folderOnly}`)
          }
        } catch { /* non-fatal — the WhatsApp send still goes out */ }
      }
      // Public URL for the WhatsApp attachment (storage upload, same flow as the dyno reports).
      const storagePath = `buildsheets/${rideCode}/${buildTag}-${Date.now()}.pdf`
      const { error: upErr } = await supabase.storage.from('dyno-charts').upload(storagePath, blob, { upsert: true, contentType: 'application/pdf' })
      if (upErr) { alert('PDF upload failed: ' + upErr.message); return }
      const { data: urlData } = supabase.storage.from('dyno-charts').getPublicUrl(storagePath)
      const lines: string[] = [
        `🔧 *GZ28US · DATASHEET — ${buildTag}${buildName ? ` · ${buildName}` : ''}*`,
        ...(rideTitle ? [`*${rideTitle}*`] : []),
        ...(carLine ? [carLine] : []),
        '',
        `Power Source: ${sheet.power_source}`,
        ...BS_FIELDS.filter((f) => !f.show || f.show(sheet.power_source)).map((f) => {
          const v = (sheet[f.key] || '').trim() || '—'
          const stockVal = f.kind === 'so' ? 'Stock' : f.kind === 'text' ? '' : (f.options as string[])[0]
          const modded = f.kind !== 'text' && v !== '—' && v !== stockVal
          return `${f.label}: ${modded ? `*${v}*` : v}`
        }),
        ...(savedIn.length ? ['', ...savedIn.map((p) => (tuneExisting.length ? `📁 *BoneStock TUNE* and *BuildSheet in PDF* saved in folder: ${p}` : `📁 *BuildSheet in PDF* saved in folder: ${p}`))] : []),
      ]
      const res = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toGroupName: REPORTS_GROUP, body: lines.join('\n'), documentUrl: urlData.publicUrl, filename }) })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) { alert('WhatsApp send failed: ' + (data?.detail?.error ? JSON.stringify(data.detail.error) : (data.error || `HTTP ${res.status}`))); return }
      // Optionally send the client their own copy of the DataSheet.
      if (alsoClient) {
        const to = client && (client.preferred_message_method || 'WhatsApp') === 'WhatsApp' ? toWaNumber(client.phone, client.country) : null
        if (!to) alert('Sent to the group. The client has no WhatsApp number on file, so the DataSheet was not sent to them.')
        else {
          const cli = await fetch(`${BASE_PATH}/api/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: `🔧 *Your GZ28 Build Sheet*${rideTitle ? `\n${rideTitle}` : ''}`, documentUrl: urlData.publicUrl, filename }) })
          const cd = await cli.json().catch(() => ({}))
          if (!cd.ok) alert('Sent to the group, but the client send failed: ' + (cd?.detail?.error ? JSON.stringify(cd.detail.error) : (cd.error || `HTTP ${cli.status}`)))
        }
      }
      // success is silent — the button state already showed SENDING…
    } catch (e) {
      alert('WhatsApp send failed: ' + String(e))
    } finally {
      setBsSending(false)
    }
  }

  const sel = 'bg-gray-800 border border-gray-700 rounded-2xl px-3 py-3 text-base w-full'
  const inp = 'bg-gray-900 border border-gray-700 rounded-2xl px-3 py-3 text-base w-full'

  if (bsLoading) return <p className="text-xl text-gray-400">Loading…</p>

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6">
      {sheetSendOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-3xl p-8 max-w-sm w-full">
            <h2 className="text-2xl font-bold mb-2">Send DataSheet</h2>
            <p className="text-gray-400 mb-5">Goes to the <span className="font-bold text-gray-200">{REPORTS_GROUP}</span> group.</p>
            <label className="flex items-center gap-3 mb-2 cursor-pointer">
              <input type="checkbox" checked={sheetToClient} onChange={(e) => setSheetToClient(e.target.checked)} className="w-5 h-5 accent-green-600" />
              <span className="text-lg">Also send to the client{client?.name ? ` (${client.name})` : ''}</span>
            </label>
            {sheetToClient && !client?.phone && <p className="text-sm text-yellow-400 mb-2">This ride has no client phone on file — only the group send will go out.</p>}
            <div className="flex gap-4 mt-6">
              <button onClick={() => setSheetSendOpen(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 px-5 py-3 rounded-2xl font-bold">CANCEL</button>
              <button onClick={() => sendSheet(sheetToClient)} className="flex-1 bg-blue-700 hover:bg-blue-600 px-5 py-3 rounded-2xl font-bold">SEND</button>
            </div>
          </div>
        </div>
      )}
      {/* A JORNADA DO PACK, no topo da Build Sheet (ordem do usuário, 17/ago/2026): DE ONDE
          o carro saiu (a linha de fábrica), ONDE ele está (melhor puxada) e ONDE tem que
          chegar (a meta do pack). O tuner lê quanto já tem e quanto ainda deve ter, numa
          olhada. Mesmos números da aba DYNO — mesma perda, mesma conta. */}
      {tgtBhp != null && (
        <div className={`rounded-3xl border-2 mb-6 overflow-hidden ${tgtGap != null && tgtGap <= 0 ? 'border-green-600' : 'border-fuchsia-700'}`}>
          <div className={`px-6 pt-4 pb-5 ${tgtGap != null && tgtGap <= 0 ? 'bg-gradient-to-r from-green-950 via-green-900/30 to-transparent' : 'bg-gradient-to-r from-fuchsia-950 via-fuchsia-900/25 to-transparent'}`}>
            <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
              <p className="text-[11px] font-bold tracking-[0.2em] text-fuchsia-300">🎯 PACK TARGET · {buildName}</p>
              {tgtGap != null && (tgtGap > 0
                ? <p className="text-2xl font-black text-amber-300 leading-none">+{tgtGap.toFixed(1)} <span className="text-base font-bold">WHP TO GO</span></p>
                : <p className="text-2xl font-black text-green-400 leading-none">✅ TARGET MET</p>)}
            </div>

            <div className="flex items-stretch gap-3 flex-wrap">
              {/* DE ONDE SAIU */}
              <div className="flex-1 min-w-[10rem]">
                <p className="text-[10px] font-bold tracking-widest text-gray-500 mb-1">FROM · BASELINE</p>
                <p className="text-3xl font-black leading-none text-purple-300">{dyno.baseWhp != null ? dyno.baseWhp.toFixed(1) : '—'}<span className="text-sm font-bold text-gray-500 ml-1">WHP</span></p>
                <p className="text-sm text-gray-400 mt-1">
                  {dyno.baseBhp != null ? `${Number(dyno.baseBhp).toFixed(0)} BHP` : 'no baseline yet'}
                </p>
                {dyno.baseName ? <p className={`text-xs font-bold mt-1 ${isPredictedBaseline(dyno.baseName) ? 'text-fuchsia-300' : 'text-purple-400'}`}>{isPredictedBaseline(dyno.baseName) ? '📐 ' : ''}{dyno.baseName}</p> : null}
              </div>

              <div className="self-center text-2xl text-gray-600 font-black">→</div>

              {/* ONDE ESTÁ */}
              <div className="flex-1 min-w-[10rem]">
                <p className="text-[10px] font-bold tracking-widest text-gray-500 mb-1">NOW · BEST PULL</p>
                <p className="text-3xl font-black leading-none text-white">{dyno.best > 0 ? dyno.best.toFixed(1) : '—'}<span className="text-sm font-bold text-gray-500 ml-1">WHP</span></p>
                <p className="text-sm text-gray-400 mt-1">
                  {tgtLoss != null && dyno.best > 0 ? `${(dyno.best / (1 - tgtLoss / 100)).toFixed(0)} BHP` : 'no pulls yet'}
                </p>
                {gainWhp != null && <p className="text-xs font-bold text-green-400 mt-1">▲ +{gainWhp.toFixed(1)} WHP gained</p>}
              </div>

              <div className="self-center text-2xl text-gray-600 font-black">→</div>

              {/* ONDE TEM QUE CHEGAR */}
              <div className="flex-1 min-w-[12rem]">
                <p className="text-[10px] font-bold tracking-widest text-fuchsia-400 mb-1">TARGET · PACK</p>
                <p className="text-3xl font-black leading-none text-fuchsia-200">{tgtWhp != null ? tgtWhp.toFixed(1) : '—'}<span className="text-sm font-bold text-fuchsia-400/70 ml-1">WHP</span></p>
                <p className="text-sm text-gray-300 mt-1">
                  = <span className="font-bold text-white">{tgtBhp} BHP</span>
                  {tgtLoss != null ? <span className="text-gray-400"> @ {tgtLoss}% loss</span> : <span className="text-amber-300 font-bold"> — loss not set</span>}
                </p>
              </div>
            </div>
          </div>

          {/* Quanto do alvo já está na roda — a baseline já ocupa a primeira fatia. */}
          {tgtWhp != null && tgtWhp > 0 && (
            <div className="h-2.5 bg-black/70 flex">
              <div className="h-full bg-purple-600" style={{ width: `${Math.max(0, Math.min(100, ((dyno.baseWhp || 0) / tgtWhp) * 100))}%` }} />
              <div className={`h-full ${tgtGap != null && tgtGap <= 0 ? 'bg-green-500' : 'bg-fuchsia-500'}`} style={{ width: `${Math.max(0, Math.min(100, ((dyno.best - (dyno.baseWhp || 0)) / tgtWhp) * 100))}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end mb-4">
        <button onClick={() => { setSheetToClient(false); setSheetSendOpen(true) }} disabled={bsSending} className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold text-lg">
          {bsSending ? 'SENDING…' : 'SEND DATASHEET'}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <div>
          <label className="block mb-1 text-sm text-gray-400 font-bold">POWER SOURCE</label>
          <select value={sheet.power_source} onChange={(e) => setSheet({ ...sheet, power_source: e.target.value })} className={sel}>
            {POWER_SOURCES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        {BS_FIELDS.filter((f) => !f.show || f.show(sheet.power_source)).map((f) => (
          <div key={f.key} className={f.kind === 'text' ? 'md:col-span-2 xl:col-span-3' : undefined}>
            <label className="block mb-1 text-sm text-gray-400 font-bold">{f.label.toUpperCase()}</label>
            {f.kind === 'text' ? (
              <textarea
                value={sheet[f.key] || ''}
                onChange={(e) => setSheet({ ...sheet, [f.key]: e.target.value })}
                rows={3}
                className={`${sel} resize-y`}
              />
            ) : f.kind === 'enum' ? (
              <select value={sheet[f.key]} onChange={(e) => setSheet({ ...sheet, [f.key]: e.target.value })} className={sel}>
                {(f.options as string[]).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <div className="flex gap-2">
                <select
                  value={otherMode[f.key] ? 'Other' : ((f.options || []).includes(sheet[f.key]) ? sheet[f.key] : 'Stock')}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === 'Other') { setOtherMode({ ...otherMode, [f.key]: true }); setSheet({ ...sheet, [f.key]: (f.options || []).includes(sheet[f.key]) || sheet[f.key] === 'Stock' ? '' : sheet[f.key] }) }
                    // Stock ou um dos conhecidos: o próprio valor vai pra ficha e o
                    // texto livre se fecha.
                    else { setOtherMode({ ...otherMode, [f.key]: false }); setSheet({ ...sheet, [f.key]: v }) }
                  }}
                  className={`${sel} ${otherMode[f.key] ? 'w-28 shrink-0' : ''}`}
                  style={otherMode[f.key] ? { width: '7rem' } : undefined}
                >
                  <option value="Stock">Stock</option>
                  {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  <option value="Other">Other</option>
                </select>
                {otherMode[f.key] && (
                  <input type="text" value={sheet[f.key] || ''} onChange={(e) => setSheet({ ...sheet, [f.key]: e.target.value })} className={inp} placeholder={f.label} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-6">
        <label className="block mb-1 text-sm text-gray-400 font-bold">BONESTOCK TUNE</label>
        {tuneExisting.length > 0 && <p className="mb-2 text-green-400 font-bold text-sm">✅ {tuneExisting.join(' · ')}</p>}
        <label className="inline-flex items-center gap-2 bg-gray-800 border border-gray-700 hover:bg-gray-700 px-4 py-2 rounded-2xl font-bold cursor-pointer">
          {tuneFile ? `📄 ${tuneFile.name}` : (tuneExisting.length ? '🔄 CHOOSE NEW BONESTOCK TUNE' : '⚙️ CHOOSE BONESTOCK TUNE')}
          <input type="file" className="hidden" onChange={(e) => { setTuneFile(e.target.files?.[0] || null); e.target.value = '' }} />
        </label>
        {tuneFile && <span className="ml-3 text-gray-400 text-sm">uploads to HB Tuning when you press SAVE</span>}
      </div>
      <div className="flex justify-end mt-6">
        <button onClick={saveSheet} disabled={bsSaving} className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-6 py-3 rounded-2xl font-bold text-lg">
          {bsSaving ? 'SAVING…' : 'SAVE BUILD SHEET and BONESTOCK TUNE'}
        </button>
      </div>
    </div>
  )
}

export default function RidePerformancePage() {
  const params = useParams()
  const rideId = String(params.id)
  const buildNo = Math.max(1, parseInt(String(params.build || '1'), 10) || 1)
  const buildLabel = `Build.${String(buildNo).padStart(2, '0')}`
  const [ride, setRide] = useState<{ project_code: string | null; project_name: string | null; manufacturer: string | null; brand: string | null; model: string | null; version: string | null; special_edition: string | null; year: number | null; transmission: string | null } | null>(null)
  const [buildName, setBuildName] = useState('')
  const [client, setClient] = useState<{ name: string | null; phone: string | null; country: string | null; preferred_message_method: string | null } | null>(null)
  const [tab, setTab] = useState<Tab>('DYNO')

  useEffect(() => {
    supabase.from('rides').select('project_code, project_name, manufacturer, brand, model, version, special_edition, year, transmission, client_id').eq('id', rideId).single().then(({ data }) => {
      setRide(data)
      if (data?.project_code) {
        supabase.from('ride_builds').select('name').eq('ride_code', data.project_code).eq('build_no', buildNo).maybeSingle().then(({ data: b }) => setBuildName(b?.name || ''))
      }
      if (data?.client_id) {
        supabase.from('clients').select('name, phone, country, preferred_message_method').eq('id', data.client_id).single().then(({ data: c }) => setClient(c))
      }
    })
  }, [])

  const title = ride ? `${ride.project_code || ''}${ride.project_name ? ` — ${ride.project_name}` : ''}` : ''
  // "[brand] [model] [version] [transmission] [year]" — the car identity line for the BuildSheet PDF + reports.
  const carLine = ride ? [ride.brand, ride.model, ride.version, ride.transmission, ride.year].filter(Boolean).join(' ') : ''
  // BoneStock tune filename prefix: "[manufacturer] [year] [brand] [model] [version] [transmission]".
  const tuneBase = ride ? [ride.manufacturer, ride.year, ride.brand, ride.model, ride.version, ride.transmission].filter(Boolean).join(' ') : ''
  // Known drivetrain loss: Challenger/Charger Hellcat or Redeye WIDEBODY (NOT the
  // SuperStock) dyno at ~18.5% crank→wheel loss — pre-filled, still editable.
  const defaultLoss = (() => {
    if (!ride) return ''
    const txt = [ride.brand, ride.model, ride.version, ride.special_edition].filter(Boolean).join(' ').toLowerCase()
    const isCC = /(challenger|charger)/.test(txt)
    const isHellcatOrRedeye = /(hellcat|red\s*eye)/.test(txt)
    const isWidebody = /(wide\s*body)/.test(txt)
    const isSuperStock = /(super\s*stock)/.test(txt)
    return isCC && isHellcatOrRedeye && isWidebody && !isSuperStock ? '18.5' : ''
  })()

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />

      <div className="flex items-center justify-between mb-1 gap-4 flex-wrap">
        <h1 className="text-4xl font-bold">PERFORMANCE — {buildLabel}{buildName ? ` — ${buildName}` : ''}</h1>
        <div className="flex gap-3">
          <Link href={`/rides/${rideId}/performance`} className="bg-gray-700 hover:bg-gray-600 px-6 py-4 rounded-2xl text-xl font-bold">BACK</Link>
          <Link href={`/rides/${rideId}`} className="bg-gray-600 hover:bg-gray-500 px-6 py-4 rounded-2xl text-xl font-bold">VIEW RIDE</Link>
        </div>
      </div>
      {title && <p className="text-xl text-gray-400 mb-6">{title}</p>}

      <div className="flex gap-2 flex-wrap mb-8">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 rounded-2xl font-bold ${tab === t ? 'bg-white text-black' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {!ride ? (
        <p className='text-xl text-gray-400'>Loading…</p>
      ) : tab === 'DYNO' ? (
        <DynoSection rideId={rideId} rideCode={ride.project_code || ''} rideTitle={title} buildNo={buildNo} defaultLoss={defaultLoss} packName={buildName} />
      ) : tab === 'BUILD SHEET' ? (
        <BuildSheetSection rideCode={ride.project_code || ''} rideName={ride.project_name || ''} rideTitle={title} carLine={carLine} tuneBase={tuneBase} buildNo={buildNo} client={client} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-3xl p-8">
          <h2 className="text-2xl font-bold mb-2">{tab}</h2>
          <p className="text-xl text-gray-400">This section is under construction.</p>
        </div>
      )}
    </main>
  )
}
