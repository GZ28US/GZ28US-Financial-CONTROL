// Versão do TAX SHIELD (nasceu "TAX HUB", virou escudo em 23/ago — nome do João+Claude) — impostos e obrigações da GZ28US, produto próprio desde
// 23/ago/2026 (pedido do João e do Márcio). Contagem própria, independente dos
// outros fronts. Regra da casa: o app ORGANIZA os fatos fiscais; quem afirma a
// lei é a Drummond (contadora). Todo patch bumpa TAX_VERSION + linha no changelog.
export const TAX_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const TAX_VERSION = '0.1.0'

export const TAX_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.1.0', date: '2026-08-23', notes: 'Nasce o TAX SHIELD (batizado TAX HUB por algumas horas) com o rastreador de 1099-NEC: todo beneficiário pago pela LLC via Zelle, wire ou cheque, somado por ano (regra geral: serviço ≥ $600/ano a não-corporação pede 1099-NEC até 31/jan — a Drummond confirma). Classificação por beneficiário (Serviço/Mercadoria/Corporação/Pessoal/Ignorar) + W-9 em arquivo + notas, gravadas em tax_contractors (MIGRATION_tax_1099.sql). Card TAX no Data Checker: quem passou de $600 sem classificação, e serviço sem W-9. Módulos na fila: FL Sales Tax (DR-15), pacote de fim de ano pra contadora, impostos de compra de veículo.' },
]
