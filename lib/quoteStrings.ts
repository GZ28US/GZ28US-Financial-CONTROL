// CLIENT COPY of the quote portal, EN + PT (06/11/2026; blueprint §5.6). One table, both languages, keyed. The language of a
// document is `invoice_terms.language` (seeded by the client's country: BRAZIL / ANGOLA → pt). The PT strings and the PT terms
// text are a first version: the BR session reviews them before the first Brazilian link goes out.
//
// THE TERMS TEXT IS SIGNED. Its SHA-256 (in the document's language) is frozen in every revision (`terms_sha256`) and recomputed
// by the server at signing; changing a single character here changes the hash → a client holding an older page gets `err_stale`.
// Change the text = bump TERMS_VERSION (and the consent_version the DB seeds: 'terms-<lang>-v1-2026-11').

export type Lang = 'en' | 'pt'
export const TERMS_VERSION = 'v1-2026-11'

export const TERMS_TEXT: Record<Lang, string> = {
  en: [
    'TERMS OF THIS QUOTE — GZ28 V8 SpeedShop USA LLC',
    '1. Validity. This quote is valid until the date shown on it. The prices of the parts and services listed are fixed for that period.',
    '2. Payment plan. Payments follow the plan shown on this quote. The deposit confirms your project; parts orders and work start once the deposit has cleared.',
    '3. Changes. Any change of scope or price after your approval is made by a written change order that you approve before that work is done. Nothing is added to your bill without your approval.',
    '4. Written estimate (Florida). For repairs over US$ 100 you are entitled to a written estimate (Fla. Stat. §559.905). This quote is that estimate, and your choice about it is recorded with your approval.',
    '5. Replaced parts. Replaced parts are returned to you, kept for your inspection, or disposed of, as you choose when you approve — except parts exchanged under warranty or subject to a core charge.',
    '6. Electronic records. You agree to receive and sign this quote electronically. You may ask for a paper copy at any time, at no charge, and you may withdraw this consent by telling GZ28.',
    '7. Card and bank payments are processed by Stripe. GZ28 never sees or stores your card or bank account numbers.',
  ].join('\n'),
  pt: [
    'CONDIÇÕES DESTE ORÇAMENTO — GZ28 V8 SpeedShop USA LLC',
    '1. Validade. Este orçamento vale até a data indicada nele. Os preços das peças e serviços listados ficam fixos nesse período.',
    '2. Plano de pagamento. Os pagamentos seguem o plano mostrado neste orçamento. O sinal confirma o seu projeto; as compras de peças e o trabalho começam quando o sinal é compensado.',
    '3. Alterações. Qualquer mudança de escopo ou de preço depois da sua aprovação é feita por um aditivo por escrito, que você aprova antes do trabalho. Nada entra na sua conta sem a sua aprovação.',
    '4. Orçamento por escrito (Flórida). Para reparos acima de US$ 100 você tem direito a um orçamento por escrito (Fla. Stat. §559.905). Este orçamento é esse documento, e a sua escolha sobre ele fica registrada com a sua aprovação.',
    '5. Peças substituídas. As peças substituídas são devolvidas a você, guardadas para a sua inspeção ou descartadas, como você escolher ao aprovar — exceto peças trocadas em garantia ou sujeitas a devolução de casco (core).',
    '6. Registros eletrônicos. Você concorda em receber e assinar este orçamento eletronicamente. Pode pedir uma cópia em papel a qualquer momento, sem custo, e pode retirar este consentimento avisando a GZ28.',
    '7. Pagamentos com cartão e conta bancária são processados pela Stripe. A GZ28 nunca vê nem guarda os números do seu cartão ou da sua conta.',
  ].join('\n'),
}

export const FL_ESTIMATE_TEXT: Record<Lang, string> = {
  en: 'Florida Motor Vehicle Repair Act (§559.905): you may request a written estimate before any repair over US$ 100, or authorize work up to a limit you set, or waive the estimate. GZ28 will not charge more than the approved amount (or more than 10% / US$ 50 above it, whichever is less) without your consent. This quote states the parts, labor and total by line, and the shop name and address.',
  pt: 'Lei de Reparo de Veículos da Flórida (§559.905): você pode pedir um orçamento por escrito antes de qualquer reparo acima de US$ 100, autorizar o trabalho até um limite que você define, ou dispensar o orçamento. A GZ28 não cobra além do valor aprovado (ou mais de 10% / US$ 50 acima dele, o que for menor) sem o seu consentimento. Este orçamento traz as peças, a mão de obra e o total por linha, e o nome e o endereço da oficina.',
}

type Dict = Record<string, string>
const EN: Dict = {
  brand: 'GZ28 V8 SpeedShop',
  your_quote: 'Your quote', quote: 'Quote', rev: 'rev', valid_until: 'valid until', extended_on: 'extended on',
  hello: 'Hi {name} — here is your build quote.', hello_parts: 'Hi {name} — here is your parts quote.',
  whats_included: "WHAT'S INCLUDED", parts: 'parts', services: 'services', notes: 'NOTES',
  included: 'included', 'due.ON_APPROVAL': 'On approval', 'due.ON_ARRIVAL': 'When the car arrives', 'due.ON_CONCLUSION': 'On conclusion', courtesy: 'COURTESY', subtotal: 'Subtotal', discount: 'Discount', fl_tax: 'Florida sales tax',
  fl_exempt: 'exempt', grand_total: 'GRAND TOTAL', total: 'TOTAL',
  payment_plan: 'PAYMENT PLAN', 'label.DEPOSIT': 'Deposit on approval', 'label.ARRIVAL': 'When your car arrives',
  'label.CONCLUSION': 'When your car is done', 'label.CUSTOM': 'Installment',
  rail_card: 'Card', rail_ach_card: 'Bank transfer (ACH) or card', no_fee: '— no fee to you.', zelle_wire: 'Zelle or wire also welcome.',
  fl_estimate_title: 'YOUR FLORIDA WRITTEN ESTIMATE', terms_title: 'TERMS OF THIS QUOTE',
  approve_title: 'APPROVE THIS QUOTE', sign_name: 'Your name',
  co_title: 'CHANGE ORDER #{n}', co_intro: 'We prepared a change to your project. Here is exactly what changes:', co_added: 'Added', co_removed: 'Removed', co_changed: 'Changed',
  co_total: 'Total {before} → {after}', co_plan: 'New payment plan', co_consent: 'I approve this change order and the new total.', co_approve_btn: '✍ APPROVE THE CHANGE — {amount}',
  co_pending_pay: 'Payments resume after this change is approved.', co_pending: 'Payments resume after the change order is approved.', co_applied: 'Change order #{n} approved — the document below is up to date.',
  consent_erecords: 'I agree to receive and sign this estimate electronically. Paper copy on request.',
  consent_terms: 'I have read and accept the terms of this quote (above).',
  est_label: 'Written estimate', est_REQUEST: 'This document', est_LIMIT: 'Only above US$', est_WAIVE: 'Not needed',
  parts_label: 'Replaced parts', parts_RETURN: 'Return to me', parts_INSPECT: 'Keep for inspection', parts_NONE: 'No need',
  gate_phone: 'To sign, confirm the phone ending in ••{last2}', gate_email: 'To sign, confirm the e-mail {masked}',
  gate_phone_ph: 'last 4 digits', gate_email_ph: 'your e-mail',
  approve_btn: '✍ APPROVE & SIGN — {amount}', next_pay: 'Next: pay the {amount} deposit.',
  request_changes: 'Request changes', not_now: 'Not now', approve_reopen: '▸ Approve this quote', contact_us: '💬 Contact GZ28',
  contact_sheet: 'Reach us on {channel}: {handle} (tap to copy)', copied: 'Copied',
  print: '🖨 Print / save as PDF',
  approved_by: '✓ Approved by {name} · {when} (Orlando)', approved_shop: '✓ Approved ({method}) · {when} (Orlando)',
  deposit_due: 'DEPOSIT DUE NOW — {amount}', installment_due: 'DUE NOW — {amount}', pay_card: 'Pay {amount} by card', pay_online: 'Pay {amount} online', pay_online_hint: 'Card, bank transfer, financing and more — you choose on the next screen.', pay_ach: 'Pay {amount} by bank transfer (ACH)',
  prefer_zelle: 'Prefer Zelle or wire? Tap for instructions', zelle_sheet: 'Zelle: {zelle}\nWire: ask GZ28 for the wire details.\nReference: {code}',
  i_sent_it: 'I sent it', promised_ok: '✓ Thanks — GZ28 will confirm when it arrives.',
  stripe_foot: 'Payments are processed securely by Stripe.',
  clearing: '⏳ Deposit of {amount} authorized {date} — clearing with your bank, in up to 4 business days. Your project opens the moment it clears. Stripe e-mailed you the debit authorization.',
  clearing_microdeposits: "Stripe sent two small deposits to your account — confirm them from Stripe's e-mail (up to 10 days).",
  clearing_no_card: 'Card payment is unavailable while a bank transfer is pending.',
  failed: 'Your bank returned the payment ({reason}). Nothing was charged.', pay_again: 'Pay again',
  'fail_reason.verification_timeout': 'bank account not verified in time', 'fail_reason.generic': 'payment not completed',
  deposit_refunded: 'Your deposit of {amount} was refunded on {date}. Your project stands; the deposit is due again.',
  hired: "🏁 You're in. Project {code} — {car}.", formerly: 'formerly quote {old_code} (until {date})', paid: 'PAID',
  balance_pending_update: 'Your final balance is being updated — GZ28 will send the revised amount.',
  changes_title: 'What would you like to change?', changes_send: 'Send request', changes_received: 'We received your request on {date} and will send a revised quote.',
  decline_title: 'Not going ahead?', decline_btn: 'Decline this quote', decline_confirm: 'Confirm decline', reason_TIMING: 'Timing', reason_SCOPE: 'Scope', reason_OTHER: 'Other',
  declined: 'You declined this quote on {date}.', undo_decline: 'I changed my mind',
  superseded: 'GZ28 is preparing a new version of this quote — it will appear here.',
  expired: 'This quote expired on {date}.', ask_renewal: 'Still interested? Ask GZ28 to renew this quote', renewal_asked: '✓ Asked — GZ28 will get back to you',
  void: 'This quote is no longer available.', not_found: 'This link is not valid.', inactive: 'This page is not available yet. Please contact GZ28.',
  return_no_session: 'Payment received — we are confirming it. Open your quote link again to see the confirmation.',
  landing_pending: "We're confirming your payment… this page refreshes by itself.",
  landing_timeout: 'Still confirming — nothing else to do; your receipt will show here. You will not be charged twice.',
  open_in_browser: 'For the smoothest payment, open this page in your browser.',
  err_stale: 'This quote was just updated — the page will reload with the current version.', err_rate: 'Too many tries — wait a moment and try again.',
  err_pay_unavailable: 'Online payment is not available right now — use Zelle or wire below, or contact GZ28.',
  err_gate: "That doesn't match our records", err_gate_locked: 'Too many tries — try again in {minutes} minutes or contact GZ28',
  err_limit: 'Enter the amount above which you want a written estimate', err_name: 'Type your full name', err_consent: 'Tick both boxes to approve',
  err_choice: 'Choose an option for the written estimate and for replaced parts', offline: 'You seem to be offline — check your connection.',
  err_generic: 'Something went wrong — try again or contact GZ28.',
  certificate: 'SIGNATURE CERTIFICATE', hash_hint: 'Document fingerprint (SHA-256)', signed_copy: '⬇ Your signed copy',
  'method.SHOP_PHONE': 'by phone', 'method.SHOP_IN_PERSON': 'in person', 'method.SHOP_TEXT': 'by text message', 'method.SHOP_EMAIL': 'by e-mail',
  'method.CLIENT_ESIGN': 'e-signature', 'method.LEGACY_HIRING_DATE': 'recorded by GZ28',
  // M4 signing code (OTP) — only shown while quote_portal.sign_otp is ON
  otp_intro_WHATSAPP: 'To sign, we will send a 6-digit code by WhatsApp to the number ending in {masked}.',
  otp_intro_EMAIL: 'To sign, we will send a 6-digit code by e-mail to {masked}.',
  otp_send: 'Send me the code', otp_resend: 'Send a new code', otp_resend_wait: 'New code in {seconds}s',
  otp_sent: 'Code sent — it expires in 10 minutes.', otp_ph: '6-digit code', otp_verified: '✓ Code confirmed',
  err_otp: "That code doesn't match — {left} tries left", err_otp_locked: 'Too many wrong codes — try again in {minutes} minutes or contact GZ28',
  err_otp_expired: 'This code expired — ask for a new one', err_otp_wait: 'Wait {seconds}s before asking for a new code',
  err_otp_required: 'Enter the code we sent you', err_otp_none: 'Ask for a code first',
  err_otp_send: "We couldn't send the code — try again or contact GZ28", err_otp_no_channel: 'We have no phone or e-mail to send the code to — contact GZ28',
  otp_message: 'GZ28 V8 SpeedShop — your code to sign {code}: {otp}. It expires in 10 minutes. Never share this code.',
  otp_mail_subject: 'Your signing code — {code}', otp_mail_intro: 'Here is your code to sign {code}:',
  otp_mail_foot: "It expires in 10 minutes. If you didn't ask for it, ignore this e-mail and never share the code.",
}
const PT: Dict = {
  brand: 'GZ28 V8 SpeedShop',
  your_quote: 'Seu orçamento', quote: 'Orçamento', rev: 'rev', valid_until: 'válido até', extended_on: 'prorrogado em',
  hello: 'Olá, {name} — aqui está o orçamento do seu projeto.', hello_parts: 'Olá, {name} — aqui está o seu orçamento de peças.',
  whats_included: 'O QUE ESTÁ INCLUÍDO', parts: 'peças', services: 'serviços', notes: 'OBSERVAÇÕES',
  included: 'incluído', 'due.ON_APPROVAL': 'Na aprovação', 'due.ON_ARRIVAL': 'Na chegada do carro', 'due.ON_CONCLUSION': 'Na conclusão', courtesy: 'CORTESIA', subtotal: 'Subtotal', discount: 'Desconto', fl_tax: 'Imposto da Flórida',
  fl_exempt: 'isento', grand_total: 'TOTAL GERAL', total: 'TOTAL',
  payment_plan: 'PLANO DE PAGAMENTO', 'label.DEPOSIT': 'Sinal na aprovação', 'label.ARRIVAL': 'Na chegada do carro',
  'label.CONCLUSION': 'Na conclusão do carro', 'label.CUSTOM': 'Parcela',
  rail_card: 'Cartão', rail_ach_card: 'Transferência (ACH) ou cartão', no_fee: '— sem taxa para você.', zelle_wire: 'Zelle ou wire também.',
  fl_estimate_title: 'SEU ORÇAMENTO POR ESCRITO (FLÓRIDA)', terms_title: 'CONDIÇÕES DESTE ORÇAMENTO',
  approve_title: 'APROVAR ESTE ORÇAMENTO', sign_name: 'Seu nome',
  co_title: 'ADITIVO #{n}', co_intro: 'Preparamos uma alteração no seu projeto. Veja exatamente o que muda:', co_added: 'Incluído', co_removed: 'Retirado', co_changed: 'Alterado',
  co_total: 'Total {before} → {after}', co_plan: 'Novo plano de pagamento', co_consent: 'Aprovo este aditivo e o novo total.', co_approve_btn: '✍ APROVAR A ALTERAÇÃO — {amount}',
  co_pending_pay: 'Os pagamentos voltam depois que esta alteração for aprovada.', co_pending: 'Os pagamentos voltam depois que o aditivo for aprovado.', co_applied: 'Aditivo #{n} aprovado — o documento abaixo está atualizado.',
  consent_erecords: 'Concordo em receber e assinar este orçamento eletronicamente. Cópia em papel a pedido.',
  consent_terms: 'Li e aceito as condições deste orçamento (acima).',
  est_label: 'Orçamento por escrito', est_REQUEST: 'Este documento', est_LIMIT: 'Só acima de US$', est_WAIVE: 'Não preciso',
  parts_label: 'Peças substituídas', parts_RETURN: 'Devolver para mim', parts_INSPECT: 'Guardar para inspeção', parts_NONE: 'Não precisa',
  gate_phone: 'Para assinar, confirme o telefone terminado em ••{last2}', gate_email: 'Para assinar, confirme o e-mail {masked}',
  gate_phone_ph: '4 últimos dígitos', gate_email_ph: 'seu e-mail',
  approve_btn: '✍ APROVAR E ASSINAR — {amount}', next_pay: 'Depois: pagar o sinal de {amount}.',
  request_changes: 'Pedir alterações', not_now: 'Agora não', approve_reopen: '▸ Aprovar este orçamento', contact_us: '💬 Falar com a GZ28',
  contact_sheet: 'Fale conosco no {channel}: {handle} (toque para copiar)', copied: 'Copiado',
  print: '🖨 Imprimir / salvar PDF',
  approved_by: '✓ Aprovado por {name} · {when} (Orlando)', approved_shop: '✓ Aprovado ({method}) · {when} (Orlando)',
  deposit_due: 'SINAL A PAGAR AGORA — {amount}', installment_due: 'A PAGAR AGORA — {amount}', pay_card: 'Pagar {amount} no cartão', pay_online: 'Pagar {amount} online', pay_online_hint: 'Cartão, transferência bancária, financiamento e mais — você escolhe na próxima tela.', pay_ach: 'Pagar {amount} por transferência (ACH)',
  prefer_zelle: 'Prefere Zelle ou wire? Toque para ver as instruções', zelle_sheet: 'Zelle: {zelle}\nWire: peça os dados à GZ28.\nReferência: {code}',
  i_sent_it: 'Já enviei', promised_ok: '✓ Obrigado — a GZ28 confirma quando chegar.',
  stripe_foot: 'Pagamentos processados com segurança pela Stripe.',
  clearing: '⏳ Sinal de {amount} autorizado em {date} — em compensação no seu banco, até 4 dias úteis. O projeto abre assim que compensar. A Stripe enviou por e-mail a autorização do débito.',
  clearing_microdeposits: 'A Stripe enviou dois pequenos depósitos para a sua conta — confirme pelo e-mail da Stripe (até 10 dias).',
  clearing_no_card: 'Pagamento com cartão indisponível enquanto uma transferência está pendente.',
  failed: 'O seu banco devolveu o pagamento ({reason}). Nada foi cobrado.', pay_again: 'Pagar de novo',
  'fail_reason.verification_timeout': 'conta bancária não verificada no prazo', 'fail_reason.generic': 'pagamento não concluído',
  deposit_refunded: 'Seu sinal de {amount} foi devolvido em {date}. Seu projeto continua; o sinal volta a ser devido.',
  hired: '🏁 Confirmado. Projeto {code} — {car}.', formerly: 'antes orçamento {old_code} (até {date})', paid: 'PAGO',
  balance_pending_update: 'Seu saldo final está sendo atualizado — a GZ28 vai enviar o valor revisado.',
  changes_title: 'O que você gostaria de mudar?', changes_send: 'Enviar pedido', changes_received: 'Recebemos o seu pedido em {date} e vamos enviar um orçamento revisado.',
  decline_title: 'Não vai seguir?', decline_btn: 'Recusar este orçamento', decline_confirm: 'Confirmar recusa', reason_TIMING: 'Prazo', reason_SCOPE: 'Escopo', reason_OTHER: 'Outro',
  declined: 'Você recusou este orçamento em {date}.', undo_decline: 'Mudei de ideia',
  superseded: 'A GZ28 está preparando uma nova versão deste orçamento — ela vai aparecer aqui.',
  expired: 'Este orçamento venceu em {date}.', ask_renewal: 'Ainda tem interesse? Peça à GZ28 para renovar', renewal_asked: '✓ Pedido enviado — a GZ28 vai retornar',
  void: 'Este orçamento não está mais disponível.', not_found: 'Este link não é válido.', inactive: 'Esta página ainda não está disponível. Fale com a GZ28.',
  return_no_session: 'Pagamento recebido — estamos confirmando. Abra de novo o link do orçamento para ver a confirmação.',
  landing_pending: 'Estamos confirmando o seu pagamento… esta página se atualiza sozinha.',
  landing_timeout: 'Ainda confirmando — não precisa fazer mais nada; o recibo aparece aqui. Você não será cobrado duas vezes.',
  open_in_browser: 'Para pagar sem percalços, abra esta página no seu navegador.',
  err_stale: 'Este orçamento acabou de ser atualizado — a página vai recarregar com a versão atual.', err_rate: 'Muitas tentativas — espere um pouco e tente de novo.',
  err_pay_unavailable: 'O pagamento online não está disponível agora — use Zelle ou wire abaixo, ou fale com a GZ28.',
  err_gate: 'Não bate com o nosso cadastro', err_gate_locked: 'Muitas tentativas — tente em {minutes} minutos ou fale com a GZ28',
  err_limit: 'Informe o valor acima do qual quer orçamento por escrito', err_name: 'Digite o seu nome completo', err_consent: 'Marque as duas caixas para aprovar',
  err_choice: 'Escolha uma opção para o orçamento por escrito e para as peças substituídas', offline: 'Parece que você está sem conexão — confira a internet.',
  err_generic: 'Algo deu errado — tente de novo ou fale com a GZ28.',
  certificate: 'CERTIFICADO DE ASSINATURA', hash_hint: 'Impressão digital do documento (SHA-256)', signed_copy: '⬇ Sua cópia assinada',
  'method.SHOP_PHONE': 'por telefone', 'method.SHOP_IN_PERSON': 'pessoalmente', 'method.SHOP_TEXT': 'por mensagem', 'method.SHOP_EMAIL': 'por e-mail',
  'method.CLIENT_ESIGN': 'assinatura eletrônica', 'method.LEGACY_HIRING_DATE': 'registrado pela GZ28',
  otp_intro_WHATSAPP: 'Para assinar, vamos enviar um código de 6 dígitos pelo WhatsApp para o número terminado em {masked}.',
  otp_intro_EMAIL: 'Para assinar, vamos enviar um código de 6 dígitos por e-mail para {masked}.',
  otp_send: 'Enviar o código', otp_resend: 'Enviar um novo código', otp_resend_wait: 'Novo código em {seconds}s',
  otp_sent: 'Código enviado — vale por 10 minutos.', otp_ph: 'código de 6 dígitos', otp_verified: '✓ Código confirmado',
  err_otp: 'Código não confere — restam {left} tentativas', err_otp_locked: 'Muitos códigos errados — tente em {minutes} minutos ou fale com a GZ28',
  err_otp_expired: 'Este código venceu — peça um novo', err_otp_wait: 'Espere {seconds}s para pedir um novo código',
  err_otp_required: 'Digite o código que enviamos', err_otp_none: 'Peça um código primeiro',
  err_otp_send: 'Não conseguimos enviar o código — tente de novo ou fale com a GZ28', err_otp_no_channel: 'Não temos telefone nem e-mail para enviar o código — fale com a GZ28',
  otp_message: 'GZ28 V8 SpeedShop — seu código para assinar {code}: {otp}. Vale por 10 minutos. Nunca compartilhe este código.',
  otp_mail_subject: 'Seu código de assinatura — {code}', otp_mail_intro: 'Aqui está o seu código para assinar {code}:',
  otp_mail_foot: 'Vale por 10 minutos. Se você não pediu, ignore este e-mail e nunca compartilhe o código.',
}

export const STRINGS: Record<Lang, Dict> = { en: EN, pt: PT }

export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

export function money(n: number, lang: Lang = 'en'): string {
  return 'US$ ' + new Intl.NumberFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
export const moneyCents = (c: number, lang: Lang = 'en') => money(Math.round(c) / 100, lang)
