-- 13/11/2026: Márcio desativou a página do Facebook Galpão Z28 (272854812745325). A Meta passou a recusar o token dela
-- (código 190, «Page that is not accessible») e a leitura do SOCIAL INBOX registrava erro a cada rodada.
-- A linha sai da leitura (só entra página CONNECTED). Reversível: reativar a página na Meta e reconectar em /social/connect.
update social_auth
   set status = 'REVOKED',
       last_error = 'page deactivated on Facebook by Marcio on 13/11/2026 (reactivate the page, then reconnect)',
       updated_at = now()
 where id = 5 and platform = 'META' and kind = 'FB_PAGE' and external_id = '272854812745325';
