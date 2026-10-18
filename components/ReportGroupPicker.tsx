'use client'
// O GRUPO DE CADA REPORT DA PERFORMANCE (Márcio, 18/10/2026): «quando for solicitado o envio de qualquer report da área de
// performance, o usuário deverá escolher entre o Tcal US ou o Ghost Performance, sempre com a opção marcável de mandar pro cliente
// também. Faça este recurso novo. Assim não vou precisar mais te pedir pra ficar alternando isso.»
// Nada vem marcado: o SEND só acende depois da escolha. Vale para puxada do dyno, DynoData, DataSheet e pista (1/4 · 1/8 · 100-200).
// O nome é o do grupo no WhatsApp (toGroupName da /api/whatsapp).

export const REPORT_GROUPS = [
  { label: 'Tcal US', name: 'GZ28US - Tcal' },
  { label: 'Ghost Performance', name: 'GZ28 & Ghost Performance' },
] as const

export function ReportGroupPicker({ value, onChange, disabled }: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-bold text-gray-400">SEND TO WHICH GROUP?</span>
      <div className="flex gap-3">
        {REPORT_GROUPS.map((g) => (
          <button key={g.name} type="button" disabled={disabled} onClick={() => onChange(g.name)}
            className={`flex-1 px-4 py-3 rounded-2xl font-bold text-lg border-2 disabled:opacity-50 ${value === g.name ? 'bg-green-700 border-green-500 text-white' : 'bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
            {g.label}
          </button>
        ))}
      </div>
      {!value && <span className="text-xs text-yellow-400">Pick the group to enable SEND.</span>}
    </div>
  )
}
