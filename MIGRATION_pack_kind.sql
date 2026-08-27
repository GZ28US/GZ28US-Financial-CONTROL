-- CC 0.2.1→0.2.3 — KIND do pack (João, 26/ago/2026): a anatomia é sempre a
-- mesma (parts+services+duties), o papel no catálogo é que muda:
--   PACK    = produto principal (Demonized, GoldenEye)
--   ADDON   = serviço OPCIONAL de venda por cima de um pack
--             ("Demonized PLUS Lowering Springs")
--   SERVICE = serviço avulso / manutenção (troca de óleo, revisão) — o carro
--             da casa que volta só pra isso escolhe o SERVICE direto na quote
-- Coluna aditiva com default — segura pro app BR que compartilha a tabela.
-- Idempotente e auto-corretiva (renomeia BLOCK→SERVICE se a v1 tiver rodado).
alter table packs add column if not exists kind text not null default 'PACK';
update packs set kind = 'SERVICE' where kind = 'BLOCK';
alter table packs drop constraint if exists packs_kind_check;
alter table packs add constraint packs_kind_check check (kind in ('PACK','ADDON','SERVICE'));
