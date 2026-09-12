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
// COM shell, mas o comando vai como UMA STRING — que é a forma suportada e a que não
// dispara o aviso DEP0190 do Node (o aviso é sobre passar ARRAY de argumentos junto
// com shell: true, porque aí eles são concatenados sem escape). Chamar `npx.cmd`
// direto, sem shell, não é opção: desde o conserto do CVE-2024-27980 o Node recusa
// executar .cmd/.bat sem shell. O que entra aqui são literais fixos (`whoami`,
// `--prod`, `--yes`) — nada de fora, nada com espaço; o caminho com espaço vai no
// `cwd`, que não passa pelo shell.
const roda = (args, opts = {}) => spawnSync(`npx --yes vercel ${args.join(' ')}`, { cwd: LOJA, env, encoding: 'utf8', shell: true, ...opts })

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
