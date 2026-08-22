// Versão do BANK LINK — a ponte com o banco (Plaid → Regions → bank_transactions),
// produto próprio desde 21/ago/2026 (batizado pelo Márcio). Contagem própria,
// independente de FINANCIAL HUB (lib/finVersion) e DATA CHECKER (lib/dcVersion).
// Todo patch do BANK LINK bumpa BL_VERSION e acrescenta uma linha no changelog.
export const BL_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
<<<<<<< HEAD
export const BL_VERSION = '0.1.2'

export const BL_CHANGELOG: { version: string; date: string; notes: string }[] = [
=======
export const BL_VERSION = '0.2.0'

export const BL_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.2.0', date: '2026-08-21', notes: 'Histórico completo: 908 linhas de Nov/2025 a 25/mai/2026 importadas dos extratos PDF da Regions (checksum por extrato + 220/220 conferidas contra o Plaid em junho), ids stmt:. Saldo do dia via Plaid → cash_balances (uma chamada/dia, source PLAID) — o Caixa do Balanço vive sozinho. API /api/bank/reconcile: candidatos no app por valor/data/grupo de compra e ações MATCH/TRANSFER/IGNORE/EXPLAIN com backfill de payment_date. SHOW ALL pagina além de 1.000.' },
>>>>>>> 6db2e86 (BANK LINK v0.2.0 + DATA CHECKER v1.7.0: conciliacao bancaria e saldo vivo)
  { version: '0.1.2', date: '2026-08-21', notes: 'FULL HISTORY removido: a Regions só serve 90 dias online (conferido no app do banco) e o Plaid não estende item existente — o passado entra por extrato. Token segue pedindo 730 dias pra conexões novas. Sonda de histórico fica como diagnóstico.' },
  { version: '0.1.1', date: '2026-08-21', notes: 'Histórico: link token pede 730 dias (máximo do Plaid; o original pedia 90, por isso a Regions começa em 26/mai). Botão FULL HISTORY em update mode — a sonda (/api/plaid/history-probe) provou que o Plaid NÃO estende conexão existente; o caminho é religar do zero. Lista da tela de 60 → 300 com SHOW ALL (parava em 17/ago).' },
  { version: '0.1.0', date: '2026-08-21', notes: 'Nasce o BANK LINK: Regions via Plaid (OAuth no nome da LLC), access token trancado por RLS, sync por cursor (/transactions/sync) idempotente, webhook do Plaid + cron 6/6h como rede de segurança, tela ADM → BANK com conexões, placar e transações. 754 linhas desde 26/mai/2026, todas NEW — o universo contra o qual o app vai se conferir.' },
]
