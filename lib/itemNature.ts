// ── O QUE É ESTA LINHA? O degrau que faltava ANTES de "chegou?" ─────────────
// Ordem do Márcio (04/set/2026): "veja os bought, tem um monte de coisa lá que
// não era pra ter stream... não faz sentido nenhum uma wire estar como bought...
// matemos o problema na raiz, não fazer remendo."
//
// O DIAGNÓSTICO, medido nas 6 tabelas: dos 501 BOUGHT (US$ 1.311.140,83), 197
// linhas nunca vão chegar de caminhão — e são 80% do DINHEIRO da aba. Só a
// categoria CARRO (wire, parcela e depósito de dealer) são 33 linhas e
// US$ 967.418,02, ou seja 74% de tudo. Um Demon 170 de $143 mil aparecia na
// mesma lista que um jogo de velas.
//
// A CAUSA não é bug: `deriveDeliverStatus` só sabe perguntar "pagou?" — e
// responde certo. Faltava a pergunta anterior. Sem ela, todo custo pago vira
// BOUGHT por construção, e BOUGHT deixou de ser fila de espera para virar
// depósito (184 das 501 já passaram de 180 dias).
//
// ── A REGRA ─────────────────────────────────────────────────────────────────
//   PEÇA    — coisa física que vem pra cá. SÓ ELA TEM STREAM.
//   SERVIÇO — trabalho feito: dyno, tune de bancada, porting, retífica, frete
//             contratado, guincho, lavagem, envelopamento, empilhadeira.
//   DIGITAL — licença, crédito, desbloqueio de ECU, tune que chega por e-mail.
//   ENCARGO — imposto, frete da encomenda, handling, seguro, taxa. É preço da
//             compra, não é uma segunda compra.
//   DINHEIRO— wire, depósito, parcela de carro, parcela de pack, repasse entre
//             as empresas, tarifa de banco.
//
// Cinco palavras e não quatro porque o app JÁ se comporta diferente nas cinco:
// PEÇA entra no catálogo e no robô do rastreio; ENCARGO entra como `is_extra`;
// DINHEIRO nunca entra; SERVIÇO tem `category='LABOR'` no catálogo; e DIGITAL é
// o único "não chega" que se ESPERA — dá pra listá-lo um dia sem migration nova.
//
// ── O FORNECEDOR DÁ O PALPITE, A LINHA DÁ A RESPOSTA ────────────────────────
// Medido: o mesmo fornecedor vende naturezas opostas. Kramer AutoPlex tem 5
// linhas de carro e uma de "Taxes & Fees"; Texas Speed vende peça e cobra frete;
// HHP vende 3 tunes digitais e vende vela NGK; Kong vende blower e cobra
// "SuperCharger Porting"; e "RSPDMV" parece órgão de trânsito mas é um tune de
// US$ 1.000. Por isso `suppliers.default_nature` só PRÉ-SELECIONA na tela.
// São 260 grafias de fornecedor em texto livre contra 45 no cadastro: fornecedor
// como resposta nasceria cego em 5 de cada 6 nomes.
//
// ── MÓDULO PURO DE PROPÓSITO ────────────────────────────────────────────────
// Sem banco, sem rede, sem React — igual a lib/deliverStatus.ts. As telas, o robô
// do rastreio, o scan e a ponte de e-mail têm de responder exatamente a mesma
// coisa, e a única forma de garantir isso é ninguém mais decidir em lugar nenhum.

export const NATURES = ['PART', 'SERVICE', 'DIGITAL', 'CHARGE', 'MONEY'] as const
export type Nature = (typeof NATURES)[number]

export function normNature(v: string | null | undefined): Nature | null {
  const s = String(v || '').trim().toUpperCase()
  return (NATURES as readonly string[]).includes(s) ? (s as Nature) : null
}

// ── "ISSO VIAJA?" ───────────────────────────────────────────────────────────
// BRANCO VIAJA. Esta é a decisão mais importante do módulo, e ela é deliberada:
// os dois erros não custam a mesma coisa.
//   Poluir  — uma tarifa de wire de $30 aparece no BOUGHT. Custo: barulho numa
//             tela. O erro é VISÍVEL e morre num clique; a poluição vira a
//             própria lista de tarefas.
//   Sumir   — um kit ProCharger de US$ 8.664,79 desaparece da única tela que
//             mostra o que a oficina está esperando. Custo: carro parado e
//             cliente ligando. E o erro é INVISÍVEL: ausência não se percebe.
// Por isso a assimetria: regra automática pode PÔR badge, nunca TIRAR.
// NULL não é chute — é a afirmação honesta "ninguém disse ainda".
export const travels = (v: string | null | undefined): boolean => {
  const n = normNature(v)
  return n === null || n === 'PART'
}

// A linha que ainda não foi classificada — é a fila do card de /adm/check.
export const needsNature = (v: string | null | undefined): boolean => normNature(v) === null

// Rótulos das telas. Português nos dois apps: quem classifica é a casa, não o
// cliente (o app US é em inglês para o CLIENTE; isto é ferramenta interna).
export const NATURE_LABEL: Record<Nature, string> = {
  PART: 'PEÇA',
  SERVICE: 'SERVIÇO',
  DIGITAL: 'DIGITAL',
  CHARGE: 'ENCARGO',
  MONEY: 'DINHEIRO',
}

export const NATURE_HINT: Record<Nature, string> = {
  PART: 'Coisa física que vem pra cá. É a única que entra no STREAM.',
  SERVICE: 'Trabalho feito: dyno, tune de bancada, porting, retífica, frete contratado, lavagem.',
  DIGITAL: 'Licença, crédito, desbloqueio de ECU, tune que chega por e-mail.',
  CHARGE: 'Imposto, frete da encomenda, handling, seguro, taxa — preço da compra.',
  MONEY: 'Wire, depósito, parcela de carro ou de pack, repasse entre empresas, tarifa de banco.',
}

// Cor do chip, no vocabulário que as telas já usam (bg-*-950 / text-*-300).
export const NATURE_TONE: Record<Nature, string> = {
  PART: 'sky',
  SERVICE: 'amber',
  DIGITAL: 'violet',
  CHARGE: 'zinc',
  MONEY: 'rose',
}
