#!/usr/bin/env node
// AGORA — a única fonte de hora deste projeto. Ver a lei "O RELÓGIO" no AGENTS.md.
//
//   node scripts/agora.mjs                       -> agora, nos dois fusos
//   node scripts/agora.mjs <iso|epoch> [outro]    -> converte e mede o intervalo
//
// Existe porque `date` e `TZ=... date` do Git Bash devolvem UTC rotulado como GMT
// nesta máquina, e porque duração estimada de cabeça sempre sai errada.

const Z = { Orlando: 'America/New_York', 'Brasília': 'America/Sao_Paulo' }
const f = (d, tz) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d)

const parse = s => { const n = Number(s); const d = new Date(/^\d{10}$/.test(s) ? n * 1000 : /^\d{13}$/.test(s) ? n : s); if (isNaN(+d)) { console.error(`não entendi a data: ${s}`); process.exit(1) } return d }

const dur = ms => {
  const s = Math.abs(Math.round(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60)
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}min`].filter(Boolean).join(' ')
}

const [a, b] = process.argv.slice(2)
const alvo = a ? parse(a) : new Date()
const ref = b ? parse(b) : new Date()

for (const [nome, tz] of Object.entries(Z)) console.log(`${nome.padEnd(9)} ${f(alvo, tz)}`)
console.log(`${'UTC'.padEnd(9)} ${alvo.toISOString()}`)
if (a) console.log(`\n${alvo > ref ? 'daqui a' : 'faz'} ${dur(alvo - ref)}${b ? ' (em relação à 2ª data)' : ''}`)
