-- 13/11/2026: a pagina GZ28 V8 SpeedShop USA LLC trocou de Instagram (@gz28us -> a conta de 78,7k, hoje @gz28br), por ordem do Marcio.
-- A linha antiga do @gz28us deixa de ser lida pela pagina; o callback passa a fazer isto sozinho nas proximas reconexoes.
update public.social_auth set status = 'REVOKED', last_error = 'no longer linked to the US page since 13/11/2026 (page now linked to the 78.7k account)', updated_at = now() where id = 4 and kind = 'IG_ACCOUNT' and external_id = '17841474629413308' and status = 'CONNECTED';
