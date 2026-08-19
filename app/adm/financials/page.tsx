'use client'

// FINANCIAL — hub das demonstrações financeiras (ADM → FINANCIAL).
// Três telas, um dataset (lib/financials): DFC completa desde o dia um;
// DRE e Balanço mostram o que já dá para derivar e dizem na cara o que
// ainda falta (decisões D1–D11 e gaps G1–G8 do blueprint).
import Header from '@/components/Header'
import { BASE_PATH } from '@/lib/utils'

const CARDS = [
  {
    href: '/adm/financials/dfc', title: 'DFC', sub: 'Fluxo de Caixa',
    status: 'COMPLETA', statusCls: 'bg-emerald-950 text-emerald-400',
    desc: 'Método direto, regime de caixa. Colunas por mês ou por ano, célula clicável até a linha de origem. Pronta desde o primeiro dado.',
  },
  {
    href: '/adm/financials/dre', title: 'DRE', sub: 'Resultado do Exercício',
    status: 'ACUMULADA', statusCls: 'bg-amber-950 text-amber-300',
    desc: 'Competência, as-booked, acumulado desde o início. Ganha colunas por período quando as datas de conclusão forem preenchidas (G1).',
  },
  {
    href: '/adm/financials/balance', title: 'BALANÇO', sub: 'Patrimonial',
    status: 'PARCIAL', statusCls: 'bg-red-950 text-red-400',
    desc: 'A foto de hoje: A/R, WIP, estoque, frota própria (CAR DESTINY), a pagar. Não fecha até existirem caixa, capital e empréstimos (Fase 2).',
  },
]

export default function FinancialsHub() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <div className="flex items-baseline gap-4 flex-wrap mb-1"><h1 className="text-4xl font-bold">FINANCIAL</h1><span className="px-3 py-1 rounded-full text-xs font-bold bg-amber-950 text-amber-300">EM DESENVOLVIMENTO</span></div>
      <p className="text-gray-400 mb-8 max-w-3xl">As demonstrações da GZ28 V8 SpeedShop USA LLC, direto do banco de dados — as três telas leem o mesmo dataset para os números baterem entre si.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl">
        {CARDS.map(c => (
          <a key={c.href} href={`${BASE_PATH}${c.href}`}
            className="bg-gray-900 border border-gray-700 rounded-3xl p-6 hover:bg-gray-800 hover:border-gray-500 transition-colors flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-3xl font-bold">{c.title}</span>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${c.statusCls}`}>{c.status}</span>
            </div>
            <p className="text-lg font-bold text-gray-300">{c.sub}</p>
            <p className="text-sm text-gray-400">{c.desc}</p>
          </a>
        ))}
      </div>
    </main>
  )
}
