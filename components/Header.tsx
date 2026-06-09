'use client'

import { BASE_PATH } from '@/lib/utils'
import { supabase } from '@/lib/supabase'

const NAV: [string, string][] = [
  ['/', 'HOME'],
  ['/clients', 'CLIENTS'],
  ['/rides', 'RIDES'],
  ['/staff', 'STAFF'],
  ['/goods', 'GOODS'],
  ['/parts', 'PARTS'],
  ['/inputs', 'INPUTS'],
  ['/suppliers', 'SUPPLIERS'],
]

export default function Header() {
  return (
    <div className="mb-10">
      <h1 className="text-3xl font-bold mb-4">
        GZ28US Financial CONTROL
      </h1>

      <div className="flex gap-2 flex-wrap">
        {NAV.map(([href, label]) => (
          <a
            key={href}
            href={`${BASE_PATH}${href === '/' ? '' : href}`}
            className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-4 py-3 rounded-2xl text-base font-bold"
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
