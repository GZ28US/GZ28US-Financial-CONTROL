import { rememberCars } from '@/lib/supplierGuard'

// ── QUEM CONTA À GUARDA QUAIS CARROS EXISTEM ────────────────────────────────
// lib/supplierGuard.ts é PURO de propósito (sem banco, sem rede): a checagem tem
// de ser síncrona nas dez portas de escrita de `suppliers`. Então alguém precisa
// entregar os carros a ela, e esse alguém é este módulo.
//
// POR QUE NÃO UMA QUERY EM CADA SAVE: seria uma ida ao banco por tecla de SAVE,
// para uma lista que muda uma vez por mês. Aqui a leitura é UMA por sessão
// (promessa em cache no módulo) e devolve ~200 linhas de três colunas curtas —
// 70 rides no US, 126 no BR. É a leitura mais barata que existe no app, e ela
// acontece no caminho do salvamento, não no carregamento da tela.
//
// FALHA SEGURA: se a leitura voltar vazia (RLS mudo, offline, sessão sem login)
// o cache é descartado e a guarda simplesmente segue com o que já sabia — a
// regra do CÓDIGO ("US.040 — HellMonster") nunca depende disto e continua de pé.
// Reforçar é opcional; enfraquecer é impossível.

/* eslint-disable @typescript-eslint/no-explicit-any */
type CarQueryable = { from: (table: string) => any }

let pending: Promise<void> | null = null

/**
 * Garante que a guarda conheça os carros deste banco. Idempotente e barata:
 * a primeira chamada lê, todas as outras esperam a mesma promessa já resolvida.
 * Passe o client que a call site já tem em mãos (anon nas telas, service nas
 * rotas) — este módulo não escolhe banco por conta própria.
 */
export function primeCarRegistry(db: CarQueryable): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    try {
      const { data } = await db.from('rides').select('project_name, brand, model')
      if (data && data.length) rememberCars(data as any[])
      else pending = null
    } catch {
      pending = null
    }
  })()
  return pending
}

/**
 * Mesma coisa para um SEGUNDO banco (o espelho US→BR escreve em suppliers do BR,
 * e um carro do BR também não pode virar fornecedor). Cache próprio.
 */
let pendingMirror: Promise<void> | null = null
export function primeMirrorCarRegistry(db: CarQueryable): Promise<void> {
  if (pendingMirror) return pendingMirror
  pendingMirror = (async () => {
    try {
      const { data } = await db.from('rides').select('project_name, brand, model')
      if (data && data.length) rememberCars(data as any[])
      else pendingMirror = null
    } catch {
      pendingMirror = null
    }
  })()
  return pendingMirror
}
