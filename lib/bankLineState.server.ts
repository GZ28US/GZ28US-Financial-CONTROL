// SERVER-ONLY — O ESTADO DE CADA LINHA DO BANCO, DITO NUMA FRASE (BL 1.5.0 · DC 1.50.0, 10/set/2026).
//
// João × Márcio, 10/set: o card da conciliação mostrava toda linha sem dono igual — uma Summit pendente que casa sozinha ao
// postar, uma dúvida de verdade e uma coincidência de centavos pareciam a mesma coisa, e a discussão nasceu disso. Aqui cada
// linha ganha UM estado e UMA frase, calculados do mesmo plano que o AUTO-LINK roda (buildPlan com as pendentes de fora e as
// irmãs pendentes como trava — igual ao cron):
//   PERGUNTA   precisa de gente: É ESTA?, DISPUTA, QUASE, NA FOLHA, DINHEIRO, SEM REGRA, AGENDADA≠, TETO sem balde,
//              DUPLICADA, TO BOOK marcado há mais de 14 dias, PARADA
//   FORNECEDOR «quem é X pra nós?» — respondida UMA vez por fornecedor (conta como UMA pergunta por grupo)
//   ESPERANDO  o AUTO-LINK cuida: PENDENTE, VAI CASAR, MATURANDO, TETO (vai pro balde), IRMÃ PENDENTE, TO BOOK recente
// Só PERGUNTA e FORNECEDOR contam no Data Checker. Esperar não é pendência — mas aparece, com a frase (silêncio é promessa).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { nameHit, shortNameHit, classify, num, signedDays, RULE_AGE_DAYS, type Cand, type PlanDoubt, type PlanItem } from './bankReconcile.server'

export type LineStateCode = 'PENDENTE' | 'VAI CASAR' | 'É ESTA?' | 'DISPUTA' | 'QUASE' | 'NA FOLHA' | 'DINHEIRO' | 'QUEM É?' | 'SEM REGRA' | 'AGENDADA≠' | 'MATURANDO' | 'TETO' | 'IRMÃ PENDENTE' | 'TO BOOK' | 'DUPLICADA' | 'PARADA'
export type LinePile = 'PERGUNTA' | 'FORNECEDOR' | 'ESPERANDO'
// target: o registro que o AUTO-LINK vai casar na próxima rodada (pra tela oferecer NÃO É ESSA antes do cron).
export type LineState = { code: LineStateCode; pile: LinePile; ask: boolean; sentence: string; target?: { table: string; id: string; label: string } | null }
type Near = { label: string; staff: string[]; date: string; amount: number; delta: number }

const usd = (v: number) => '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dm = (iso: string) => { const s = String(iso || '').slice(0, 10); return s.length === 10 ? s.slice(8, 10) + '/' + s.slice(5, 7) : '?' }
const addDays = (iso: string, d: number) => new Date(Date.parse(String(iso).slice(0, 10)) + d * 864e5).toISOString().slice(0, 10)
const lab = (c: { label?: string } | null | undefined) => '«' + String((c && c.label) || '?').replace(/^(EXPENSE|FIXO|TARIFA|SUPPLY|STOCK|GOODS|FOLHA|PESSOAL|INCOME|PEDIDO|EMPRÉSTIMO|CAPITAL) · /, '').slice(0, 90) + '»'
const ask = (code: LineStateCode, sentence: string): LineState => ({ code, pile: 'PERGUNTA', ask: true, sentence })
const wait = (code: LineStateCode, sentence: string): LineState => ({ code, pile: 'ESPERANDO', ask: false, sentence })
// DINHEIRO (DC 1.51.0): wire, Zelle, depósito, cheque — classify TRANSFER ou INCOME. Nessas linhas toda tabela «combina» (AFFINITY
// TRANSFER = T_MONEY), então o tipo de compra não prova nada: só o NOME liga dinheiro a um registro. A rota manda `money` pra tela.
export const isMoneyLine = (l: any) => { const k = classify(l).klass; return k === 'TRANSFER' || k === 'INCOME' }

function itemSentence(it: PlanItem): string {
  const rule = it.rule ? '«' + String((it.rule as any).label || (it.rule as any).key || it.rule.pattern || 'regra').slice(0, 60) + '»' : 'a regra'
  switch (it.engine) {
    case 'FEE': return it.create ? 'O AUTO-LINK lança como tarifa da Regions na próxima rodada (até 6 h).' : `O AUTO-LINK casa na próxima rodada com a tarifa já lançada ${lab(it.cand)}.`
    case 'EXACT': return `O AUTO-LINK casa na próxima rodada (até 6 h) com ${lab(it.cand)} — mesmo valor, nome e data. Se não é essa, diga NÃO antes.`
    case 'NAME': return `O AUTO-LINK casa na próxima rodada (até 6 h) com ${lab(it.cand)} — o nome desempatou. Se não é essa, diga NÃO antes.`
    case 'SET': return `Série: o AUTO-LINK casa esta cobrança em conjunto com ${lab(it.cand)} na próxima rodada.`
    case 'BUCKET': return `O AUTO-LINK põe esta compra no balde A ATRIBUIR na próxima rodada${it.cls ? ' (' + it.cls.klass + ')' : ''} — o dono (carro, estoque, fixo) é decisão de gente, na fila. Se ela já está lançada, case antes.`
    default:
      if (it.transfer) return `O AUTO-LINK marca como TRANSFER na próxima rodada, pela regra ${rule}.`
      if (it.ignore) return `O AUTO-LINK ignora esta linha na próxima rodada, pela regra ${rule}.`
      if (it.adopt) return `O AUTO-LINK adota a conta agendada de ${dm(it.adopt.expense_date)} (${usd(it.adopt.amount)}) na próxima rodada, pela regra ${rule}.`
      return `O AUTO-LINK lança esta linha na próxima rodada pela regra ${rule}. Se ela já está lançada, case antes.`
  }
}

export function lineState(l: any, cands: (Cand & { tier?: string })[], doubt: PlanDoubt | null, item: PlanItem | null, near: Near[] | null, today: string): LineState {
  const amt = Math.abs(num(l.amount)), out = num(l.amount) > 0
  const merchant = String(l.merchant || l.name || '').slice(0, 50)
  const par = cands.filter(c => c.tier === 'PAR')
  const coin = cands.some(c => c.tier && c.tier !== 'PAR')
  if (l.pending) {
    const sure = par.find(c => nameHit(l, c) && c.dd != null && c.dd <= 3)
    return wait('PENDENTE', 'Ainda não postou no banco — o Plaid troca o id ao postar, então nada casa antes disso.' + (sure ? ` Casa sozinha ao postar com ${lab(sure)}.` : ''))
  }
  if (item) {
    const target = item.cand && !item.create && ['EXACT', 'NAME', 'SET', 'FEE'].includes(item.engine) ? { table: item.cand.table, id: item.cand.id, label: item.cand.label } : null
    return { ...wait('VAI CASAR', itemSentence(item)), target }
  }
  // TO BOOK: alguém disse «sei o que foi, lanço depois». Se o app JÁ tem um registro parecido (gêmeo ou folha), a pergunta
  // é esse registro — não a promessa. A idade conta da MARCAÇÃO (queued_at, do diário), não da data do banco.
  const queued = l.match_status === 'QUEUED'
  const holdsRecord = !!doubt && (doubt.kind === 'TWIN' || doubt.kind === 'FOLHA')
  if (queued && !holdsRecord) {
    const age = signedDays(String(l.queued_at || l.date).slice(0, 10), today)
    const s = 'Marcada em TO BOOK (alguém sabe o que foi e vai lançar) — lance no app e o AUTO-LINK casa sozinho.'
    return age > 14 ? ask('TO BOOK', s + ` Marcada há ${age} dias e ainda sem lançamento.`) : wait('TO BOOK', s)
  }
  const pre = queued ? 'Marcada em TO BOOK, mas o app já tem um registro parecido — ' : ''
  if (!doubt) return ask('PARADA', 'O AUTO-LINK não decidiu esta linha — diga o que foi: MATCH, TRANSFER, IGNORE ou EXPLAIN.')
  const r = String(doubt.reason || ''), c0 = doubt.cands && doubt.cands[0] ? doubt.cands[0] : null
  const named0 = c0 ? nameHit(l, c0 as any) : false
  const moneyIn = `Entrou ${usd(amt)} de «${merchant}» — recebimento de qual invoice, ou aporte de sócio? O AUTO-LINK nunca chuta dinheiro.`
  const moneyOut = `Saiu ${usd(amt)} para «${merchant}» — qual invoice, sócio, folha ou conta? O AUTO-LINK nunca chuta dinheiro.`
  // DINHEIRO SEM NOME (DC 1.51.0 — o wire de $20,000 da PARK PLACE MOT aparecia como «É ESTA?» do saldo em aberto US.050.1 da Surf City,
  // com «SIM preenche a data com a do banco»): registro que só bate no valor não vira pergunta de sim/não em linha de dinheiro.
  // Nada vem marcado e nenhum SIM é oferecido; a lista continua na tela pra gente escolher, se for mesmo um deles.
  if (doubt.kind === 'TWIN' && isMoneyLine(l) && (doubt.cands || []).length && !(doubt.cands || []).some(c => nameHit(l, c as any) || shortNameHit(l, c as any))) {
    const cs = doubt.cands || []
    return ask('DINHEIRO', pre + (out ? `Saiu ${usd(amt)} para «${merchant}»` : `Entrou ${usd(amt)} de «${merchant}»`) + ` e o app tem ${cs.length > 1 ? cs.length + ' registros' : lab(c0)} com o mesmo valor, mas o nome da linha do banco não bate com ${cs.length > 1 ? 'nenhum deles' : 'ele'} — valor igual não diz de quem é o dinheiro. Nada vem marcado: se for ${cs.length > 1 ? 'um deles' : 'esse'}, escolha na lista e case (MATCH); se não, diga o que foi — qual invoice, sócio, folha ou conta.`)
  }
  switch (doubt.kind) {
    case 'FOLHA': {
      const n = near && near[0]
      return ask('NA FOLHA', pre + (n ? `A folha tem ${lab(n)} (${n.staff.join(', ')}, ${dm(n.date)}, ${usd(n.amount)}) — diferença de ${usd(n.delta)}. É a mesma compra? CASAR COM AJUSTE leva o valor do banco.` : 'A folha tem esta compra com diferença de valor — CASAR COM AJUSTE ou NÃO.'))
    }
    case 'MONEY': return ask('DINHEIRO', out ? moneyOut : moneyIn)
    case 'SUPPLIER': return { code: 'QUEM É?', pile: 'FORNECEDOR', ask: true, sentence: `«${merchant}» (${doubt.klass}) — quem é pra nós? Responda uma vez em «Quem é?»: a resposta vira regra e lança as linhas deste fornecedor.` }
    case 'CAP':
      if (/não vai pro balde/.test(r)) return ask('TETO', `A regra entendeu esta linha (${doubt.klass}), mas ${usd(amt)} passa do teto dela e esta linha não vai pro balde (regra de transferência/ignorar, ou entrada) — diga o que foi.`)
      return wait('TETO', `A regra entendeu esta compra (${doubt.klass}), mas ${usd(amt)} passa do teto dela — o AUTO-LINK põe no balde A ATRIBUIR em ${dm(addDays(l.date, RULE_AGE_DAYS))}, com o motivo.`)
    case 'MATURITY': return wait('MATURANDO', `Uma regra lança esta linha em ${dm(addDays(l.date, RULE_AGE_DAYS))} (espera ${RULE_AGE_DAYS} dias porque gente ainda lança atrasado) — se ela já está lançada, case antes e o AUTO-LINK não cria nada.`)
    case 'TWIN': {
      if (/quase-gêmeo/.test(r)) return ask('QUASE', pre + (c0 ? `O app tem ${lab(c0)} por ${usd(c0.amount)} (diferença de ${usd(c0.amount - amt)}) — é a mesma compra com imposto ou frete? Ajuste o registro e case, ou NÃO.` : 'O app tem uma compra quase igual (nome batendo, valor na faixa do imposto) — é a mesma?'))
      if (/valor repetido no banco|série/.test(r)) return ask('DISPUTA', pre + `Cobranças iguais de «${merchant}» (${usd(amt)}) se repetem no banco — o AUTO-LINK não sabe qual é de qual registro.` + (c0 ? ` Esta é a de ${lab(c0)}?` : ''))
      if (/valor redondo/.test(r)) return ask('É ESTA?', pre + `${lab(c0)} bate em valor, nome e data, mas ${usd(amt)} é valor redondo de dinheiro — o AUTO-LINK não casa dinheiro sozinho. É esta?`)
      if (/tarifa ambígua/.test(r)) return ask('É ESTA?', pre + `Tarifa de ${usd(amt)} com duas ou mais lançadas iguais em ±7 dias — qual é esta?`)
      if (/candidato ambíguo/.test(r)) { const cs = doubt.cands || []; return ask('É ESTA?', pre + `${cs.length} registros com ${usd(amt)} perto desta data e o nome não desempata: ${cs.slice(0, 2).map(lab).join(' ou ')}${cs.length > 2 ? ' …' : ''} — qual é? (ou NENHUMA)`) }
      if (/mais de 3 dias/.test(r)) return ask('É ESTA?', pre + `${lab(c0)} tem o mesmo valor${named0 ? ' e o nome bate' : ' e é do mesmo tipo de compra'}, mas está longe da data do banco (o AUTO-LINK só casa sozinho até 3 dias). É esta?`)
      if (/candidato sem data/.test(r)) return ask('É ESTA?', pre + `${lab(c0)} tem o mesmo valor${named0 ? ' e o nome bate' : ' e é do mesmo tipo de compra'}, mas está sem data. É esta? SIM preenche a data com a do banco.`)
      if (/nome não bate/.test(r)) return ask('É ESTA?', pre + `${lab(c0)} tem o mesmo valor e é do mesmo tipo de compra, mas o nome não confirma. É esta?`)
      if (/candidato longe/.test(r)) return ask('SEM REGRA', `O mesmo valor e o nome aparecem em ${lab(c0)}, mas longe no tempo — provavelmente outra compra, e nenhuma regra entende «${merchant}». Diga o que foi (ou, se for mesmo aquele registro, case pela lista recolhida).`)
      return ask('É ESTA?', pre + `O AUTO-LINK viu um registro parecido e parou (${r})${c0 ? ': ' + lab(c0) : ''} — é esta?`)
    }
    default: {
      if (/irmã pendente/.test(r)) return wait('IRMÃ PENDENTE', `Uma cobrança igual de «${merchant}» ainda está pendente — o AUTO-LINK espera ela postar pra decidir qual é qual.`)
      if (/feed duplicado/.test(r)) return ask('DUPLICADA', 'A mesma linha chegou duas vezes (duas conexões do Plaid, ou a cópia do extrato já foi casada) — o AUTO-LINK não casa nem cria esta cópia. Se é repetida, IGNORE; se é outra compra, EXPLAIN.')
      if (/agendada do mês com valor muito diferente/.test(r)) return ask('AGENDADA≠', `A regra achou a conta agendada do mês, mas o banco cobrou ${usd(amt)}, fora de ±50% do previsto — é essa conta com outro valor, ou é outra?`)
      if (/entrada nunca cria/.test(r)) return ask('DINHEIRO', moneyIn)
      if (/sem candidato/.test(r)) return ask('SEM REGRA', `Nenhum registro do app combina com esta compra de ${usd(amt)}${coin ? ' (há só coincidência de valor, recolhida)' : ''} e nenhuma regra entende «${merchant}» (${doubt.klass}). Diga o que foi (EXPLAIN), marque TRANSFER/IGNORE, ou crie a regra no Bank Link.`)
      if (/^pendente$/.test(r)) return wait('PENDENTE', 'Ainda não postou no banco — nada casa antes disso.')
      return ask('PARADA', `O AUTO-LINK parou nesta linha: ${r}. Diga o que foi.`)
    }
  }
}

// Contagem que o Data Checker usa: pergunta linha a linha + UMA por fornecedor (o grupo, não as linhas dele).
export function askCount(states: LineState[], supplierGroups: number): number {
  return states.filter(s => s.ask && s.pile === 'PERGUNTA').length + supplierGroups
}
