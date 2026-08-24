// Versão do WHATSAPP HUB — o espelho permanente dos 2 WhatsApp (US + BR) e a
// tela /whatsapp. Produto próprio desde 24/ago/2026 (ordem do Márcio: "não sou
// feliz com a forma que você acessa o WhatsApp — quero uma forma mais direta").
// Todo patch bumpa WA_VERSION e acrescenta uma linha no changelog.
export const WA_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const WA_VERSION = '0.1.0'

export const WA_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.1.0', date: '2026-08-24', notes: 'Nasce o WHATSAPP HUB. Espelho permanente: TODA mensagem dos 2 números (US e BR) vira linha em whatsapp_messages no Supabase US — webhook em tempo real (widen do webhook do FINANCEIRO, agora TODOS os chats) + cron whatsapp-sync 10/10min como rede de segurança (snapshot de chats, releitura dos que mexeram, log da instância pra mídia). Modo deep (?deep=1) faz o backfill do que a UltraMsg ainda guarda. Tela /whatsapp (ADM → WHATSAPP HUB): os dois números numa inbox só, chips ALL/US/BR, busca em chats e mensagens, conversa com mídia, resposta dali mesmo (personal por padrão; BR sai pelo relay → app BR), horário no fuso do assunto (Orlando US / Brasília BR). MCP server local (scripts/whatsapp-mcp.mjs) — o WhatsApp vira ferramenta nativa da assistente: wa_chats, wa_messages, wa_search, wa_unanswered, wa_send.' },
]
