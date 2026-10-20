# ROBÔ DO RASTREIO CEGO — a rotina da loja (LIVRO 13.10)

> «o robô tem que entrar na Amazon e checar a order, mas não pode "abandonar" o caso, info is power» — Márcio, 19/10/2026

Compra **paga**, com **número de pedido** e **sem número de rastreio** é «rastreio cego»: o 17TRACK não tem o que perguntar,
quem sabe dela é a loja. Esta rotina é para uma sessão do Claude com o **Claude in Chrome** no Chrome do Márcio, onde
Amazon, eBay e Temu já ficam logados. Ela lê a página de cada pedido e devolve a leitura ao app.

## As leis da rotina (não negociáveis)

1. **Só leitura nas lojas.** Abrir a página do pedido e ler. Nenhum clique que mude pedido (cancelar, devolver, «problem
   with order», confirmar recebimento, avaliar), nenhuma mensagem ao vendedor, nenhum chat de suporte, nenhum banner aceito
   além do mínimo para ler a página.
2. **Nunca digitar senha, nunca sair da conta.** Se a loja pedir login, CAPTCHA ou código: parar aquela loja, gravar
   `UNREADABLE` com o motivo e avisar o Márcio no relato. Ele loga; a rotina opera.
3. **Nunca abandonar.** Pedido que não abriu também é gravado (`UNREADABLE`): o carimbo «last checked» prova que alguém olhou.
4. **Hora só pela máquina.** `node scripts/agora.mjs` no começo; a data que a loja mostra («Delivered October 14») é data
   de Orlando e vai como `YYYY-MM-DD`.
5. Toda escrita passa pela rota — nunca SQL direto. A rota grava a trilha em `data_fixes` (check_key `store-check`).

## Passo a passo

**1. A fila** (chave de leitura em `memory/whatsapp-read-key.txt`, lida dentro do script, nunca em argv/echo):

```
GET https://www.gz28us.com/ca/api/items/store-check      header x-read-key
→ { robot_queue, never_checked, queue: [{ store, order_number, url, last_checked, lines: [{table,id,item,last_event,eta}] }] }
```

A fila já vem na ordem certa: nunca lido primeiro, depois o lido há mais tempo.

**2. Para cada pedido**, numa aba nova do Chrome (nunca nas abas do Márcio): `navigate` para `url` e `get_page_text`.

| Loja | Página | Onde está o status |
|---|---|---|
| AMAZON | `amazon.com/gp/your-account/order-details?orderID=…` | cabeçalho de cada remessa: «Delivered October 14», «Arriving Thursday», «Shipped», «Not yet shipped», «Cancelled», «Return complete». «Track package» mostra transportadora e número quando é UPS/USPS. |
| EBAY | `order.ebay.com/ord/show?orderId=…` | «Delivered on Tue, Oct 14», «Estimated delivery …», «Shipped», «Awaiting shipment»; a transportadora e o tracking aparecem quando o vendedor postou. |
| TEMU | `temu.com/bgt_order_detail.html?parent_order_sn=…` | «Delivered», «Shipped», «Processing»; o tracking aparece em «Track». |

Se a página não abre pelo link direto: abrir a lista de pedidos da loja e procurar pelo número (só busca e leitura).

**3. Reduzir a leitura a um estado:**

| state | quando |
|---|---|
| `DELIVERED` | a loja diz entregue, COM data → `delivered_on` (YYYY-MM-DD) é obrigatório. Atenção ao eBay: «Delivered — Upcoming step» NÃO é entregue |
| `MOVING` | despachado / a caminho / atrasado / saiu para entrega → `eta` se houver |
| `WAITING` | pedido feito, ainda não despachado → `eta` se houver |
| `PROBLEM` | cancelado, devolvido, reembolsado, não entregue, extraviado — a rota **não** mexe em `cancel_status` (isso é fato de humano); o caso vai no relato ao Márcio / AutoBook |
| `UNREADABLE` | não abriu, não achou o pedido, pediu login/CAPTCHA |

Se a loja mostrar **número de rastreio**, mande `tracking_number` + `carrier`: a linha sai do cego e o 17TRACK assume na
próxima passada (:37). Pedido com várias caixas em estados diferentes: uma leitura por caixa, com `lines` só daquela caixa.

**4. Gravar** (até 50 leituras por chamada):

```
POST https://www.gz28us.com/ca/api/items/store-check      header x-read-key, JSON
{ "readings": [
  { "store": "AMAZON", "order_number": "111-0812415-2976241", "state": "DELIVERED",
    "status_text": "Delivered October 15", "delivered_on": "2026-10-15" },
  { "store": "EBAY", "order_number": "26-15270-55144", "state": "MOVING",
    "status_text": "Shipped — estimated delivery Oct 26–31", "eta": "2026-10-31",
    "tracking_number": "9400…", "carrier": "USPS" }
] }
```

`status_text` é o que a loja escreve, curto, em inglês como está na página. Vira o `last_event` da linha («AMAZON: …»).

**5. Relatar** ao Márcio (português, horário de Orlando): quantos pedidos lidos, quantos viraram DELIVERED, os `PROBLEM`
(cancelado/devolvido que ainda não tem `cancel_status` — é da AutoBook), e as lojas que pediram login.

## O que o app faz com a leitura

- `DELIVERED` → `delivered_at` (meio-dia de Orlando do dia que a loja mostrou), só se estava vazio. Entrega gravada nunca se desfaz.
- O resto → `last_event` («AMAZON: Arriving Thursday»), `eta`, e sempre `store_checked_at`.
- No STREAM (aba BOUGHT) a linha mostra o chip **RASTREIO CEGO · LOJA · last checked dd/mm hh:mm** (âmbar «never checked»
  enquanto ninguém leu) e a última leitura embaixo do fornecedor.

Código: `lib/deliverStatus.ts` (isBlindTracking, blindStore, storeOrderUrl) · `lib/storeCheck.server.ts` · `app/api/items/store-check/route.ts` · `app/stream/page.tsx`.
