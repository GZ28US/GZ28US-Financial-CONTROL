'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/Header'
import DatePicker from '@/components/DatePicker'
import { supabase } from '@/lib/supabase'

type Expense = {
  description: string
  amount: string
  expense_date: string
}

function isNumeric(v: string) { return v === '' || /^\d*\.?\d*$/.test(v) }
function isValidDate(d: string) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) }

function formatUSD(v: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function formatDate(d: string) {
  if (!isValidDate(d)) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function NewGoodPage() {
  const router = useRouter()

  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [purchaseDate, setPurchaseDate] = useState('')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [newExpense, setNewExpense] = useState<Expense>({ description: '', amount: '', expense_date: '' })
  const [editingExpenseIndex, setEditingExpenseIndex] = useState<number | null>(null)
  const [editingExpense, setEditingExpense] = useState<Expense>({ description: '', amount: '', expense_date: '' })

  const totalCost = (parseFloat(quantity) || 0) * (parseFloat(unitPrice) || 0)
  const expensesTotal = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
  const grandTotal = totalCost + expensesTotal

  function addExpense() {
    if (!newExpense.description || !newExpense.amount) { alert('Please enter description and amount'); return }
    setExpenses([...expenses, newExpense])
    setNewExpense({ description: '', amount: '', expense_date: '' })
  }

  function removeExpense(index: number) { setExpenses(expenses.filter((_, i) => i !== index)) }

  function startEditExpense(index: number) { setEditingExpenseIndex(index); setEditingExpense({ ...expenses[index] }) }

  function saveEditExpense() {
    if (!editingExpense.description || !editingExpense.amount) { alert('Please enter description and amount'); return }
    const updated = [...expenses]; updated[editingExpenseIndex!] = editingExpense; setExpenses(updated)
    setEditingExpenseIndex(null); setEditingExpense({ description: '', amount: '', expense_date: '' })
  }

  function cancelEditExpense() { setEditingExpenseIndex(null); setEditingExpense({ description: '', amount: '', expense_date: '' }) }

  async function saveGood() {
    if (!description) { alert('Please enter a description'); return }
    const { data: good, error } = await supabase.from('goods').insert([{
      description,
      quantity: parseFloat(quantity) || 1,
      unit_price: parseFloat(unitPrice) || 0,
      purchase_date: isValidDate(purchaseDate) ? purchaseDate : null,
    }]).select().single()
    if (error || !good) { alert(error?.message || 'Error saving good'); return }

    if (expenses.length > 0) {
      const { error: e } = await supabase.from('good_expenses').insert(expenses.map(ex => ({
        good_id: good.id,
        description: ex.description,
        amount: parseFloat(ex.amount) || 0,
        expense_date: isValidDate(ex.expense_date) ? ex.expense_date : null,
      })))
      if (e) { alert(e.message); return }
    }

    router.push('/goods')
  }

  const inputClass = 'w-full bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4 text-xl'
  const smallInputClass = 'bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 text-lg'

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <Header />
      <h1 className="text-4xl font-bold mb-8">ADD A NEW GOOD</h1>

      <div className="grid grid-cols-1 gap-5 max-w-2xl">

        <div>
          <label className="block mb-2 text-lg font-bold">DESCRIPTION</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} placeholder="e.g. Milwaukee Impact Wrench" />
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">QUANTITY</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => { if (isNumeric(e.target.value)) setQuantity(e.target.value) }} className={inputClass} placeholder="1" />
          </div>
          <div className="flex-1">
            <label className="block mb-2 text-lg font-bold">UNIT PRICE</label>
            <div className="relative">
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input type="text" inputMode="decimal" value={unitPrice} onChange={(e) => { if (isNumeric(e.target.value)) setUnitPrice(e.target.value) }} className={`${inputClass} pl-10`} placeholder="0.00" />
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4">
          <div className="flex justify-between items-center">
            <span className="text-gray-400 font-bold">TOTAL COST</span>
            <span className="text-xl font-bold">{formatUSD(totalCost)}</span>
          </div>
        </div>

        <DatePicker label="DATE OF PURCHASE" value={purchaseDate} onChange={setPurchaseDate} />

        {/* EXPENSES */}
        <div>
          <label className="block mb-3 text-lg font-bold">EXPENSES</label>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
            <div>
              <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
              <input type="text" placeholder="Expense description" value={newExpense.description} onChange={(e) => setNewExpense({ ...newExpense, description: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
              <div className="relative">
                <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input type="text" inputMode="decimal" placeholder="0.00" value={newExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setNewExpense({ ...newExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
              </div>
            </div>
            <DatePicker label="DATE" value={newExpense.expense_date} onChange={(v) => setNewExpense({ ...newExpense, expense_date: v })} />
            <button onClick={addExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">+ ADD EXPENSE</button>

            {expenses.length > 0 && (
              <div className="border border-gray-700 rounded-2xl overflow-hidden mt-2">
                {expenses.map((exp, index) => (
                  <div key={index}>
                    {editingExpenseIndex === index ? (
                      <div className="p-4 space-y-3 bg-gray-800 border-l-4 border-blue-600">
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">DESCRIPTION</label>
                          <input type="text" value={editingExpense.description} onChange={(e) => setEditingExpense({ ...editingExpense, description: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block mb-1 text-sm text-gray-400">AMOUNT</label>
                          <div className="relative">
                            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                            <input type="text" inputMode="decimal" value={editingExpense.amount} onChange={(e) => { if (isNumeric(e.target.value)) setEditingExpense({ ...editingExpense, amount: e.target.value }) }} className={`${inputClass} pl-10`} />
                          </div>
                        </div>
                        <DatePicker label="DATE" value={editingExpense.expense_date} onChange={(v) => setEditingExpense({ ...editingExpense, expense_date: v })} />
                        <div className="flex gap-3">
                          <button onClick={saveEditExpense} className="bg-green-700 hover:bg-green-600 px-5 py-3 rounded-2xl font-bold text-lg">SAVE</button>
                          <button onClick={cancelEditExpense} className="bg-gray-600 hover:bg-gray-500 px-5 py-3 rounded-2xl font-bold text-lg">CANCEL</button>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex items-center justify-between gap-4 px-4 py-3 ${index < expenses.length - 1 ? 'border-b border-gray-700' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-bold truncate">{exp.description}</p>
                          <p className="text-sm text-gray-400">{formatUSD(parseFloat(exp.amount))}{exp.expense_date ? ` — ${formatDate(exp.expense_date)}` : ''}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => startEditExpense(index)} className="bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded-xl font-bold text-sm">EDIT</button>
                          <button onClick={() => removeExpense(index)} className="bg-red-700 hover:bg-red-600 px-3 py-1 rounded-xl font-bold text-sm">REMOVE</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {expenses.length > 0 && (
              <div className="border-t border-gray-700 pt-3 flex justify-between items-center">
                <span className="text-gray-400 font-bold">EXPENSES TOTAL</span>
                <span className="text-xl font-bold">{formatUSD(expensesTotal)}</span>
              </div>
            )}
          </div>
        </div>

        {/* GRAND TOTAL */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl px-5 py-4">
          <div className="flex justify-between items-center">
            <span className="font-bold text-xl">GRAND TOTAL</span>
            <span className="text-3xl font-bold">{formatUSD(grandTotal)}</span>
          </div>
        </div>

        <button onClick={saveGood} className="bg-green-700 hover:bg-green-600 px-6 py-4 rounded-2xl text-xl font-bold">SAVE GOOD</button>
        <a href="/goods" className="text-gray-400 text-xl">Cancel</a>
      </div>
    </main>
  )
}