'use client'

// FIN SYNC ▸ AUTOBOOK — O LIVRO DO ROBÔ (Márcio, 10/set/2026).
// Esta página só DESENHA lib/autoBookLivro.ts. Regra nova entra lá, nunca aqui:
// assim o texto da regra tem um lugar só, e a tela não tem como discordar dele.
import { useState } from 'react'
import Header from '@/components/Header'
import { SEQUENCIA, OUTRAS_BOCAS, ESTADOS, LIVRO_ATUALIZADO, type Estado, type Etapa, type Regra } from '@/lib/autoBookLivro'

const COR: Record<Estado, string> = {
  'NO AR': 'bg-green-950 text-green-300 border-green-800',
  'À MÃO': 'bg-sky-950 text-sky-300 border-sky-800',
  'EM CONSTRUÇÃO': 'bg-amber-950 text-amber-300 border-amber-800',
  'FURO': 'bg-red-950 text-red-300 border-red-800',
}
const COR_NOTA: Record<Estado, string> = {
  'NO AR': 'text-gray-400',
  'À MÃO': 'text-gray-400',
  'EM CONSTRUÇÃO': 'text-amber-200',
  'FURO': 'text-red-300',
}

const TODAS: Regra[] = [...SEQUENCIA, ...OUTRAS_BOCAS].flatMap((e) => e.regras)
const CONTA = TODAS.reduce((m, r) => ({ ...m, [r.estado]: (m[r.estado] || 0) + 1 }), {} as Partial<Record<Estado, number>>)
const dataBR = (iso: string) => iso.split('-').reverse().join('/')

// Busca como nas listas do app: palavras em qualquer ordem, sem acento.
const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
function passa(r: Regra, busca: string, filtro: Estado | null): boolean {
  if (filtro && r.estado !== filtro) return false
  const palavras = semAcento(busca).split(/\s+/).filter(Boolean)
  if (!palavras.length) return true
  const alvo = semAcento([r.id, r.texto, r.fala, r.nota, r.onde, r.desde].filter(Boolean).join(' '))
  return palavras.every((p) => alvo.includes(p))
}

function LinhaDaRegra({ r }: { r: Regra }) {
  const rodape = [r.desde && !r.fala ? `desde ${r.desde}` : null, r.onde].filter(Boolean).join(' · ')
  return (
    <li className="py-3 flex gap-3">
      <span className="font-mono text-xs text-gray-500 pt-1 w-10 shrink-0">{r.id}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-3 flex-wrap">
          <p className="flex-1 min-w-[14rem] leading-relaxed">{r.texto}</p>
          <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border whitespace-nowrap ${COR[r.estado]}`}>{r.estado}</span>
        </div>
        {r.fala && (
          <p className="mt-1.5 text-sm text-gray-300 italic">
            «{r.fala}»<span className="not-italic text-gray-500"> — Márcio{r.desde ? `, ${r.desde}` : ''}</span>
          </p>
        )}
        {r.nota && <p className={`mt-1.5 text-sm ${COR_NOTA[r.estado]}`}>{r.nota}</p>}
        {rodape && <p className="mt-1.5 text-xs text-gray-500 font-mono break-words">{rodape}</p>}
      </div>
    </li>
  )
}

function CartaoDaEtapa({ e }: { e: Etapa }) {
  return (
    <section id={`etapa-${e.id}`} className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-3xl font-bold text-gray-600 tabular-nums">{e.id}</span>
        <h3 className="text-xl font-bold">{e.titulo}</h3>
      </div>
      <p className="text-gray-400 text-sm mb-2">{e.resumo}</p>
      <ol className="flex flex-col divide-y divide-gray-800">
        {e.regras.map((r) => <LinhaDaRegra key={r.id} r={r} />)}
      </ol>
    </section>
  )
}

export default function AutoBookPage() {
  const [busca, setBusca] = useState('')
  const [filtro, setFiltro] = useState<Estado | null>(null)

  const recorte = (lista: Etapa[]) => lista
    .map((e) => ({ ...e, regras: e.regras.filter((r) => passa(r, busca, filtro)) }))
    .filter((e) => e.regras.length)
  const sequencia = recorte(SEQUENCIA)
  const bocas = recorte(OUTRAS_BOCAS)
  const vistas = [...sequencia, ...bocas].reduce((s, e) => s + e.regras.length, 0)
  const recortado = !!filtro || !!busca.trim()

  const chip = (ativo: boolean) =>
    `px-4 py-2 rounded-2xl text-sm font-bold border ${ativo ? 'bg-white text-black border-white' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'}`

  return (
    <main className="min-h-screen bg-black text-white p-8 pb-24">
      <Header />
      <div className="max-w-5xl">
        <div className="flex items-baseline gap-3 flex-wrap mb-1">
          <h1 className="text-4xl font-bold">AUTOBOOK</h1>
          <span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span>
        </div>
        <p className="text-gray-300 mb-1">
          O livro do robô: toda regra, na ordem em que o gasto ou a receita anda — do e-mail que chega até a linha registrada no app.
        </p>
        <p className="text-gray-500 text-sm mb-6">{TODAS.length} regras · atualizado em {dataBR(LIVRO_ATUALIZADO)}</p>

        <input
          value={busca}
          onChange={(ev) => setBusca(ev.target.value)}
          placeholder="SEARCH — regra, fornecedor, função, palavra"
          className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 mb-3 outline-none focus:border-gray-500"
        />
        <div className="flex gap-2 flex-wrap mb-3">
          <button onClick={() => setFiltro(null)} className={chip(!filtro)}>TODAS {TODAS.length}</button>
          {ESTADOS.map(({ estado }) => (
            <button key={estado} onClick={() => setFiltro(filtro === estado ? null : estado)} className={chip(filtro === estado)}>
              {estado} {CONTA[estado] || 0}
            </button>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 mb-6 text-xs text-gray-400">
          {ESTADOS.map(({ estado, diz }) => (
            <p key={estado}><span className={`px-2 py-0.5 rounded-full font-bold border mr-2 ${COR[estado]}`}>{estado}</span>{diz}</p>
          ))}
        </div>

        {!recortado && (
          <nav className="flex gap-2 flex-wrap mb-8">
            {[...SEQUENCIA, ...OUTRAS_BOCAS].map((e) => (
              <a key={e.id} href={`#etapa-${e.id}`} className="text-xs font-bold px-3 py-1.5 rounded-full bg-gray-900 border border-gray-800 hover:border-gray-600">
                {e.id} · {e.titulo}
              </a>
            ))}
          </nav>
        )}
        {recortado && <p className="text-sm text-gray-400 mb-6">{vistas} de {TODAS.length} regras neste recorte.</p>}

        {sequencia.length > 0 && (
          <>
            <h2 className="text-sm font-bold text-gray-400 tracking-widest mb-3">A SEQUÊNCIA — DO E-MAIL AO APP</h2>
            <div className="flex flex-col gap-4 mb-10">
              {sequencia.map((e) => <CartaoDaEtapa key={e.id} e={e} />)}
            </div>
          </>
        )}
        {bocas.length > 0 && (
          <>
            <h2 className="text-sm font-bold text-gray-400 tracking-widest mb-3">OUTRAS BOCAS — ZELLE, PAPEL SEM E-MAIL E GRUPOS DO BR</h2>
            <div className="flex flex-col gap-4 mb-10">
              {bocas.map((e) => <CartaoDaEtapa key={e.id} e={e} />)}
            </div>
          </>
        )}
        {vistas === 0 && <p className="text-gray-400 mb-10">Nenhuma regra neste recorte.</p>}

        <div className="border border-gray-800 rounded-2xl p-5 text-sm text-gray-400">
          <p className="font-bold text-gray-200 mb-2">COMO ESTE LIVRO SE MANTÉM</p>
          <p>
            Regra nova de AutoBook entra aqui no dia em que é ditada — EM CONSTRUÇÃO se o robô ainda não faz, À MÃO se quem faz é gente.
            O commit que põe a regra em código muda o estado para NO AR, apontando a função que executa. O número de cada regra não muda:
            é por ele que conversa, recado e código citam a regra.
          </p>
          <p className="mt-2 font-mono text-xs text-gray-500">fonte: lib/autoBookLivro.ts</p>
        </div>
      </div>
    </main>
  )
}
