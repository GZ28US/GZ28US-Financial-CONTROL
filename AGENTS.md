<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:relogio -->
# O RELÓGIO — lei, vale para tudo

**Nunca escreva hora, data ou duração sem a máquina ter calculado.** Nem "hoje de manhã",
nem "faz umas 2 horas", nem "ontem". Cabeça não conta tempo; `scripts/agora.mjs` conta.

```bash
node scripts/agora.mjs                      # agora, em Orlando e em Brasília
node scripts/agora.mjs 2026-09-02T20:00:00Z # converte e diz quanto tempo faz
```

Três motivos pelos quais isso já quebrou trabalho de verdade:

1. **Toda API devolve UTC** — Graph, Gmail, Supabase, UltraMsg, PayPal, carriers. Colar o
   campo cru na tela adianta 4h e, entre 00:00 e 04:00 UTC, **joga o dia inteiro pra frente**:
   um e-mail das 23h51 de Orlando vira "02/09" no relato e a cronologia inverte.
2. **`date` e `TZ=... date` do Git Bash MENTEM** nesta máquina — devolvem UTC rotulado como
   GMT, sem erro. Só `Intl.DateTimeFormat` com `timeZone` explícito acerta. (O relógio do
   Windows em si está certo; conferido contra servidor externo em 03/set/2026, 1s de erro.)
3. **Duração estimada de cabeça é chute.** Em 03/set eu disse "quase 24 horas" para um
   intervalo de 20h35. Se o número importa, calcule.

**O fuso segue o ASSUNTO, não a fonte do dado:** thread US → `America/New_York`;
thread BR → `America/Sao_Paulo`. Diga o fuso quando houver chance de dúvida.

**Em script que imprime timestamp**, o formatador nasce no topo e nada escapa dele:

```js
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const L = s => fmt.format(new Date(s)).replace(',', '')
```
<!-- END:relogio -->
