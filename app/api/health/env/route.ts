import { NextRequest, NextResponse } from 'next/server'

// QUAIS CHAVES ESTE APP PRECISA, E QUAIS ESTÃO PUBLICADAS.
//
// ── O CASO QUE PEDIU ESTA ROTA (09/set/2026) ────────────────────────────────
// O robô de rastreio do app BR NUNCA rodou. O código estava lá, o cron estava no
// `vercel.json` rodando de hora em hora aos :37, a peneira estava certa — só
// faltava `TRACK17_API_KEY` no ambiente daquele projeto. Medido nas duas bases:
// 91% das linhas com rastreio no US têm entrega registrada, contra 35% no BR.
// Meses assim, e ninguém soube, porque a rota respondia HTTP 200 com
// `{ok:false}` e o cron da Vercel conta 200 como sucesso.
//
// Falta de configuração não dá erro: dá SILÊNCIO. É a mesma família do feed
// mudo do Regions ("sync diz DONE e traz ZERO há 4 dias") e do mail-poll que
// morreu por quatro dias sem uma linha de log. Por isso esta rota existe e é
// chata de propósito: ela lista o que falta ANTES de o cliente descobrir.
//
// NUNCA devolve valor de variável — só se existe e o tamanho, que é o bastante
// para diferenciar "vazia" de "publicada" sem vazar segredo em log nenhum.
//
// A lista abaixo saiu de um `grep -rhoE "process\.env\.[A-Z0-9_]+" app lib` em
// 09/set/2026. Para atualizar, rode o mesmo grep e compare — o que o código lê
// e não está aqui é justamente o próximo buraco silencioso.


// ── O QUE ESTA ROTA NÃO SABE, E É O PONTO MAIS IMPORTANTE DELA ─────────────
// Ela mede PUBLICAÇÃO, não TRABALHO. Variável presente não prova que o robô
// fez alguma coisa; variável ausente não prova que deixou de fazer.
//
// O caso que ensinou isso, no mesmo dia em que a rota nasceu: faltando
// `CRON_SECRET` no BR, três crons de lá respondem 401. Escrevi que eram "três
// robôs mortos" — e um deles, o `whatsapp-sync`, não custa NADA. O espelho do
// WhatsApp é centralizado no banco do US, com uma coluna `app` separando as
// duas instâncias: 74.375 mensagens lá (26.524 US + 47.851 BR) contra ZERO nas
// tabelas do banco do BR, que nasceram com o schema e nunca receberam nada.
// A rota de lá devolve 401 há meses e não se perdeu uma mensagem.
//
// Por isso o texto de cada variável abaixo diz QUEM A LÊ, e não o que quebra.
// Consequência é conclusão, e conclusão se mede no dado — não se declara numa
// tabela de configuração. Uma rota de saúde que declara estrago que não
// mediu vira a próxima geradora de alarme falso, que é justamente o que ela
// nasceu para matar.

export const dynamic = 'force-dynamic'

// SEM ESTAS, ALGUMA COISA DEIXA DE ACONTECER — e sem barulho.
const ESSENCIAIS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'lida por todo o app — é o banco deste projeto',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'lida pelo navegador',
  SUPABASE_SERVICE_ROLE_KEY: 'lida por tudo que roda no servidor (RLS não se aplica)',
  CRON_SECRET: 'lida pelas rotas de cron para autorizar a chamada da Vercel',
  DROPBOX_APP_KEY: 'lida pelas rotas de pasta (carro e invoice)',
  DROPBOX_APP_SECRET: 'idem',
  DROPBOX_REFRESH_TOKEN: 'idem — é o que renova o acesso',
  TRACK17_API_KEY: 'lida pelo rastreio de entrega dos itens (17TRACK)',
  ANTHROPIC_API_KEY: 'lida pela leitura de recibo, de e-mail e de nota',
  WHATSAPP_READ_KEY: 'lida pelas portas de leitura do assistente',
  ULTRAMSG_INSTANCE: 'lida pelo envio de WhatsApp',
  ULTRAMSG_TOKEN: 'idem',
  ULTRAMSG_GROUP_ID: 'lida pelo envio ao grupo REPORTS',
  PLAID_CLIENT_ID: 'lida pelo feed do banco',
  PLAID_SECRET: 'idem',
  PLAID_ENV: 'idem',
  FINANCEIRO_KEY: 'lida pelo webhook do financeiro 24/7',
}

// A falta destas TIRA UM PEDAÇO, mas o resto do app segue de pé.
const OPCIONAIS: Record<string, string> = {
  SUPABASE_BR_SERVICE_ROLE_KEY: 'a varredura de papel responde as invoices do BR',
  BR_BRIDGE_EMAIL: 'ponte com o banco do BR pela tela',
  BR_BRIDGE_PASSWORD: 'idem',
  NEXT_PUBLIC_SUPABASE_BR_URL: 'espelhos no BR',
  NEXT_PUBLIC_SUPABASE_BR_ANON_KEY: 'idem',
  GZ28BR_BASE_URL: 'chamadas ao app do BR',
  GZ28_SELF_URL: 'o app chamando a si mesmo (scan-receipt)',
  GOOGLE_CLIENT_ID: 'caixas de e-mail do Gmail',
  GOOGLE_CLIENT_SECRET: 'idem',
  ULTRAMSG_STAFF_GROUP_ID: 'grupo do staff',
  STT_API_KEY: 'transcrição de áudio do WhatsApp',
  STT_BASE_URL: 'idem',
  STT_MODEL: 'idem',
  BRL_USD_RATE: 'câmbio de emergência quando a cotação não responde',
}

const olhar = (nomes: Record<string, string>) => {
  const presentes: string[] = []
  const faltando: { nome: string; para: string }[] = []
  const vazias: string[] = []
  for (const [nome, para] of Object.entries(nomes)) {
    const v = process.env[nome]
    if (v == null) faltando.push({ nome, para })
    else if (!String(v).trim()) vazias.push(nome)      // publicada e VAZIA engana mais que ausente
    else presentes.push(nome)
  }
  return { presentes, vazias, faltando }
}

export async function GET(req: NextRequest) {
  const need = process.env.WHATSAPP_READ_KEY
  if (!need || req.nextUrl.searchParams.get('key') !== need) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ess = olhar(ESSENCIAIS)
  const opc = olhar(OPCIONAIS)
  // HTTP 500 quando falta ESSENCIAL: quem monitorar esta rota tem de ver
  // vermelho, não um 200 dizendo "ok:false" que todo mundo engole.
  const status = ess.faltando.length || ess.vazias.length ? 500 : 200
  return NextResponse.json({
    app: 'GZ28US',
    ok: status === 200,
    essenciais: { faltando: ess.faltando, vazias: ess.vazias, presentes: ess.presentes.length },
    opcionais: { faltando: opc.faltando.map(f => f.nome), vazias: opc.vazias, presentes: opc.presentes.length },
    limite: 'esta rota mede PUBLICAÇÃO, não TRABALHO: presente não prova que o robô fez algo, ausente não prova que deixou de fazer',
  }, { status })
}
