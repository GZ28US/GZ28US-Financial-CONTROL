'use client'
/* eslint-disable @typescript-eslint/no-explicit-any */

// THE PAPER on the client's link (09/11/2026, Márcio: «the top of the client page = THE PRINTABLE INVOICE ITSELF»). The same
// layout as the app's printable invoice (app/rides/[id]/invoices/[invoiceId]/page.tsx, `.pi-*`) and the portal PDF
// (lib/docPdf.server.ts), drawn ONLY from the frozen revision snapshot. Designed at 816 px (letter width, like the printable) and
// scaled to the screen: full width on desktop (up to 1.35×), shrinks on a phone. Pure presentation — no server calls.

import { useEffect, useRef, useState } from 'react'
import { BASE_PATH, formatPhone } from '@/lib/utils'
import { t, money, moneyCents, type Lang } from '@/lib/quoteStrings'
import { fmtDay } from '@/lib/orlando'
import { buyLink } from '@/lib/buyLink'

const W = { en: { quoteNo: 'Quote #', invoiceNo: 'Invoice #', clientT: 'Client', name: 'Name', address: 'Address', cityst: 'City/ST', phone: 'Phone', email: 'E-Mail',
    vehicle: 'Vehicle', make: 'Make / Brand', model: 'Model', yearvin: 'Year / VIN', colorplate: 'Color / Plate / Mi', pack: 'Service',
    items: 'Items', desc: 'Description', unit: 'Unit Price', qt: 'Qt', total: 'Total', subtotal: 'Sub-Total', itemsTotal: 'Items Total',
    services: 'Services', servicesTotal: 'Services Total', itemsServices: 'Items + Services', grand: 'Grand Total', notesT: 'Notes',
    plan: 'Payment Plan', due: 'Due', amount: 'Amount', exempt: 'Florida sales tax exempt', rev: 'Rev', valid: 'Valid until', paid: 'PAID', net: (n: number) => `Net ${n} days` },
  pt: { quoteNo: 'Orçamento #', invoiceNo: 'Fatura #', clientT: 'Cliente', name: 'Nome', address: 'Endereço', cityst: 'Cidade/UF', phone: 'Telefone', email: 'E-Mail',
    vehicle: 'Veículo', make: 'Marca / Fabricante', model: 'Modelo', yearvin: 'Ano / VIN', colorplate: 'Cor / Placa / Mi', pack: 'Serviço',
    items: 'Itens', desc: 'Descrição', unit: 'Preço Unit.', qt: 'Qt', total: 'Total', subtotal: 'Sub-Total', itemsTotal: 'Total dos Itens',
    services: 'Serviços', servicesTotal: 'Total dos Serviços', itemsServices: 'Itens + Serviços', grand: 'Total Geral', notesT: 'Observações',
    plan: 'Plano de Pagamento', due: 'Vencimento', amount: 'Valor', exempt: 'Isento de imposto sobre vendas da Flórida', rev: 'Rev', valid: 'Válido até', paid: 'PAGO', net: (n: number) => `${n} dias` } }

export const PAPER_CSS = `
.pi * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
.pi { background: white; color: #111; font-size: 9px; position: relative; padding: 18px 24px 22px; }
.pi-watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0.055; width: 500px; pointer-events: none; z-index: 0; }
.pi-content { position: relative; z-index: 1; }
.pi-header { display: grid; grid-template-columns: 156px 1fr 156px; align-items: center; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 8px; gap: 10px; }
.pi-logo { width: 156px; height: auto; display: block; }
.pi-company { text-align: center; }
.pi-company-name { font-size: 13px; font-weight: 900; letter-spacing: 0.5px; margin-bottom: 2px; }
.pi-company-sub { font-size: 8px; color: #555; line-height: 1.5; }
.pi-inv-box { text-align: right; }
.pi-inv-label { font-size: 7px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
.pi-inv-num { font-size: 20px; font-weight: 900; color: #cc0000; letter-spacing: 1px; line-height: 1; white-space: nowrap; }
.pi-inv-date { font-size: 8px; color: #555; margin-top: 2px; }
.pi-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
.pi-info-block { border: 0.5px solid #ccc; border-radius: 3px; padding: 5px 8px; }
.pi-info-title { font-size: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #888; border-bottom: 0.5px solid #eee; padding-bottom: 2px; margin-bottom: 3px; }
.pi-info-row { display: flex; gap: 3px; margin-bottom: 1px; }
.pi-info-label { font-weight: 700; color: #666; min-width: 80px; font-size: 8px; flex-shrink: 0; }
.pi-info-value { color: #111; font-size: 8px; }
.pi-sec { margin-bottom: 7px; }
.pi-sec-title { background: #111; color: white; font-weight: 700; font-size: 8px; letter-spacing: 1px; text-transform: uppercase; padding: 3px 8px; }
.pi-table { width: 100%; border-collapse: collapse; font-size: 8px; }
.pi-table thead tr { background: #e0e0e0; }
.pi-table thead th { padding: 4px 6px; text-align: left; font-weight: 700; font-size: 7px; text-transform: uppercase; border: 0.5px solid #bbb; }
.pi-table thead th.r { text-align: right; }
.pi-table tbody td { padding: 4px 6px; vertical-align: top; border-left: 0.5px solid #e8e8e8; border-right: 0.5px solid #e8e8e8; border-bottom: 0.5px solid #ececec; }
.pi-table tbody tr:nth-child(even) td { background: #fafafa; }
.pi-table td.r { text-align: right; }
.pi-subtotal td { background: #efefef !important; font-weight: 700; border-top: 1px solid #bbb !important; }
.pi-ptotal td, .pi-stotal td { background: #111 !important; color: white !important; font-weight: 900; font-size: 9px; }
.pi-totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 7px; }
.pi-totals-tbl { width: 250px; border-collapse: collapse; font-size: 8px; }
.pi-totals-tbl td { padding: 4px 6px; }
.pi-totals-tbl .r { text-align: right; }
.pi-psrow td { background: #f0f0f0; font-weight: 700; }
.pi-discrow td { background: #f0f0f0; font-weight: 700; color: #cc0000; }
.pi-grandrow td { background: #1a1a2e !important; color: #f0c040 !important; font-weight: 900; font-size: 11px; padding: 5px 6px; border-top: 2px solid #f0c040 !important; }
.pi-paid { color: #15803d; font-weight: 700; }
.pi-notes { border: 0.5px solid #ccc; border-radius: 3px; padding: 6px 12px; margin-bottom: 8px; text-align: center; }
.pi-notes-title { font-weight: 700; text-transform: uppercase; font-size: 7px; letter-spacing: 0.5px; color: #888; margin-bottom: 4px; }
.pi-notes p { font-size: 8px; margin-bottom: 1px; }
`

type Row = [string, string]

export default function PaperDoc({ doc, plan, lang, isInvoice }: { doc: any; plan: any[]; lang: Lang; isInvoice?: boolean }) {
  const T = W[lang] || W.en
  const h = doc.header || {}, tot = doc.totals || {}, cl = doc.client || null, vh = doc.vehicle || null
  const code = h.display_code || h.code || ''
  const us = !/Ltda/i.test(String(doc.company?.name || ''))
  const zero = (l: any) => (l.display === 'included' ? t(lang, 'included') : t(lang, 'courtesy')).toUpperCase()
  const shown = (l: any) => l.display === 'price' ? money(l.total, lang) : zero(l)
  const lines: any[] = doc.lines || []
  const items = lines.filter(l => l.kind !== 'service'), services = lines.filter(l => l.kind === 'service')
  const sum = (ls: any[]) => ls.reduce((s, l) => s + (Number(l.total) || 0), 0)
  const groupTotal = (ls: any[], v: number) => Math.abs(v) > 0.005 ? money(v, lang) : (ls.some(l => l.display === 'included') ? t(lang, 'included') : t(lang, 'courtesy')).toUpperCase()

  const clientRows: Row[] = [[T.name, cl?.name || h.client_name || '—']]
  if (cl?.address) clientRows.push([T.address, cl.address])
  if (cl?.city || cl?.state) clientRows.push([T.cityst, [cl.city, cl.state].filter(Boolean).join(' / ') + (cl.zip ? ` ${cl.zip}` : '')])
  if (cl?.phone) clientRows.push([T.phone, formatPhone(cl.phone, cl.country)])
  if (cl?.email) clientRows.push([T.email, cl.email])
  const vehRows: Row[] = []
  if (vh) {
    if (vh.make) vehRows.push([T.make, vh.make])
    if (vh.model) vehRows.push([T.model, vh.model])
    if (vh.year || vh.vin) vehRows.push([T.yearvin, [vh.year, vh.vin].filter(Boolean).join(' — ')])
    if (vh.color || vh.plate || vh.mileage) vehRows.push([T.colorplate, [vh.color, vh.plate, vh.mileage ? Number(vh.mileage).toLocaleString('en-US') : null].filter(Boolean).join(' — ')])
  } else vehRows.push([T.model, h.car || '—'])
  if (h.service) vehRows.push([T.pack, h.service])

  // kits grouped under their name, members indented — like the printable
  const itemRows: React.ReactElement[] = []
  const seen = new Set<string>()
  for (const l of items) {
    if (l.kit_group && !seen.has(l.kit_group)) {
      seen.add(l.kit_group)
      const members = items.filter(x => x.kit_group === l.kit_group)
      itemRows.push(<tr key={'k' + l.kit_group} style={{ background: '#eef2f2' }}><td colSpan={3} style={{ fontWeight: 700 }}>{l.kit_name || 'Kit'}</td><td className="r" style={{ fontWeight: 700 }}>{groupTotal(members, sum(members))}</td></tr>)
    }
    const bl = buyLink(l.buy_url)
    itemRows.push(<tr key={l.id}><td style={l.kit_group ? { paddingLeft: 16 } : undefined}>{l.description}
      {bl && <div style={{ fontSize: '0.85em', marginTop: 2 }}><a href={bl.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8', textDecoration: 'underline' }}>{t(lang, 'buy')} ↗ {bl.host}</a></div>}</td>
      <td className="r">{l.display === 'price' ? money(l.unit_price, lang) : zero(l)}</td><td className="r">{l.quantity || 1}</td><td className="r">{shown(l)}</td></tr>)
  }
  const itemsTotal = Number(tot.parts ?? sum(items)), servicesTotal = Number(tot.services ?? sum(services))
  const dueOf = (p: any) => p.due_date ? fmtDay(p.due_date, lang) : p.due_rule === 'NET_DAYS' && p.net_days != null ? T.net(Number(p.net_days)) : ['ON_APPROVAL', 'ON_ARRIVAL', 'ON_CONCLUSION'].includes(p.due_rule) ? t(lang, 'due.' + p.due_rule) : '—'

  return (
    <Scaled>
      <style>{PAPER_CSS}</style>
      <div className="pi">
        <img src={`${BASE_PATH}/logo_gz28.jpg`} className="pi-watermark" alt="" aria-hidden="true" />
        <div className="pi-content">
          <div className="pi-header">
            <img src={`${BASE_PATH}/logo_gz28.jpg`} className="pi-logo" alt="GZ28" />
            <div className="pi-company">
              <div className="pi-company-name">{doc.company?.name || 'GZ28 V8 SpeedShop USA LLC'}</div>
              <div className="pi-company-sub">{doc.company?.address}</div>
              <div className="pi-company-sub">PHONE: {doc.company?.phone} · EMAIL: {doc.company?.email}</div>
              {us && <div className="pi-company-sub">IG: @gz28us · FB: Dema De Maria</div>}
            </div>
            <div className="pi-inv-box">
              <div className="pi-inv-label">{isInvoice ? T.invoiceNo : T.quoteNo}</div>
              <div className="pi-inv-num">{code}</div>
              <div className="pi-inv-date">{T.rev} {doc.seq}</div>
              {!isInvoice && doc.valid_until && <div className="pi-inv-date">{T.valid} {fmtDay(doc.valid_until, lang)}</div>}
            </div>
          </div>

          <div className="pi-two-col">
            <Info title={T.clientT} rows={clientRows} />
            <Info title={T.vehicle} rows={vehRows} />
          </div>

          {items.length > 0 && <div className="pi-sec">
            <div className="pi-sec-title">{T.items}</div>
            <table className="pi-table">
              <thead><tr><th style={{ width: '56%' }}>{T.desc}</th><th className="r" style={{ width: '16%' }}>{T.unit}</th><th className="r" style={{ width: '8%' }}>{T.qt}</th><th className="r" style={{ width: '20%' }}>{T.total}</th></tr></thead>
              <tbody>
                {itemRows}
                <tr className="pi-subtotal"><td colSpan={3} className="r">{T.subtotal}</td><td className="r">{groupTotal(items, itemsTotal)}</td></tr>
                <tr className="pi-ptotal"><td colSpan={3} className="r">{T.itemsTotal}</td><td className="r">{groupTotal(items, itemsTotal)}</td></tr>
              </tbody>
            </table>
          </div>}

          {services.length > 0 && <div className="pi-sec">
            <div className="pi-sec-title">{T.services}</div>
            <table className="pi-table">
              <thead><tr><th style={{ width: '80%' }}>{T.desc}</th><th className="r" style={{ width: '20%' }}>{T.total}</th></tr></thead>
              <tbody>
                {services.map(l => <tr key={l.id}><td>{l.description}</td><td className="r">{shown(l)}</td></tr>)}
                <tr className="pi-stotal"><td className="r">{T.servicesTotal}</td><td className="r">{groupTotal(services, servicesTotal)}</td></tr>
              </tbody>
            </table>
          </div>}

          <div className="pi-totals-wrap">
            <table className="pi-totals-tbl"><tbody>
              <tr className="pi-psrow"><td>{T.itemsServices}</td><td className="r">{money(Number(tot.subtotal ?? itemsTotal + servicesTotal), lang)}</td></tr>
              {Number(tot.discount) > 0 && <tr className="pi-discrow"><td>{t(lang, 'discount')} ({tot.discount_pct}%)</td><td className="r">— {money(tot.discount, lang)}</td></tr>}
              {tot.taxable
                ? <tr className="pi-psrow"><td>{t(lang, 'fl_tax')}</td><td className="r">{money(tot.fl_tax, lang)}</td></tr>
                : ['EXPORT', 'OUT_OF_STATE', 'OVERRIDE_EXEMPT'].includes(String(tot.fl_status || '')) && <tr className="pi-psrow"><td>{T.exempt}</td><td className="r">—</td></tr>}
              <tr className="pi-grandrow"><td>{T.grand}</td><td className="r">{money(Number(tot.grand || 0), lang)}</td></tr>
            </tbody></table>
          </div>

          {plan.length > 0 && <div className="pi-sec">
            <div className="pi-sec-title">{T.plan}</div>
            <table className="pi-table">
              <thead><tr><th style={{ width: '6%' }}>#</th><th style={{ width: '54%' }}>{T.desc}</th><th style={{ width: '20%' }}>{T.due}</th><th className="r" style={{ width: '20%' }}>{T.amount}</th></tr></thead>
              <tbody>
                {plan.map(p => <tr key={p.seq}><td>{p.seq}</td><td>{p.label}</td><td>{dueOf(p)}</td>
                  <td className="r">{moneyCents(p.amount_cents, lang)}{p.paid ? <span className="pi-paid"> · {T.paid}</span> : null}</td></tr>)}
              </tbody>
            </table>
          </div>}

          {doc.notes?.length > 0 && <div className="pi-notes">
            <div className="pi-notes-title">{T.notesT}</div>
            {doc.notes.map((n: any) => <p key={n.id}>{n.text}</p>)}
          </div>}
        </div>
      </div>
    </Scaled>
  )
}

function Info({ title, rows }: { title: string; rows: Row[] }) {
  return <div className="pi-info-block">
    <div className="pi-info-title">{title}</div>
    {rows.map(([k, v], i) => <div key={i} className="pi-info-row"><span className="pi-info-label">{k}:</span><span className="pi-info-value">{v}</span></div>)}
  </div>
}

// Draws the 816 px paper at the width the screen has: scale = container / 816 (max 1.35 on a wide desktop).
function Scaled({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(1), [hgt, setHgt] = useState<number | undefined>(undefined)
  useEffect(() => {
    const fit = () => {
      if (!box.current || !inner.current) return
      const s = Math.min(1.4, box.current.clientWidth / 816)
      setK(s); setHgt(inner.current.offsetHeight * s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (box.current) ro.observe(box.current)
    if (inner.current) ro.observe(inner.current)
    return () => ro.disconnect()
  }, [])
  return <div ref={box} className="q-paper-box" style={{ width: '100%', height: hgt, overflow: 'hidden' }}>
    <div ref={inner} style={{ width: 816, transform: `scale(${k})`, transformOrigin: 'top left', boxShadow: '0 2px 18px rgba(0,0,0,.18)' }}>{children}</div>
  </div>
}
