'use client'

import { useState } from 'react'
import { BASE_PATH } from '@/lib/utils'
import { supabase } from '@/lib/supabase'

// Unified, ordered menu: each entry is a flat link or a dropdown.
type MenuItem =
  | { type: 'link'; href: string; label: string }
  | { type: 'dropdown'; label: string; items: [string, string][] }

const MENU: MenuItem[] = [
  { type: 'link', href: '/', label: 'HOME' },
  {
    type: 'dropdown',
    label: 'PROJECTS',
    items: [
      ['/clients?mode=project', 'CLIENTS'],
      ['/rides?mode=project', 'RIDES'],
      ['/invoices', 'INVOICES'],
    ],
  },
  {
    type: 'dropdown',
    label: 'QUOTES',
    items: [
      ['/clients?mode=quote', 'CLIENTS'],
      ['/rides?mode=quote', 'RIDES'],
      ['/quotes', 'QUOTES'],
    ],
  },
  { type: 'link', href: '/staff', label: 'STAFF' },
  {
    type: 'dropdown',
    label: 'PARTS',
    items: [
      ['/inventory', 'INVENTORY'],
      ['/parts', 'PARTS DB'],
      ['/packs', 'PACKS DB'],
      ['/suppliers', 'SUPPLIERS'],
    ],
  },
  {
    type: 'dropdown',
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
        {MENU.map((item) => item.type === 'link' ? (
          <a
            key={item.label}
            href={`${BASE_PATH}${item.href === '/' ? '' : item.href}`}
            className={linkClass}
          >
            {item.label}
          </a>
        ) : (
          <div
            key={item.label}
            className="relative"
            onMouseLeave={() => setOpenMenu((prev) => (prev === item.label ? null : prev))}
          >
            <button
              onClick={() => setOpenMenu((prev) => (prev === item.label ? null : item.label))}
              className={`${linkClass} flex items-center gap-1`}
            >
              {item.label} <span className="text-xs">▾</span>
            </button>
            {openMenu === item.label && (
              <div className="absolute left-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-2xl p-2 z-50 flex flex-col gap-1 min-w-48 shadow-xl">
                {item.items.map(([href, l]) => (
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
