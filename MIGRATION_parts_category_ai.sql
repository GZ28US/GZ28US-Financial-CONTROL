-- A CATEGORIA DA PEÇA SE PREENCHE SOZINHA (DC 1.42.0, 8/set/2026). Rode UMA vez no SQL Editor do projeto US. Idempotente.
--
-- O segundo leitor (IA, vocabulário fechado de 13) guarda o veredito na própria peça,
-- pra não reler a cada carga do Data Checker. Dois leitores concordando = a categoria
-- entra sozinha (trilha em data_fixes, «AUTO ·», DESFAZER por 7 dias no card).
-- Sem a coluna o app segue vivo: palavra-chave só, e o card avisa «rode a migration».
alter table public.parts_database add column if not exists category_ai text;
alter table public.parts_database add column if not exists category_ai_at timestamptz;
comment on column public.parts_database.category_ai is 'Data Checker: veredito da IA (13 categorias ou NOT_A_PART) — segundo leitor; concordando com a palavra-chave, a categoria entra sozinha';

-- Conferência (só leitura):
--   select category_ai, count(*) from public.parts_database group by 1 order by 2 desc;
