// LER O ARQUIVO QUE ESTÁ NA PASTA — a metade que faltava.
//
// Medido pela sessão PESCA/AutoBook em 09/set/2026: `grep -rn "files/download"`
// devolvia ZERO no app inteiro. A rota `/api/ride-folder` vai do BANCO para o
// ARQUIVO (cria pasta, nomeia, sobe, apaga duplicata); a direção contrária —
// arquivo para banco — nunca existiu. O robô sabia ACHAR o PDF na pasta desde
// 08/set e não sabia ABRIR.
//
// Por que isso trava o passo 7 do AutoBook (spec dele, 09/set): a caça na pasta
// responde QUAL invoice, mas o e-mail só traz o TOTAL. Lançar 1.290,93 como
// preço único quebraria `price × qty + tax + extra` e contaminaria o custo
// unitário no Parts DB — foi por isso que a caça nasceu sem lançar sozinha. O
// PDF que ele salvou na pasta é que tem a linha detalhada: item, quantidade,
// desconto, imposto, frete. As duas metades se completam — a pasta diz ONDE, o
// documento diz O QUÊ. Sozinhas nenhuma basta; juntas, bastam.

const CONTENT = 'https://content.dropboxapi.com/2/files/download'

async function token(): Promise<string> {
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN || '',
      client_id: process.env.DROPBOX_APP_KEY || '',
      client_secret: process.env.DROPBOX_APP_SECRET || '',
    }).toString(),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error('Dropbox auth falhou: ' + JSON.stringify(j).slice(0, 200))
  return j.access_token
}

const TIPO: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
}

/** O que o leitor de recibo aceita — o resto não adianta baixar. */
export function tipoDeArquivo(nome: string): string | null {
  const ext = (nome.split('?')[0].split('.').pop() || '').toLowerCase()
  return TIPO[ext] || null
}

export type ArquivoDaPasta = {
  path: string
  nome: string
  mediaType: string
  base64: string
  bytes: number
}

/**
 * Baixa UM arquivo do Dropbox pelo caminho e devolve pronto para o
 * `/api/scan-receipt` (base64 + mediaType).
 *
 * O caminho vai no CABEÇALHO `Dropbox-API-Arg`, que é ISO-8859-1 — mesma
 * armadilha que fez pasta com acento nascer torta em 08/set. Escapa-se tudo que
 * passa de ASCII, exatamente como no upload.
 *
 * Teto de 12 MB: nota fiscal não pesa isso, e um PDF gigante estoura a memória
 * da função antes de o leitor ver a primeira linha.
 */
export async function baixarDaPasta(path: string, tetoMB = 12): Promise<ArquivoDaPasta> {
  const nome = path.split('/').pop() || 'arquivo'
  const mediaType = tipoDeArquivo(nome)
  if (!mediaType) throw new Error(`tipo não legível para recibo: ${nome}`)
  const tk = await token()
  const arg = JSON.stringify({ path })
    .replace(/[^ -~]/g, (c) => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  const res = await fetch(CONTENT, { method: 'POST', headers: { Authorization: `Bearer ${tk}`, 'Dropbox-API-Arg': arg } })
  if (!res.ok) throw new Error(`Dropbox download ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > tetoMB * 1024 * 1024) throw new Error(`arquivo grande demais (${(buf.length / 1048576).toFixed(1)} MB)`)
  return { path, nome, mediaType, base64: buf.toString('base64'), bytes: buf.length }
}
