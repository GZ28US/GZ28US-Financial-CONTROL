'use client'

import { useState } from 'react'
import { BASE_PATH } from '@/lib/utils'
import { supabase } from '@/lib/supabase'

// Flat top-level items shown before the dropdowns.
const NAV: [string, string][] = [
  ['/', 'HOME'],
  ['/clients', 'CLIENTS'],
  ['/rides', 'RIDES'],
  ['/staff', 'STAFF'],
]

// Dropdown menus, in order, shown after the flat items.
const DROPDOWNS: { label: string; items: [string, string][] }[] = [
  {
    label: 'PARTS',
    items: [
      ['/inventory', 'INVENTORY'],
      ['/parts', 'PARTS DB'],
      ['/packs', 'PACKS DB'],
      ['/suppliers', 'SUPPLIERS'],
    ],
  },
  {
    label: 'COSTS',
    items: [
      ['/costs/fixed', 'FIXED'],
      ['/costs/variable', 'VARIABLE'],
      ['/goods', 'GOODS'],
      ['/inputs', 'INPUTS'],
    ],
  },
]

export default function Header() {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const linkClass = 'bg-gray-900 hover:bg-gray-700 border border-gray-700 px-4 py-3 rounded-2xl text-base font-bold'

  return (
    <div className="mb-10">
      <h1 className="text-3xl font-bold mb-4">
        GZ28US Control App
      </h1>

      <div className="flex gap-2 flex-wrap items-start">
        {NAV.map(([href, label]) => (
          <a
            key={href}
            href={`${BASE_PATH}${href === '/' ? '' : href}`}
            className={linkClass}
          >
            {label}
          </a>
        ))}

        {DROPDOWNS.map(({ label, items }) => (
          <div
            key={label}
            className="relative"
            onMouseLeave={() => setOpenMenu((prev) => (prev === label ? null : prev))}
          >
            <button
              onClick={() => setOpenMenu((prev) => (prev === label ? null : label))}
              className={`${linkClass} flex items-center gap-1`}
            >
              {label} <span className="text-xs">▾</span>
            </button>
            {openMenu === label && (
              <div className="absolute left-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-2xl p-2 z-50 flex flex-col gap-1 min-w-48 shadow-xl">
                {items.map(([href, l]) => (
                  <a
                    key={href}
                    href={`${BASE_PATH}${href}`}
                    className="hover:bg-gray-700 px-4 py-3 rounded-xl text-base font-bold whitespace-nowrap"
                  >
                    {l}
                  </a>
                ))}
              </div>
            )}
          </div>
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
