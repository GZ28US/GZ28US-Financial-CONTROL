// UM FORNECEDOR, UM NOME — módulo PURO (sem cliente Supabase, importável pelo
// browser e pelo servidor). Nasceu em lib/partsDb.ts (Márcio, 04/set/2026) e
// mudou pra cá no AUTO-BOOK fase B (BL 0.9.0): o motor do Bank Link precisa da
// MESMA chave de comparação pra escrever o nome do cadastro, nunca o texto cru
// do extrato ("Card Purchase Paypal *Summit 5533…" vira "Summit Racing Equipment").
// lib/partsDb.ts re-exporta tudo — nenhum comportamento mudou lá.

// "&" vira "and", sufixo societário cai, pontuação some. Sem isso
// "Texas Speed & Performance" e "Texas Speed and Performance" viravam dois
// fornecedores, e 28 peças ficaram sem o vínculo de official supplier.
export const normSup = (s: string) => (s || '').toLowerCase()
  .replace(/&/g, 'and')
  .replace(/\b(inc|llc|ltd|corp|incorporated|company)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '')

export type SupplierEntry = { name: string; keys: string[]; official: boolean }

// Diretório a partir das linhas de `suppliers` (name, aliases, is_dealership) —
// quem lê o banco (partsDb no browser, o motor no servidor) passa as linhas.
export function supplierDirectoryFrom(rows: any[] | null | undefined): SupplierEntry[] {
  return (rows || []).map((s: any) => ({
    name: s.name,
    official: s.is_dealership === true,
    // O campo `aliases` virou bloco de notas: alguns carregam PROSA separada por
    // vírgula, e o split por vírgula transformava isso em chaves de 129 caracteres
    // ("naoporemailopedido2226792eumacheckoutconfirmation..."). Toda linha com prosa
    // usa " — " antes do texto corrido, e nenhuma das que são só apelido usa
    // (conferido nas 10 linhas de alias longo dos dois bancos, 07/set/2026).
    // Corta-se ali E descarta-se chave com mais de 40 caracteres: no US a prosa
    // usa DOIS-PONTOS, não travessão ("nao por e-mail: o pedido #2226792 e uma
    // CHECKOUT CONFIRMATION do site…"), e gerava uma chave de 134. Apelido de
    // fornecedor não passa de 40 caracteres; acima disso é recado, não nome.
    keys: [s.name, ...String(s.aliases || '').split(/[\n,]/).map((x: string) => x.split(' — ')[0])]
      .map(normSup).filter(k => k && k.length <= 40),
  }))
}

// Resolve QUALQUER grafia para o fornecedor cadastrado. Primeiro a chave exata
// (nome ou alias); depois PREFIXO — uma grafia com endereço colado
// ("Titan Motorsports, 11370 Boggy Creek Rd...") ou com parêntese
// ("High Horse Performance (HHP Racing)") COMEÇA pela chave.
//
// Prefixo, e não contenção em qualquer posição: um alias do AutoZone trazia o
// endereço da loja, o split por vírgula gerou a chave "orlando", e ela casava
// no MEIO do endereço da Titan — dois candidatos, fornecedor errado no chute.
// Nome de empresa vem na frente; endereço vem depois. Exige 6+ caracteres e
// resposta ÚNICA: com duas candidatas devolve null em vez de adivinhar.
export function matchSupplier(nome: string | null | undefined, dir: SupplierEntry[]): SupplierEntry | null {
  const n = normSup(String(nome || ''))
  if (!n) return null
  const exato = dir.find(d => d.keys.includes(n))
  if (exato) return exato
  // DUAS TRAVAS no prefixo (07/set/2026), medidas contra as 459 grafias reais (310 US + 149 BR, 2.799 linhas) —
  // sem elas o casamento INVENTA nome:
  //   • "Mileide de Lima Brito" (2 linhas) casava com o cadastro "Mileide" e
  //     perdia o nome legal de uma pessoa. Nome de PESSOA não casa por prefixo:
  //     o resto do nome é sobrenome, não endereço, e cortar sobrenome é apagar
  //     identidade. Nome de empresa continua casando por exato.
  //   • "TRE Performance" (3 linhas) casava com o cadastro "TREperformance.com"
  //     e virava URL como nome de fornecedor. Chave que é DOMÍNIO só casa por
  //     prefixo com candidato que também é domínio.
  // Filosofia da função, mantida: na dúvida devolve null em vez de adivinhar.
  const cru = String(nome || '').trim()
  // Pessoa é ALFABÉTICA: "VILLAGGIO 10 POSTO DE SERVICOS" também tem "DE" e 3
  // palavras, e a trava crua o transformava em null — 2 linhas perdidas. Dígito
  // ou forma jurídica no nome ⇒ é empresa, e empresa casa por prefixo normalmente.
  const juridica = new RegExp('\\b(ltda|me|epp|eireli|sa|llc|inc|ltd|corp|gmbh)\\b', 'i').test(cru)
  const pessoa = !/[0-9]/.test(cru) && !juridica
    && new RegExp('\\b(de|da|do|dos|das)\\b', 'i').test(cru)
    && cru.split(/\s+/).length >= 3
  const dominio = (k: string) => /(com|combr|net|org)$/.test(k)
  const ehDominio = dominio(n)
  const prefixo = pessoa ? [] : dir.filter(d => d.keys.some(k =>
    k.length >= 6 && (dominio(k) ? ehDominio : true) && (n.startsWith(k) || k.startsWith(n))))
  return prefixo.length === 1 ? prefixo[0] : null
}
