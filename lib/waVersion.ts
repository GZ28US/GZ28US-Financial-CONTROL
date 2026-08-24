// ("WHATSAPP HUB" no nascimento; INTERCOM desde 24/ago — escolha do João: sóbrio, negócio, como os outros fronts.)
// Versão do INTERCOM — o espelho permanente dos 2 WhatsApp (US + BR) e a
// tela /whatsapp. Produto próprio desde 24/ago/2026 (ordem do Márcio: "não sou
// feliz com a forma que você acessa o WhatsApp — quero uma forma mais direta").
// Todo patch bumpa WA_VERSION e acrescenta uma linha no changelog.
export const WA_STAGE: 'ALPHA' | 'BETA' | 'STABLE' = 'ALPHA'
export const WA_VERSION = '0.3.0'

export const WA_CHANGELOG: { version: string; date: string; notes: string }[] = [
  { version: '0.3.0', date: '2026-08-24', notes: 'O ROUND VIRA DO APP (ordem do Márcio: "você aqui tem que ser só UMA INTERFACE do APP; tudo que puder ficar lá tem que ficar"). Nova rota /api/whatsapp/round devolve a PRÓXIMA conversa não-processada — a regra saiu do script da assistente e virou do app. Marca dágua por conversa (whatsapp_chats.processed_through/processed_at/processed_note): processada é tudo ATÉ aquele instante, e mensagem posterior REABRE a conversa sozinha; botão MARCAR PROCESSADO na tela e placar NO ROUND. Política de pauta por conversa (v0.2.0, mesma leva): ALL / MENTION_ONLY / IGNORE, com seletor na tela — GZ28BR-STAFF já em MENTION_ONLY. Captura de marcações (mentioned_ids do webhook nos 2 números): o corpo mostra @<LID>, nunca o telefone, então só o payload diz quem foi marcado. Fuso pelo ASSUNTO: grupo GZ28US é Orlando mesmo lido pela cópia BR.' },
  { version: '0.1.0', date: '2026-08-24', notes: 'Nasce o INTERCOM. Espelho permanente: TODA mensagem dos 2 números (US e BR) vira linha em whatsapp_messages no Supabase US — webhook em tempo real (widen do webhook do FINANCEIRO, agora TODOS os chats) + cron whatsapp-sync 10/10min como rede de segurança (snapshot de chats, releitura dos que mexeram, log da instância pra mídia). Modo deep (?deep=1) faz o backfill do que a UltraMsg ainda guarda. Tela /whatsapp (ADM → INTERCOM): os dois números numa inbox só, chips ALL/US/BR, busca em chats e mensagens, conversa com mídia, resposta dali mesmo (personal por padrão; BR sai pelo relay → app BR), horário no fuso do assunto (Orlando US / Brasília BR). MCP server local (scripts/whatsapp-mcp.mjs) — o WhatsApp vira ferramenta nativa da assistente: wa_chats, wa_messages, wa_search, wa_unanswered, wa_send.' },
]
