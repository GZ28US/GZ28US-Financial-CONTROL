// Versão do DATA CHECK — produto próprio desde 20/ago/2026, quando saiu do
// FINANCIAL e virou ferramenta de organização do app inteiro (ADM → DATA
// CHECK). Contagem NOVA, independente do lib/finVersion: todo patch do DATA
// CHECK bumpa DC_VERSION e acrescenta uma linha no topo do changelog.
// A era anterior (dentro do FINANCIAL v0.4.0–v0.9.x) está no changelog de lá.
export const DC_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'BETA'
export const DC_VERSION = '1.3.0'

export const DC_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '1.3.0', date: '2026-08-20', notes: 'Sugestão inteligente no conserto de CONCLUSION DATE: o FIX abre pré-carregado com a última atividade do invoice (pagamento recebido ou despesa) — confirma ou ajusta, em vez de reconstruir de memória.' },
  { version: '1.2.0', date: '2026-08-20', notes: 'Conclusion date com semântica certa: só invoice FECHADA sem data é pendência — job em andamento não tem data mesmo, ela nasce no fechamento. E o fechamento agora trava sem a data (oferece hoje com um clique), então o card só encolhe.' },
  { version: '1.1.0', date: '2026-08-20', notes: 'FIX aprende números: card novo "Export sem ADMISSION MILEAGE" lança a milhagem inline (os 24 carros de export sem sair da tela); DESTINY REVIEW fica só com contradições (≥ 100 mi).' },
  { version: '1.0.0', date: '2026-08-20', notes: 'DATA CHECK vira produto próprio, promovido a BETA: bancada de conserto com FIX inline (datas, destinos, tipos, baixas), trilha data_fixes agrupada por sessão, DESTINY REVIEW com a lei do 0km (ADMISSION MILEAGE < 100 mi pros dois tipos de export) e ciclo EXPORTED. Missão: manter os dados do app inteiro completos e corretos — sobre tudo.' },
]
