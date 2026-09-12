#!/usr/bin/env node
// SOBE A LOJA — o único caminho para publicar C:\Users\gz28u\gz28shop-us.
//
//   node scripts/sobe-loja.mjs            # só diz quem sou e o que subiria
//   node scripts/sobe-loja.mjs --confirmo # sobe para produção
//
// POR QUE EXISTE (12/set/2026). A loja NÃO tem remote git: o app do US e o do BR
// sobem sozinhos no push do master, ela não. O único jeito é `vercel --prod` rodado
// daquela pasta, e o CLI desta máquina vive deslogado. Em vez de sessão interativa,
// um TOKEN em memory/vercel-token.txt — lido DENTRO deste script e passado ao CLI
// pela variável de ambiente VERCEL_TOKEN, NUNCA em argv (argv aparece na lista de
// processos; é a mesma lei do `?key=` na URL). O token nunca é impresso.
//
// Escopo do token: o time dono dos três projetos (team_kz2m0UuUN7AjvAGk0RLqt1Wk —
// gz28-speedshop-control, gz-28-br-control-app e gz28shop-us). Token de conta
// pessoal devolveria "project not found", que parece outro problema.
// Vence em 11/dez/2026; quando vencer, o deploy falha ALTO, não em silêncio.

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const LOJA = 'C:\\Users\\gz28u\\gz28shop-us'
const TOKEN = 'C:/Users/gz28u/.claude/projects/C--Users-gz28u-Dropbox-001---GZ28US-GZ28US-Tad-Control-App/memory/vercel-token.txt'
const morre = m => { console.error('\n✖ ' + m + '\n'); process.exit(1) }

if (!fs.existsSync(TOKEN)) morre(`não achei ${TOKEN}\n    Crie em vercel.com/account/tokens, escopo do TIME (não da conta pessoal).`)
const token = fs.readFileSync(TOKEN, 'utf8').trim()
if (!token) morre('o arquivo do token está vazio')

const env = { ...process.env, VERCEL_TOKEN: token }
// SEM `shell: true`. O Node avisa com razão: com shell ligado os argumentos são
// CONCATENADOS numa linha de comando, não escapados — e esta pasta tem espaço no
// caminho. No Windows o executável é `npx.cmd`; chamando ele direto, cada argumento
// vai inteiro e ninguém precisa confiar em aspas.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const roda = (args, opts = {}) => spawnSync(NPX, ['--yes', 'vercel', ...args], { cwd: LOJA, env, encoding: 'utf8', ...opts })

// A saída do CLI pode ecoar o token em mensagem de erro; nunca deixo passar cru.
const limpa = s => String(s || '').split(token).join('<TOKEN>')

const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
console.log(`\n── loja: ${LOJA}`)
console.log(`   ${fmt.format(new Date()).replace(',', '')} Orlando`)

const quem = roda(['whoami'])
const nome = limpa(quem.stdout).trim().split('\n').filter(l => l && !/^Vercel CLI|^>/.test(l)).pop()
if (quem.status !== 0) morre('o token não passou:\n' + limpa(quem.stderr).slice(0, 600))
console.log(`   token OK · conta: ${nome}`)

const git = spawnSync('git', ['-C', LOJA, 'log', '--oneline', '-3'], { encoding: 'utf8' })
console.log('   commits locais:\n' + git.stdout.split('\n').filter(Boolean).map(l => '     · ' + l.slice(0, 90)).join('\n'))
const sujo = spawnSync('git', ['-C', LOJA, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
if (sujo) console.log('   ⚠ árvore suja — o deploy leva o que está no disco, não o último commit:\n' + sujo.split('\n').map(l => '     ' + l).join('\n'))

if (!process.argv.includes('--confirmo')) {
  console.log('\n   NADA FOI PUBLICADO. Repita com --confirmo para subir para produção.\n')
  process.exit(0)
}

console.log('\n── publicando em produção…')
const dep = roda(['--prod', '--yes'], { stdio: 'pipe' })
const saida = limpa(dep.stdout) + limpa(dep.stderr)
console.log(saida.split('\n').slice(-25).join('\n'))
if (dep.status !== 0) morre('o deploy falhou (veja acima)')
console.log('\n✓ publicado. AGORA CONFIRA POR FORA: a loja no ar e o espelho gravando — resposta de quem publicou não é prova.\n')
