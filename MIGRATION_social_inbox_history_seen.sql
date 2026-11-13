-- SOCIAL INBOX: a primeira leitura (13/11/2026) trouxe historico desde 2016 marcado como NOVO. O que tem mais de 30 dias e arquivo:
-- nasce visto (seen_by = 'history'), igual ao que o codigo passa a fazer. So mexe em seen_at/seen_by de linhas ainda nao vistas.
update public.social_items set seen_at = now(), seen_by = 'history' where seen_at is null and not from_me and happened_at < now() - interval '30 days';
