'use client'

import { useState } from 'react'
import { BASE_PATH } from '@/lib/utils'
import { supabase } from '@/lib/supabase'

// Top-level items shown before the PARTS dropdown.
const NAV_BEFORE: [string, string][] = [
  ['/', 'HOME'],
  ['/clients', 'CLIENTS'],
  ['/rides', 'RIDES'],
  ['/staff', 'STAFF'],
  ['/goods', 'GOODS'],
]
// PARTS dropdown children.
const PARTS_SUBMENU: [string, string][] = [
  ['/inventory', 'INVENTORY'],
  ['/parts', 'PARTS DB'],
  ['/packs', 'PACKS DB'],
  ['/suppliers', 'SUPPLIERS'],
]
// Top-level items shown after the PARTS dropdown.
const NAV_AFTER: [string, string][] = [
  ['/inputs', 'INPUTS'],
]

export default function Header() {
  const [partsOpen, setPartsOpen] = useState(false)
  const linkClass = 'bg-gray-900 hover:bg-gray-700 border border-gray-700 px-4 py-3 rounded-2xl text-base font-bold'

  return (
    <div className="mb-10">
      <h1 className="text-3xl font-bold mb-4">
        GZ28US Financial CONTROL
      </h1>

      <div className="flex gap-2 flex-wrap items-start">
        {NAV_BEFORE.map(([href, label]) => (
          <a
            key={href}
            href={`${BASE_PATH}${href === '/' ? '' : href}`}
            className={linkClass}
          >
            {label}
          </a>
        ))}

        {/* PARTS dropdown */}
        <div className="relative" onMouseLeave={() => setPartsOpen(false)}>
          <button
            onClick={() => setPartsOpen((o) => !o)}
            className={`${linkClass} flex items-center gap-1`}
          >
            PARTS <span className="text-xs">▾</span>
          </button>
          {partsOpen && (
            <div className="absolute left-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-2xl p-2 z-50 flex flex-col gap-1 min-w-48 shadow-xl">
              {PARTS_SUBMENU.map(([href, label]) => (
                <a
                  key={href}
                  href={`${BASE_PATH}${href}`}
                  className="hover:bg-gray-700 px-4 py-3 rounded-xl text-base font-bold whitespace-nowrap"
                >
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>

        {NAV_AFTER.map(([href, label]) => (
          <a
            key={href}
            href={`${BASE_PATH}${href}`}
            className={linkClass}
          >
            {label}
          </a>
        ))}

        <button
          onClick={() => supabase.auth.signOut()}
          className="bg-gray-900 hover:bg-red-800 border border-gray-700 px-4 py-3 rounded-2xl text-base font-bold"
        >
          SIGN OUT
        </button>
      </div>
    </div>
  )
}
