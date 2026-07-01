'use client'

import { useState } from 'react'

type Props = {
  label: string
  value: string
  onChange: (value: string) => void
  compact?: boolean
}

const months = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
]

const currentYear = new Date().getFullYear()
// Newest year first (descending) in the dropdown.
const years = Array.from({ length: currentYear - 2024 }, (_, i) => currentYear - i)

// Days in a given month/year. Falls back to 31 when the month is unset, and to a
// leap year when the year is unset so Feb 29 stays available until a year is
// picked. Prevents building impossible dates like 2026-02-31 (which the DB rejects).
function daysInMonth(month: string, year: string): number {
  const m = parseInt(month, 10)
  if (!m || m < 1 || m > 12) return 31
  const y = parseInt(year, 10) || 2024
  return new Date(y, m, 0).getDate()
}

export default function DatePicker({ label, value, onChange, compact }: Props) {
  const parsed = value && value.match(/^\d{4}-\d{2}-\d{2}$/) ? value.split('-') : ['', '', '']

  const [internalYear, setInternalYear] = useState(parsed[0] || '')
  const [internalMonth, setInternalMonth] = useState(parsed[1] || '')
  const [internalDay, setInternalDay] = useState(parsed[2] || '')

  function update(newYear: string, newMonth: string, newDay: string) {
    // Clamp the day to the chosen month/year so a leftover out-of-range pick
    // (e.g. day 31 carried over from January when switching to February) can
    // never form an invalid date string.
    const max = daysInMonth(newMonth, newYear)
    if (newDay && parseInt(newDay, 10) > max) newDay = String(max).padStart(2, '0')
    setInternalYear(newYear)
    setInternalMonth(newMonth)
    setInternalDay(newDay)

    if (newYear && newMonth && newDay) {
      onChange(`${newYear}-${newMonth}-${newDay}`)
    } else {
      onChange('')
    }
  }

  function clear() {
    setInternalYear('')
    setInternalMonth('')
    setInternalDay('')
    onChange('')
  }

  const days = Array.from({ length: daysInMonth(internalMonth, internalYear) }, (_, i) => {
    const d = String(i + 1).padStart(2, '0')
    return { value: d, label: String(i + 1) }
  })

  const selectClass = compact
    ? 'bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm flex-1'
    : 'bg-gray-900 border border-gray-700 rounded-2xl px-4 py-4 text-xl flex-1'

  return (
    <div>
      <label className={compact ? 'block mb-1 text-xs font-bold' : 'block mb-2 text-lg font-bold'}>{label}</label>
      <div className={`flex ${compact ? 'gap-2' : 'gap-3'}`}>
        <select
          value={internalMonth}
          onChange={(e) => update(internalYear, e.target.value, internalDay)}
          className={selectClass}
        >
          <option value="">Month</option>
          {months.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>

        <select
          value={internalDay}
          onChange={(e) => update(internalYear, internalMonth, e.target.value)}
          className={selectClass}
        >
          <option value="">Day</option>
          {days.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>

        <select
          value={internalYear}
          onChange={(e) => update(e.target.value, internalMonth, internalDay)}
          className={selectClass}
        >
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </select>
      </div>

      {(internalMonth || internalDay || internalYear) && (
        <button
          onClick={clear}
          className="mt-2 text-gray-500 hover:text-gray-300 text-sm"
        >
          Clear date
        </button>
      )}
    </div>
  )
}