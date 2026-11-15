-- 14/11/2026: a conta antiga de 6,6k (linha 4, desligada da página US em 13/11) foi renomeada pelo Márcio no celular:
-- @gz28us → @dema.gz28us. A linha guardava o nome velho, que em 27/11 passa a ser o da conta de 78,7k.
update social_auth set account = '@dema.gz28us', updated_at = now()
 where id = 4 and kind = 'IG_ACCOUNT' and external_id = '17841474629413308' and account = '@gz28us';
