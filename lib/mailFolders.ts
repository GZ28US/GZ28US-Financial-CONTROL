// ── O MESMO PEDIDO, DOIS PROVEDORES: NOME DE PASTA E TERMO DE BUSCA ─────────
// (item 9 do PACOTE, decidido por ele em 11/set/2026: tirar as aspas do `q` e
// devolver 400 com o motivo em vez de 502 — vale para o nome de pasta também)
//
// Duas armadilhas da mesma classe derrubavam a `mail-query` com 502 — erro que
// parece falha do app e faz script sem checagem ler "zero resultados":
//
// 1) ASPAS NO TERMO. O ramo Graph já embrulha o `q` inteiro no `$search="..."`;
//    aspa dentro dele quebra o KQL. Medido em 10/set 20:53 Orlando: `q="Destroyer
//    Grey"` devolveu 502 `An identifier was expected at position 0.`, e o mesmo
//    termo sem aspas devolveu 200. O que quebra é SÓ a aspa — janela por data
//    continua valendo dentro do embrulho (`paypal received:2026-05-13..2026-05-14`
//    voltou 9 resultados no mesmo dia).
//
// 2) NOME DE PASTA DO OUTRO PROVEDOR. O Lixo Eletrônico é `junkemail` no Outlook
//    e `SPAM` (maiúsculo) no Gmail. Medido no log da Vercel em 11/set, sobre o
//    alerta de 5xx de 10/set: às 17:46 Orlando uma varredura do lixo de todas as
//    caixas pediu `folder=spam` na caixa 1 (Outlook) e `folder=junkemail`/`spam`
//    nas caixas 4 e 5 (Gmail) — cinco dos sete 502. No Gmail o erro era ainda
//    mais traiçoeiro antes do commit `4e78812`: label errada voltava 200 com
//    lista VAZIA, calada.
//
// A tradução mora aqui, num lugar só: quem chama diz "spam", "lixeira" ou
// "enviados" e não precisa saber de que provedor é a caixa
// ([[claudinha-is-an-interface]]). Nome que ninguém reconhece não vira mais 502:
// a rota devolve 400 dizendo quais valem NAQUELA caixa.
//
// (A `mail-file` tem o mapa dela, `BEM_CONHECIDAS`, para outra coisa: lá o nome
// serve para CRIAR pasta por caminho. Aqui só se traduz e se valida o que já
// existe — não se cria nada.)

export type ProvedorDeMail = 'graph' | 'gmail'

type Pasta = { graph: string; gmail: string; nomes: string[] }

// Os cinco lugares que toda caixa tem e que as rodadas de e-mail pedem pelo
// nome ([[email-round-process]]): entrada, lixo eletrônico, lixeira, enviados e
// rascunhos. Pasta/label de caso vai sempre pelo id do `op=folders`.
const PASTAS: Pasta[] = [
  { graph: 'inbox', gmail: 'INBOX', nomes: ['inbox', 'caixa de entrada', 'entrada'] },
  { graph: 'junkemail', gmail: 'SPAM', nomes: ['junkemail', 'junk', 'junk email', 'spam', 'lixo eletronico', 'lixo'] },
  { graph: 'deleteditems', gmail: 'TRASH', nomes: ['deleteditems', 'deleted', 'deleted items', 'trash', 'lixeira', 'excluidos', 'itens excluidos'] },
  { graph: 'sentitems', gmail: 'SENT', nomes: ['sentitems', 'sent', 'sent items', 'enviados', 'itens enviados'] },
  { graph: 'drafts', gmail: 'DRAFT', nomes: ['drafts', 'draft', 'rascunhos', 'rascunho'] },
]

// Nomes reservados do Graph que não estão na tabela acima — quem já chama com
// eles continua passando direto, o contrato não muda.
const GRAPH_BEM_CONHECIDAS = [
  'archive', 'clutter', 'conflicts', 'conversationhistory', 'localfailures',
  'msgfolderroot', 'outbox', 'recoverableitemsdeletions', 'scheduled',
  'searchfolders', 'serverfailures', 'syncissues',
]

// Labels de sistema do Gmail (os de usuário são `Label_<n>`).
const GMAIL_DO_SISTEMA = [
  'INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT', 'STARRED', 'IMPORTANT', 'UNREAD', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]

// "Lixo Eletrônico", "lixo_eletronico" e "LIXO ELETRONICO" são a mesma coisa:
// minúsculas, sem acento (NFD separa a marca do acento, e o corte de não-ASCII
// leva só a marca embora), `-`/`_` viram espaço e espaço repetido colapsa.
const chave = (s: string) =>
  s.normalize('NFD').replace(/[^\x00-\x7F]/g, '')
    .toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()

export type PastaResolvida =
  | { ok: true; folder: string; traduzida: boolean }
  | { ok: false; motivo: string; validas: string[] }

// Id de pasta do Graph é base64 longo e com maiúsculas ("AQMkADAw...") — nome
// bem-conhecido é só letra minúscula. É assim que se separa um do outro sem
// chamar o provedor: id passa direto, nome errado cai no 400.
const pareceIdDoGraph = (v: string) => /^[A-Za-z0-9_+/=-]{16,}$/.test(v) && /[A-Z]/.test(v)

export function pastaDoProvedor(bruto: string, provedor: ProvedorDeMail): PastaResolvida {
  const cru = String(bruto || '').trim()
  // Só quem não pediu pasta nenhuma cai na caixa de entrada. Nome que existe e
  // não foi reconhecido TEM que dar 400 — "listei outra pasta calado" é o
  // defeito que esta função veio consertar.
  if (!cru) return { ok: true, folder: provedor === 'gmail' ? 'INBOX' : 'inbox', traduzida: false }
  const k = chave(cru)

  const hit = PASTAS.find(p => p.nomes.includes(k))
  if (hit) {
    const folder = provedor === 'gmail' ? hit.gmail : hit.graph
    return { ok: true, folder, traduzida: folder !== cru }
  }

  if (provedor === 'graph') {
    const colado = k.replace(/\s+/g, '')
    if (GRAPH_BEM_CONHECIDAS.includes(colado)) return { ok: true, folder: colado, traduzida: colado !== cru }
    if (pareceIdDoGraph(cru)) return { ok: true, folder: cru, traduzida: false }
    return {
      ok: false,
      motivo: `pasta "${cru}" não existe numa caixa Outlook — para uma pasta sua, mande o id que o op=folders devolve, não o nome`,
      validas: [...PASTAS.map(p => p.graph), ...GRAPH_BEM_CONHECIDAS],
    }
  }

  // Gmail: label de usuário é `Label_<n>`; label de sistema é MAIÚSCULO.
  const rotuloDeUsuario = cru.match(/^label[_ ]?(\d+)$/i)
  if (rotuloDeUsuario) return { ok: true, folder: `Label_${rotuloDeUsuario[1]}`, traduzida: `Label_${rotuloDeUsuario[1]}` !== cru }
  const sistema = GMAIL_DO_SISTEMA.find(l => l.toLowerCase() === k.replace(/\s+/g, '_'))
  if (sistema) return { ok: true, folder: sistema, traduzida: sistema !== cru }
  return {
    ok: false,
    motivo: `label "${cru}" não existe numa caixa Gmail — no Gmail a pasta é RÓTULO, e o de usuário vai pelo id (Label_16), nunca pelo nome`,
    validas: [...PASTAS.map(p => p.gmail), ...GMAIL_DO_SISTEMA.filter(l => !PASTAS.some(p => p.gmail === l))],
  }
}

// O `$search` do Graph já nasce embrulhado em aspas na rota; aspa dentro do
// termo quebra o KQL. Tirar é o que ele decidiu ("o Graph aceita a expressão sem
// elas") — o efeito é buscar as palavras em vez da frase exata, e a janela
// `received:AAAA-MM-DD..AAAA-MM-DD` continua funcionando igual.
export function termoDeBuscaGraph(bruto: string): { termo: string; aspasRemovidas: boolean } {
  const cru = String(bruto || '')
  const termo = cru.replace(/["“”„«»]/g, ' ').replace(/\s+/g, ' ').trim()
  return { termo, aspasRemovidas: termo !== cru.trim() }
}
