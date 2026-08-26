// Versão do CREW CHIEF — o cérebro de produção (blueprints → packs → duties →
// capacidade), nascido 26/ago/2026 sobre o passo do Márcio (packs carregam
// STAFF DUTIES, commit 06aa989). Contagem própria, como FIN/DC/BL/WA.
// Todo patch do CREW CHIEF bumpa CC_VERSION e acrescenta uma linha aqui.
export const CC_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const CC_VERSION = '0.1.0'

export const CC_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.1.0', date: '2026-08-26', notes: 'NASCE O CREW CHIEF — P1: o minerador de blueprints com curadoria. A mineração é computada ao vivo (nada é gravado): famílias por pack, blocos de KIT recorrentes (kit_name × invoices), espinhas de duties por exemplar (o prefixo "NN." reinicia por frente de trabalho — nunca ordenar o invoice inteiro por ele), vocabulário normalizado (171 descrições, 34 recorrentes) e dicas de tempo por descrição — regra do João: o suspeito é o STINT (>10h contínuas = timer esquecido, mesma régua do DUTY WATCH), nunca o total da duty; com corpus crescendo, o desvio vira relativo à mediana. ADOTAR cria o candidato (tabela nova blueprint_candidates, US-only, com proveniência completa); o humano cura (texto canônico com as variantes absorvidas, ordem via "NN.", prioridade, estimativa pré-carregada da mediana); PROMOVER vira um PACK de verdade (DRAFT · zone US, na forma exata do editor do Márcio — intocado) ou ENRIQUECE um pack existente sem duties (os 11 da família Demon-170 nasceram vazios). Sequência combinada: Márcio+João atualizam os 38 packs primeiro; a mineração roda no dado limpo. MODO GUIADO da curadoria e os fiscais do Data Checker ficam pro CC 0.2.0 — um passo de cada vez (João).' },
]
