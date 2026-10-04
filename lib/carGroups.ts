// CAR GROUPS — grupos de compatibilidade de build (Márcio, 04/10/2026): carros que recebem o MESMO build.
// «once the user already picked the manufacturer, I want the app to offer the groups (if there is any) before the brand».
// Moram na tabela `car_groups` do banco do US, ao lado de `packs` (MIGRATION_car_groups.sql). Clicar num grupo no
// cadastro do pack ADICIONA os carros dele em «CARS THIS PACKAGE FITS» — o pack guarda os carros, não o grupo (decisão
// dele): mudar o grupo depois não mexe em pack já salvo. Quem cria e edita os grupos é a tela /packs/groups.
/* eslint-disable @typescript-eslint/no-explicit-any */

// O mesmo formato de packs.cars.
export type GroupCar = { manufacturer: string; brand: string; model: string; version: string; years: number[] }
export type CarGroup = { id: string; name: string; manufacturer: string; cars: GroupCar[]; position: number }

type Db = { from: (table: string) => any }

const carOf = (c: any): GroupCar => ({
  manufacturer: String(c?.manufacturer || ''), brand: String(c?.brand || ''), model: String(c?.model || ''), version: String(c?.version || ''),
  years: Array.isArray(c?.years) ? c.years.map(Number).filter((y: number) => Number.isFinite(y)).sort((a: number, b: number) => a - b) : [],
})

export async function loadCarGroups(db: Db): Promise<CarGroup[]> {
  const { data } = await db.from('car_groups').select('id, name, manufacturer, cars, position').order('position').order('name')
  return (data || []).map((g: any) => ({
    id: String(g.id), name: String(g.name || ''), manufacturer: String(g.manufacturer || ''), position: Number(g.position) || 0,
    cars: (Array.isArray(g.cars) ? g.cars : []).map(carOf),
  }))
}

const mesmoCarro = (a: GroupCar, b: GroupCar) => a.manufacturer === b.manufacturer && a.brand === b.brand && a.model === b.model && a.version === b.version

// Os carros do grupo entram na lista do pack: carro que já está lá só ganha os anos que faltam (nunca duplica a linha).
export function addGroupCars(cars: GroupCar[], group: CarGroup): GroupCar[] {
  const out = cars.map(c => ({ ...c, years: [...c.years] }))
  for (const g of group.cars) {
    const cur = out.find(c => mesmoCarro(c, g))
    if (cur) cur.years = [...new Set([...cur.years, ...g.years])].sort((a, b) => a - b)
    else out.push({ ...g, years: [...g.years] })
  }
  return out
}

// «If it's a group, show the Group name, not the cars» (Márcio, 04/10/2026): os rótulos dos carros de um pack. Quando o
// pack carrega TODOS os carros de um grupo, com os mesmos anos, o nome do grupo entra no lugar deles; carro que sobrar
// (fora de grupo, ou com ano diferente do grupo) sai com o rótulo normal.
export function packCarLabels(cars: any[], groups: CarGroup[], carLabel: (c: any) => string): string[] {
  const list = (Array.isArray(cars) ? cars : []).map((c, i) => ({ i, c: carOf(c), raw: c }))
  const nrm = (s: string) => s.trim().toLowerCase()
  const igual = (a: GroupCar, b: GroupCar) => nrm(a.manufacturer) === nrm(b.manufacturer) && nrm(a.brand) === nrm(b.brand) && nrm(a.model) === nrm(b.model) && nrm(a.version) === nrm(b.version) && a.years.join(',') === b.years.join(',')
  const usados = new Set<number>()
  const out: { at: number; text: string }[] = []
  for (const g of groups) {
    if (!g.cars.length) continue
    const achados = g.cars.map(gc => list.find(x => !usados.has(x.i) && igual(x.c, gc)))
    if (achados.some(x => !x)) continue
    for (const x of achados) usados.add(x!.i)
    out.push({ at: Math.min(...achados.map(x => x!.i)), text: g.name })
  }
  for (const x of list) if (!usados.has(x.i)) { const t = carLabel(x.raw); if (t) out.push({ at: x.i, text: t }) }
  return out.sort((a, b) => a.at - b.at).map(o => o.text)
}
