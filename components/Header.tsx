'use client'

export default function Header() {
  return (
    <div className="mb-10">
      <h1 className="text-5xl font-bold mb-8">
        GZ28US Financial CONTROL
      </h1>

      <div className="flex gap-4 flex-wrap">
        <a href="/" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          HOME
        </a>
        <a href="/clients" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          CLIENTS
        </a>
        <a href="/rides" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          RIDES
        </a>
        <a href="/staff" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          STAFF
        </a>
        <a href="/goods" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          GOODS
        </a>
        <a href="/inputs" className="bg-gray-900 hover:bg-gray-700 border border-gray-700 px-6 py-4 rounded-2xl text-xl font-bold">
          INPUTS
        </a>
      </div>
    </div>
  )
}