#!/usr/bin/env node
// RODA-SQL — o caminho único para executar SQL nos bancos da GZ28.
//
//   node scripts/roda-sql.mjs --projeto us --file MIGRATION_x.sql          # mostra o que faria
//   node scripts/roda-sql.mjs --projeto us --file MIGRATION_x.sql --confirmo   # roda
//   node scripts/roda-sql.mjs --projeto br --pergunta "select count(*) from rides"
//
// POR QUE ESTE ARQUIVO EXISTE (11/set/2026). A lei da casa é que o Márcio não roda
// SQL — "eu não vou rodar, rode vc, sempre". Mas o caminho que eu usava era raspar o
// token do dashboard de dentro do Chrome dele e empacotar a migration num `node -e`
// improvisado; frágil (o token expira, o navegador tem de estar aberto) e de forma
// esquisita, que é exatamente o que um portão de segurança olha de perto. Aqui a
// execução vira uma ferramenta NOMEADA, revisada e commitada, com a credencial lida
// de dentro do script e três travas: mostra antes, só roda com --confirmo, e
// `--pergunta` só aceita UM SELECT.
//
// ── A CREDENCIAL ────────────────────────────────────────────────────────────
// Vive fora do repositório, na memória da sessão, como todas as outras
// (ver a nota `full-db-access`): NUNCA em argv, NUNCA em URL, NUNCA impressa.
//   1º  memory/supabase-mgmt-token.txt   token pessoal do Supabase (sbp_…)
//       → Management API; roda como `postgres` (superusuário), faz DDL.
//   2º  memory/<us|br>-db-url.txt        string de conexão do Postgres
//       → só se o pacote `pg` estiver instalado; dá transação de verdade.
// Se as duas existirem, a Management API ganha — é a que não precisa de instalação.
//
// Conferir o efeito é OUTRA coisa, e continua valendo: depois de rodar, medir por
// fora, pela REST com a chave de serviço. Resposta de quem executou não é prova.

import fs from 'node:fs'
import path from 'node:path'

const MEM = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory'
const REF = { us: 'fvgpkbpqacnqxtrjsmpi', br: 'saaowriaptbvfoqoykrh' }

// ── argumentos, sem dependência ─────────────────────────────────────────────
const arg = (nome, curto) => {
  const i = process.argv.findIndex(a => a === '--' + nome || (curto && a === '-' + curto))
  return i > 0 ? process.argv[i + 1] : undefined
}
const tem = nome => process.argv.includes('--' + nome)

const projeto = String(arg('projeto') || '').toLowerCase()
const arquivo = arg('file')
const pergunta = arg('pergunta')
const confirmo = tem('confirmo')

const morre = m => { console.error('\n✖ ' + m + '\n'); process.exit(1) }

if (!REF[projeto]) morre('diga o projeto: --projeto us  ou  --projeto br')
if (!arquivo && !pergunta) morre('diga o que rodar: --file <arquivo.sql>  ou  --pergunta "select …"')
if (arquivo && pergunta) morre('--file e --pergunta não andam juntos')

// ── a trava do --pergunta: UM select, e nada mais ───────────────────────────
// Leitura tem de ser fácil (o pg_catalog só se lê por aqui), mas "fácil" não pode
// virar porta de escrita: qualquer coisa que não seja um único SELECT/WITH vai pro
// caminho do arquivo revisado.
if (pergunta) {
  const limpa = pergunta.trim().replace(/;+\s*$/, '')
  if (/;/.test(limpa)) morre('--pergunta aceita UMA consulta só (achei ponto-e-vírgula no meio)')
  if (!/^(select|with)\b/i.test(limpa)) morre('--pergunta só aceita SELECT (ou WITH … select). Escrita vai em arquivo .sql, com --confirmo.')
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|notify|do)\b/i.test(limpa)) morre('--pergunta tem palavra de escrita dentro. Escrita vai em arquivo .sql, com --confirmo.')
}

// ── o SQL ───────────────────────────────────────────────────────────────────
let sql, rotulo
if (arquivo) {
  const p = path.isAbsolute(arquivo) ? arquivo : path.resolve(process.cwd(), arquivo)
  if (!fs.existsSync(p)) morre('não achei o arquivo: ' + p)
  sql = fs.readFileSync(p, 'utf8')
  rotulo = path.basename(p)
} else {
  sql = pergunta
  rotulo = '(pergunta na linha de comando)'
}

// ── o que este SQL FAZ, dito antes de fazer ─────────────────────────────────
const semComentario = sql.replace(/^\s*--.*$/gm, '')
const escreve = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment on)\b/i.test(semComentario)
const temTransacao = /^\s*begin\s*;/im.test(semComentario) && /^\s*commit\s*;/im.test(semComentario)
// CONTAR COMANDO RESPEITANDO $$ … $$: quebrar no ponto-e-vírgula cru parte os blocos
// `do $$ … end $$` em pedaços e o resumo mente — dizia 56 comandos numa migration de
// 12. Resumo é peça de segurança: resumo que engana é pior que resumo nenhum.
// Dois lugares onde o ponto-e-vírgula NÃO separa comando: dentro de $$ … $$ e dentro
// de texto entre apóstrofos ('origin só GZ28US ou PERSONAL; quem pagou…' virava dois).
const comandosDe = texto => {
  const fora = []
  let atual = '', marca = null, aspa = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (aspa) {                                        // dentro de 'texto'
      atual += c
      if (c === "'") { if (texto[i + 1] === "'") { atual += "'"; i++ } else aspa = false }
      continue
    }
    if (marca) {                                       // dentro de $$ … $$
      if (texto.startsWith(marca, i)) { atual += marca; i += marca.length - 1; marca = null; continue }
      atual += c
      continue
    }
    const m = texto.slice(i).match(/^\$[A-Za-z_]*\$/)
    if (m) { marca = m[0]; atual += marca; i += marca.length - 1; continue }
    if (c === "'") { aspa = true; atual += c; continue }
    if (c === ';') { const t = atual.trim(); if (t) fora.push(t); atual = ''; continue }
    atual += c
  }
  const t = atual.trim()
  if (t) fora.push(t)
  return fora
}
const comandos = comandosDe(semComentario)

// ── FREIO DE MÃO (11/set/2026) ──────────────────────────────────────────────
// O Márcio deu acesso MÁXIMO: o token pessoal do Supabase age como ele na conta
// inteira — DDL como `postgres`, chaves dos projetos, configuração, apagar projeto.
// "Acesso máximo" não pode virar "acidente máximo", então o freio mora aqui, do lado
// da execução, e não na cabeça de quem digita:
//
//   1. CONFIGURAÇÃO DE SEGURANÇA É DELE, SEMPRE. Mexer em papel (role), em senha, no
//      esquema `auth`, em `alter system` ou em desligar RLS não passa por aqui nem
//      com --confirmo. Quem faz isso é ele, no painel. Foi assim com o cadastro
//      público em 11/set, e continua assim.
//   2. APAGAR PEDE DUAS CHAVES: `drop table`, `drop schema`, `truncate` e `delete`
//      sem `where` exigem --eu-sei-que-apaga E um arquivo ROLLBACK_*.sql do lado.
//      Migration de dinheiro sem volta escrita não roda.
const PROIBIDO = [
  [/\balter\s+system\b/i, 'alter system — configuração do servidor é do painel, não daqui'],
  [/\b(create|alter|drop)\s+role\b/i, 'mexer em ROLE (papel de acesso) é configuração de segurança: quem faz é o Márcio, no painel'],
  [/\b(create|alter|drop)\s+user\b/i, 'mexer em USER é configuração de segurança: quem faz é o Márcio, no painel'],
  [/\bpassword\s+'/i, 'senha em SQL não passa por aqui'],
  [/\bdisable\s+row\s+level\s+security\b/i, 'DESLIGAR RLS reabre o banco para a chave pública — isso é decisão dele, no painel'],
  [/\balter\s+table\s+[\w."]+\s+disable\s+row\b/i, 'DESLIGAR RLS reabre o banco para a chave pública — decisão dele, no painel'],
  [/\bauth\.(users|identities|sessions|refresh_tokens)\b/i, 'o esquema `auth` guarda as contas e as sessões: não se escreve nele por script'],
  [/\bpg_authid\b|\bpg_shadow\b/i, 'tabela de credencial do Postgres: nunca por aqui'],
]
for (const [re, porque] of PROIBIDO) {
  if (re.test(semComentario)) morre('este SQL toca em algo que eu não executo, nem com --confirmo:\n    ' + porque)
}

const APAGA = [
  [/\bdrop\s+table\b/i, 'drop table'],
  [/\bdrop\s+schema\b/i, 'drop schema'],
  [/\bdrop\s+(column|view|function|trigger|policy|index)\b/i, 'drop de objeto'],
  [/\btruncate\b/i, 'truncate'],
]
const apagaOque = APAGA.filter(([re]) => re.test(semComentario)).map(([, n]) => n)
// DELETE conta como apagar mesmo COM where: o FIC1650 é uma linha só, e é dinheiro
// (US$ 1.523,04). Linha de dinheiro apagada por engano não tem desfazer — pede as
// duas chaves igual a um drop. E `delete` sem where ganha nome próprio no aviso,
// porque esse leva a tabela inteira e não parece perigoso à primeira vista.
if (/\bdelete\s+from\b/i.test(semComentario)) {
  apagaOque.push(/\bdelete\s+from\s+[\w."]+\s*(;|$)/im.test(semComentario) ? 'delete SEM WHERE (tabela inteira)' : 'delete de linha')
}

const fmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/New_York', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

console.log(`\n── ${rotulo} → projeto ${projeto.toUpperCase()} (${REF[projeto]})`)
console.log(`   ${comandos.length} comando(s) · ${escreve ? 'ESCREVE no banco' : 'só leitura'}${escreve && !temTransacao ? ' · ⚠ SEM begin/commit no arquivo' : ''}${apagaOque.length ? ' · ⚠ APAGA: ' + apagaOque.join(', ') : ''}`)
console.log(`   ${fmt.format(new Date())} Orlando`)
for (const c of comandos.slice(0, 40)) console.log('     · ' + c.split('\n')[0].slice(0, 110))
if (comandos.length > 40) console.log(`     · …e mais ${comandos.length - 40}`)

if (escreve && !confirmo) {
  console.log('\n   NADA FOI EXECUTADO. Repita com --confirmo para rodar de verdade.\n')
  process.exit(0)
}

// A SEGUNDA CHAVE: apagar pede intenção escrita E volta escrita.
if (apagaOque.length) {
  if (!tem('eu-sei-que-apaga')) {
    morre([
      `este SQL APAGA (${apagaOque.join(', ')}).`,
      'Para rodar, além de --confirmo, passe --eu-sei-que-apaga.',
      'Duas chaves de propósito: apagar coisa de dinheiro por engano não tem desfazer.',
    ].join('\n    '))
  }
  if (arquivo) {
    const dir = path.dirname(path.isAbsolute(arquivo) ? arquivo : path.resolve(process.cwd(), arquivo))
    const base = path.basename(arquivo).replace(/^MIGRATION_/i, '')
    const volta = fs.existsSync(path.join(dir, 'ROLLBACK_' + base))
    if (!volta) morre(`este SQL apaga e não existe ROLLBACK_${base} do lado.\n    Escreva a volta primeiro: migration de dinheiro sem volta escrita não roda.`)
    console.log(`   ✓ ROLLBACK_${base} existe do lado — a volta está escrita.`)
  }
}
if (escreve && !temTransacao) {
  console.log('\n   ⚠ Este arquivo escreve e NÃO tem begin/commit: se um comando falhar no meio,')
  console.log('     o que passou antes fica. Seguindo porque você confirmou.\n')
}

// ── credencial: Management API primeiro ─────────────────────────────────────
const leSegredo = f => {
  const p = path.join(MEM, f)
  if (!fs.existsSync(p)) return null
  const v = fs.readFileSync(p, 'utf8').trim().split(/\s+/).pop()
  return v || null
}

const token = leSegredo('supabase-mgmt-token.txt')
const dbUrl = leSegredo(`${projeto}-db-url.txt`)

async function viaManagementApi() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF[projeto]}/database/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ query: sql }),
  })
  const corpo = await r.json().catch(() => null)
  return { ok: r.status >= 200 && r.status < 300, status: r.status, corpo, caminho: 'Management API' }
}

async function viaPostgres() {
  let pg
  try { pg = (await import('pg')).default } catch { return { ok: false, status: 0, corpo: { message: 'o pacote `pg` não está instalado (npm i -D pg)' }, caminho: 'Postgres' } }
  const cli = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  try {
    await cli.connect()
    const res = await cli.query(sql)
    const linhas = Array.isArray(res) ? res.flatMap(x => x.rows || []) : (res.rows || [])
    return { ok: true, status: 200, corpo: linhas, caminho: 'Postgres direto' }
  } catch (e) {
    return { ok: false, status: 0, corpo: { message: String(e?.message || e), detail: e?.detail, hint: e?.hint, where: e?.where }, caminho: 'Postgres direto' }
  } finally { try { await cli.end() } catch { /* já caiu */ } }
}

if (!token && !dbUrl) {
  morre([
    'não achei credencial nenhuma. Escolha um caminho:',
    '',
    '  A) TOKEN PESSOAL (recomendado, sem instalar nada)',
    '     supabase.com/dashboard/account/tokens → Generate new token',
    `     cole o sbp_… em  ${MEM}/supabase-mgmt-token.txt`,
    '     serve para os DOIS projetos, e roda como postgres (faz DDL).',
    '',
    '  B) STRING DE CONEXÃO (dá transação de verdade; pede `npm i -D pg`)',
    '     Supabase → Settings → Database → Connection string (pooler/session)',
    `     cole em  ${MEM}/${projeto}-db-url.txt`,
  ].join('\n'))
}

const r = token ? await viaManagementApi() : await viaPostgres()

console.log(`\n── resposta (${r.caminho}${r.status ? ', HTTP ' + r.status : ''})`)
if (!r.ok) {
  // A mensagem do Postgres é o que importa aqui — é ela que diz qual trava disparou.
  console.error(JSON.stringify(r.corpo, null, 1).slice(0, 4000))
  console.error('\n✖ NÃO rodou (ou rodou e falhou). Nada a comemorar: confira o banco por fora antes de concluir qualquer coisa.\n')
  process.exit(1)
}
const linhas = Array.isArray(r.corpo) ? r.corpo : (r.corpo ? [r.corpo] : [])
console.log(linhas.length ? JSON.stringify(linhas, null, 1).slice(0, 6000) : '(sem linhas devolvidas — é o normal de uma migration)')
console.log(`\n✓ executado. AGORA CONFIRA POR FORA, pela REST com a chave de serviço: resposta de quem executou não é prova.\n`)
