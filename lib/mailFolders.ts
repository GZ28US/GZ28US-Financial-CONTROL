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
// ⚠️ O QUE O 400 PODE E O QUE NÃO PODE DIZER (conserto de 11/set, depois da
// revisão): nome não reconhecido NÃO quer dizer "a pasta não existe". Pasta de
// caso existe e é só ilistável POR NOME — o Graph endereça pasta pelo nome
// bem-conhecido ou pelo id, e o Gmail só pelo id do rótulo ([[mail-processed-watermark]]:
// "op=list&folder=<nome> só funciona com nome bem-conhecido"). O texto do erro
// fala do ENDEREÇO, nunca da existência, senão a sessão lê "sumiu" e vai caçar
// no lugar errado — que é exatamente o defeito que esta fatia veio matar.
//
// (A `mail-file` tem o mapa dela, `BEM_CONHECIDAS`, para outra coisa: lá o nome
// serve para CRIAR pasta por caminho. Aqui só se traduz e se valida o que já
// existe — não se cria nada. Os nomes que os dois entendem são os mesmos,
// "arquivo morto" incluído, para o que se arquiva poder ser conferido.)

export type ProvedorDeMail = 'graph' | 'gmail'

// `gmail: null` = o lugar existe no Outlook e NÃO tem equivalente listável no
// Gmail (o caso do arquivo morto: lá arquivar é tirar o rótulo INBOX).
type Pasta = { graph: string; gmail: string | null; nomes: string[] }

// Os lugares que toda caixa tem e que as rodadas de e-mail pedem pelo nome
// ([[email-round-process]]): entrada, lixo eletrônico, lixeira, enviados,
// rascunhos e o arquivo morto. Pasta/label de caso vai sempre pelo id do
// `op=folders`.
const PASTAS: Pasta[] = [
  { graph: 'inbox', gmail: 'INBOX', nomes: ['inbox', 'caixa de entrada', 'entrada'] },
  { graph: 'junkemail', gmail: 'SPAM', nomes: ['junkemail', 'junk', 'junk email', 'spam', 'lixo eletronico', 'lixo'] },
  { graph: 'deleteditems', gmail: 'TRASH', nomes: ['deleteditems', 'deleted', 'deleted items', 'trash', 'lixeira', 'excluidos', 'itens excluidos'] },
  { graph: 'sentitems', gmail: 'SENT', nomes: ['sentitems', 'sent', 'sent items', 'enviados', 'itens enviados'] },
  { graph: 'drafts', gmail: 'DRAFT', nomes: ['drafts', 'draft', 'rascunhos', 'rascunho'] },
  // "arquivo morto" é o nome que a casa usa e que a `mail-file` já aceita desde
  // o conserto da pasta fantasma: quem arquiva por lá TEM que conseguir conferir
  // por aqui com o mesmo nome.
  { graph: 'archive', gmail: null, nomes: ['archive', 'arquivo morto', 'arquivo', 'arquivados'] },
]

// Nomes reservados do Graph que não estão na tabela acima — quem já chama com
// eles continua passando direto, o contrato não muda.
const GRAPH_BEM_CONHECIDAS = [
  'clutter', 'conflicts', 'conversationhistory', 'localfailures',
  'msgfolderroot', 'outbox', 'recoverableitemsdeletions', 'scheduled',
  'searchfolders', 'serverfailures', 'syncissues',
]

// Labels de sistema do Gmail (os de usuário são `Label_<n>`).
const GMAIL_DO_SISTEMA = [
  'INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT', 'STARRED', 'IMPORTANT', 'UNREAD', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]

const validasDoGraph = () => [...PASTAS.map(p => p.graph), ...GRAPH_BEM_CONHECIDAS]
const validasDoGmail = () => [
  ...PASTAS.map(p => p.gmail).filter((g): g is string => !!g),
  ...GMAIL_DO_SISTEMA.filter(l => !PASTAS.some(p => p.gmail === l)),
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
  const recebido = String(bruto ?? '')
  const cru = recebido.trim()
  // Só quem NÃO PEDIU pasta nenhuma (parâmetro ausente ou vazio) cai na caixa de
  // entrada. `folder=%20` — o script que montou a URL com a variável vazia —
  // PEDIU alguma coisa e não pode ser atendido calado com outra pasta: 400.
  // "Listei outra pasta sem avisar" é o defeito que esta função veio consertar.
  if (!cru) {
    if (recebido.length) {
      return {
        ok: false,
        motivo: 'folder veio só com espaço em branco — a variável que montou a URL está vazia; mande o nome da pasta ou não mande o parâmetro (aí vale a caixa de entrada)',
        validas: provedor === 'gmail' ? validasDoGmail() : validasDoGraph(),
      }
    }
    return { ok: true, folder: provedor === 'gmail' ? 'INBOX' : 'inbox', traduzida: false }
  }
  const k = chave(cru)

  const hit = PASTAS.find(p => p.nomes.includes(k))
  if (hit) {
    const folder = provedor === 'gmail' ? hit.gmail : hit.graph
    // Lugar que existe num provedor e não no outro (arquivo morto no Gmail):
    // dizer O PORQUÊ, não fingir que o nome é inválido.
    if (!folder) {
      return {
        ok: false,
        motivo: `"${cru}" não se lista numa caixa Gmail — lá arquivar é TIRAR o rótulo INBOX, não há pasta de arquivo morto; o que foi arquivado aparece pelo id do rótulo em op=folders`,
        validas: validasDoGmail(),
      }
    }
    return { ok: true, folder, traduzida: folder !== cru }
  }

  if (provedor === 'graph') {
    const colado = k.replace(/\s+/g, '')
    if (GRAPH_BEM_CONHECIDAS.includes(colado)) return { ok: true, folder: colado, traduzida: colado !== cru }
    if (pareceIdDoGraph(cru)) return { ok: true, folder: cru, traduzida: false }
    return {
      ok: false,
      // NÃO diz "não existe": pasta de caso existe e só não se endereça por nome.
      motivo: `"${cru}" não é nome que uma caixa Outlook enderece — o Graph aceita nome BEM-CONHECIDO ou id; pasta sua existe, mas só se lista pelo id que o op=folders devolve`,
      validas: validasDoGraph(),
    }
  }

  // Gmail: label de usuário é `Label_<n>`; label de sistema é MAIÚSCULO.
  const rotuloDeUsuario = cru.match(/^label[_ ]?(\d+)$/i)
  if (rotuloDeUsuario) return { ok: true, folder: `Label_${rotuloDeUsuario[1]}`, traduzida: `Label_${rotuloDeUsuario[1]}` !== cru }
  const sistema = GMAIL_DO_SISTEMA.find(l => l.toLowerCase() === k.replace(/\s+/g, '_'))
  if (sistema) return { ok: true, folder: sistema, traduzida: sistema !== cru }
  return {
    ok: false,
    // Idem: o rótulo pode existir; o que não dá é endereçá-lo pelo NOME.
    motivo: `não dá para listar o rótulo "${cru}" pelo nome numa caixa Gmail — rótulo de usuário vai pelo id (Label_16), que vem no op=folders`,
    validas: validasDoGmail(),
  }
}

// ── O TERMO DO $search DO GRAPH ─────────────────────────────────────────────
// A rota embrulha o termo em aspas (`$search="..."`), então aspa DENTRO do `q`
// quebra o KQL. Tirar é o que ele decidiu ("o Graph aceita a expressão sem
// elas"). Duas regras, porque a aspa tem dois papéis:
//
//   • aspa colada num operador de campo (`subject:"doc fee"`, `from:"x@y.com"`)
//     é APAGADA, não vira espaço: trocar por espaço descola o `subject:` do
//     valor (`subject: doc fee`) e fabrica um erro de KQL que a rota depois
//     ainda culparia quem chamou. Vira `subject:doc fee`;
//   • aspa solta em volta de frase vira espaço e some.
//
// ⚠️ A VERDADE DO QUE ISSO FAZ: sem as aspas a busca deixa de ser por FRASE
// EXATA e passa a ser pelas palavras (como o KQL as combina é dele). `"eBay
// Commerce Inc"` pode voltar MAIS e-mail do que a frase — por isso a rota
// devolve `quotesRemoved` junto de um aviso em texto, e quem quiser tentar a
// frase exata pede `phrase=1` (ver a rota).
export function termoDeBuscaGraph(bruto: string): { termo: string; aspasRemovidas: boolean } {
  const cru = String(bruto || '')
  const termo = cru
    .replace(/:\s*["“”„«»]+/g, ':')
    .replace(/["“”„«»]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return { termo, aspasRemovidas: termo !== cru.trim() }
}
