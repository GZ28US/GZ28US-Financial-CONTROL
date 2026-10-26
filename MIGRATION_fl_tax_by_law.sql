-- FL SALES TAX PELA LEI (26/out/2026 — lib/flTax.ts). A invoice deixa de ter alíquota digitada: o status fiscal nasce do
-- OWNER & DESTINATION do carro (rides.title_scope) ou do endereço do cliente, e a conta é a da lei (peça + mão de obra,
-- 6% + 0,5% Orange County até US$ 5.000 por linha, desconto antes do imposto). Só a EXCEÇÃO com motivo fica gravada.
-- `florida_taxes` (a alíquota antiga) FICA na tabela como histórico; nenhuma tela lê mais.
alter table public.invoices add column if not exists fl_tax_override text check (fl_tax_override is null or fl_tax_override in ('TAXABLE', 'EXEMPT'));
alter table public.invoices add column if not exists fl_tax_override_reason text;
alter table public.invoices drop constraint if exists invoices_fl_tax_override_reason;
alter table public.invoices add constraint invoices_fl_tax_override_reason check (fl_tax_override is null or coalesce(trim(fl_tax_override_reason), '') <> '');
comment on column public.invoices.florida_taxes is 'LEGADO (26/out/2026): alíquota digitada à mão, substituída pela lei em lib/flTax.ts. Nenhuma tela lê. Fica como histórico do que foi cobrado antes.';
