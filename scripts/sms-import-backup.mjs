// IMPORTA O HISTÓRICO DE SMS/iMessage/RCS DO BACKUP LOCAL DO iPHONE US → sms_messages (Márcio, 12/11/2026: «yes»).
//
//   node scripts/sms-import-backup.mjs <caminho do sms.db>            # ensaio: só conta e mostra amostras
//   node scripts/sms-import-backup.mjs <caminho do sms.db> --grava    # grava (idempotente: upsert por guid)
//
// O sms.db é o arquivo 3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28 do backup (Apple Devices, sem criptografia).
// Precisa da MIGRATION_sms_both_directions.sql (colunas from_me, guid, service, author, attachments).
// `sender` = a CONVERSA (o outro lado: telefone/e-mail; grupo = identificador do chat) nos dois sentidos;
// `author` = quem escreveu numa mensagem recebida. Linha antiga do atalho (IOS_SHORTCUT) que é a mesma mensagem
// (mesmo remetente, mesmo texto, até 10 min de diferença) NÃO duplica: ganha o guid e os campos novos.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const file = process.argv[2], GRAVA = process.argv.includes('--grava')
if (!file) { console.error('uso: node scripts/sms-import-backup.mjs <sms.db> [--grava]'); process.exit(1) }
try { process.loadEnvFile('.env.local') } catch { /* env já no ambiente */ }
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const L = s => fmt.format(new Date(s)).replace(',', '')

// texto dentro do attributedBody (typedstream da Apple): ...NSString 01 94 84 01 2B <tamanho> <utf8>
function unpack(blob) {
  if (!blob) return ''
  const b = Buffer.from(blob)
  let i = b.indexOf('NSString')
  if (i < 0) return ''
  i = b.indexOf(0x2b, i)                       // '+'
  if (i < 0) return ''
  i++
  let len = b[i++]
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2 }
  else if (len === 0x82) { len = b.readUInt32LE(i); i += 4 }
  return b.subarray(i, i + len).toString('utf8')
}
const clean = s => String(s || '').replace(/￼/g, '').replace(/\u0000/g, '').trim()

const db = new DatabaseSync(file, { readOnly: true })
const rows = db.prepare(`
  select m.ROWID id, m.guid, m.text, m.attributedBody, m.is_from_me, m.service, m.date/1000000 date, m.item_type, m.associated_message_type,
         h.id handle, c.chat_identifier, c.display_name, c.style,
         (select count(*) from message_attachment_join j where j.message_id = m.ROWID) natt,
         (select group_concat(coalesce(a.transfer_name, a.mime_type, 'file'), ', ') from message_attachment_join j join attachment a on a.ROWID = j.attachment_id where j.message_id = m.ROWID) anames
    from message m
    left join handle h on h.ROWID = m.handle_id
    left join chat_message_join cj on cj.message_id = m.ROWID
    left join chat c on c.ROWID = cj.chat_id
   group by m.ROWID order by m.ROWID`).all()

const out = []; const skip = { vazio: 0, sistema: 0, semConversa: 0 }; let desempacotadas = 0, falhaDesempacote = 0
for (const r of rows) {
  if (r.item_type && r.item_type !== 0) { skip.sistema++; continue }
  let body = clean(r.text)
  if (!body && r.attributedBody) { body = clean(unpack(r.attributedBody)); if (body) desempacotadas++; else if (!r.natt) falhaDesempacote++ }
  if (r.natt) body = (body ? body + '\n' : '') + `[${r.natt} attachment${r.natt > 1 ? 's' : ''}: ${r.anames || ''}]`
  if (!body) { skip.vazio++; continue }
  const group = r.style === 43
  const conversa = group ? (r.chat_identifier || null) : (r.handle || r.chat_identifier || null)
  if (!conversa) { skip.semConversa++; continue }
  out.push({
    guid: r.guid, sender: conversa, author: r.is_from_me ? null : (r.handle || null), from_me: !!r.is_from_me,
    body: (group && r.display_name && false ? '' : '') + body, service: r.service || null, attachments: r.natt || 0,
    received_at: new Date((Number(r.date) + 978307200000)).toISOString(), source: 'IPHONE_BACKUP',
  })
}
console.log(`mensagens no arquivo: ${rows.length} · a importar: ${out.length} (enviadas ${out.filter(o => o.from_me).length} · recebidas ${out.filter(o => !o.from_me).length})`)
console.log(`puladas: sem texto nem anexo ${skip.vazio} · linha de sistema ${skip.sistema} · sem conversa ${skip.semConversa}`)
console.log(`texto desempacotado do formato Apple: ${desempacotadas} · desempacote falhou: ${falhaDesempacote}`)
console.log(`conversas: ${new Set(out.map(o => o.sender)).size} · de ${L(out[0].received_at)} a ${L(out[out.length - 1].received_at)} (Orlando)`)

// a chave de serviço mora no arquivo da memória (nunca em argv/echo)
const KEY_DIR = `${process.env.USERPROFILE}/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory`
const url = process.env.NEXT_PUBLIC_SUPABASE_URL; let key = ''
try { key = readFileSync(`${KEY_DIR}/us-service-key.txt`, 'utf8').trim().split(/\s+/).pop() } catch { /* abaixo */ }
if (!url || !key) { console.error('sem NEXT_PUBLIC_SUPABASE_URL ou us-service-key.txt'); process.exit(1) }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const rest = async (path, init = {}) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const t = await r.text()
  if (!r.ok) { console.error('REST', r.status, path.slice(0, 60), t.slice(0, 300)); process.exit(1) }
  return { body: t ? JSON.parse(t) : null, headers: r.headers }
}

// as linhas antigas do atalho: a mesma mensagem não entra duas vezes
const antigas = []
for (let from = 0; ; from += 1000) {
  const { body } = await rest(`sms_messages?select=id,sender,body,received_at,source&order=received_at.asc,id.asc&offset=${from}&limit=1000`)
  antigas.push(...body); if (body.length < 1000) break
}
const atalho = antigas.filter(a => a.source === 'IOS_SHORTCUT')
const dig = s => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : String(s || '').toLowerCase() }
const nb = s => clean(s).replace(/\s+/g, ' ')
const usados = new Set(), casadas = []
for (const o of out) {
  if (o.from_me) continue
  const t = Date.parse(o.received_at), bo = nb(o.body.replace(/\n?\[\d+ attachments?: [^\]]*\]$/, ''))
  const m = atalho.find(a => !usados.has(a.id) && dig(a.sender) === dig(o.author || o.sender) && Math.abs(Date.parse(a.received_at) - t) <= 600000 && (nb(a.body) === bo || (bo && nb(a.body).startsWith(bo.slice(0, 40)))))
  if (m) { usados.add(m.id); casadas.push({ id: m.id, o }); o._casada = true }
}
const novas = out.filter(o => !o._casada)
console.log(`linhas já na tabela: ${antigas.length} (atalho ${atalho.length}) · casadas com o backup: ${casadas.length} · atalho sem par no backup: ${atalho.length - casadas.length} · novas a inserir: ${novas.length}`)

if (!GRAVA) {
  for (const o of [out[0], out[Math.floor(out.length / 2)], out[out.length - 1]]) console.log('  amostra ·', L(o.received_at), o.from_me ? '→' : '←', o.service, '· conversa', String(o.sender).slice(0, 4) + '…', '·', JSON.stringify(o.body.slice(0, 50)))
  const sem = atalho.filter(a => !usados.has(a.id)); console.log('  atalho sem par, por mês:', JSON.stringify(sem.reduce((m, a) => { const k = a.received_at.slice(0, 7); m[k] = (m[k] || 0) + 1; return m }, {})))
  console.log('ENSAIO — nada gravado. Rode com --grava.'); process.exit(0)
}
for (const c of casadas)
  await rest(`sms_messages?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ guid: c.o.guid, service: c.o.service, author: c.o.author, attachments: c.o.attachments, sender: c.o.sender }) })
let ok = 0
for (let i = 0; i < novas.length; i += 500) {
  const lote = novas.slice(i, i + 500).map(({ _casada, ...o }) => o)
  await rest('sms_messages?on_conflict=guid', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(lote) })
  ok += lote.length
}
const { headers } = await rest('sms_messages?select=id&limit=1', { headers: { Prefer: 'count=exact' } })
console.log(`GRAVADO: ${casadas.length} linhas do atalho completadas · ${ok} enviadas ao banco · total na tabela agora: ${headers.get('content-range')}`)
