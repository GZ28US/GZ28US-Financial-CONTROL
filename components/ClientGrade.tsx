'use client'

// ════════════════════════════════════════════════════════════════════════════
// components/ClientGrade.tsx · 23/out/2026 — A NOTA DO CLIENTE (0–10), dada pela casa
//
// Márcio: «create a grade to each client in the apps» / «criou o campo notas pros clientes? urgente isso».
// clients.grade (0–10) + clients.grade_note (o porquê) + clients.grade_at (quando a nota mudou).
// INTERNA: o formulário do próprio cliente (/clients/self, RPC client_self_get) não lê nem grava estes campos.

export function gradeColor(g: number | null | undefined): string {
  if (g == null) return 'bg-gray-800 text-gray-400'
  if (g >= 8) return 'bg-green-800 text-green-200'
  if (g >= 5) return 'bg-yellow-800 text-yellow-100'
  return 'bg-red-800 text-red-200'
}

export function GradeBadge({ grade, note, big }: { grade: number | null | undefined; note?: string | null; big?: boolean }) {
  if (grade == null) return null
  return (
    <span title={note || undefined} className={`inline-block rounded-full font-bold align-middle ${big ? 'px-4 py-2 text-2xl' : 'px-3 py-1 text-sm'} ${gradeColor(grade)}`}>
      ★ {grade}/10
    </span>
  )
}

export function GradeEditor({ grade, note, onChange }: { grade: number | null; note: string; onChange: (grade: number | null, note: string) => void }) {
  return (
    <div>
      <label className="block mb-2 text-sm text-gray-400 font-bold">CLIENT GRADE (0–10) · INTERNAL, THE CLIENT NEVER SEES IT</label>
      <div className="flex flex-wrap gap-2 mb-3">
        {Array.from({ length: 11 }, (_, i) => i).map((g) => (
          <button key={g} type="button" onClick={() => onChange(g, note)}
            className={`w-12 h-12 rounded-xl text-lg font-bold border ${grade === g ? `${gradeColor(g)} border-white` : 'bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800'}`}>
            {g}
          </button>
        ))}
        <button type="button" onClick={() => onChange(null, note)}
          className={`px-4 h-12 rounded-xl text-sm font-bold border ${grade == null ? 'bg-gray-700 border-white text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-800'}`}>
          NO GRADE
        </button>
      </div>
      <textarea placeholder="WHY THIS GRADE (pays on time, haggles, loyal, problems...)" value={note} rows={3}
        onChange={(e) => onChange(grade, e.target.value)}
        className="w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl" />
    </div>
  )
}
