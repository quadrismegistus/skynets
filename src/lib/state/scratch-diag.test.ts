import { it } from 'vitest'
import { Layout, type Target } from './layout'
const PILL = { hw: 106, hh: 28 }
const GAP = { x: 34, y: 32 }
const W = 1200
const H = 800
function node(id: string, tx: number, ty: number, group?: string): Target {
  return { id, tx, ty, r: 33, ...PILL, group }
}
it('diag-exact', () => {
  const l = new Layout(() => {})
  l.setCollision(GAP)
  l.setBounds(W, H, 18, 52, 170, 62)
  l.update(Array.from({ length: 25 }, (_, i) => node(`m${i}`, 400 + i * 30, 300 + i * 15)))
  const ids = Array.from({ length: 25 }, (_, i) => `m${i}`)
  const at = (id: string) => l.positions().get(id)!
  let bad = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = at(ids[i])
      const b = at(ids[j])
      const gapX = Math.abs(a.x - b.x) - 2 * PILL.hw
      const gapY = Math.abs(a.y - b.y) - 2 * PILL.hh
      if (!(gapX >= -1 || gapY >= -1)) {
        bad++
        console.log(`${ids[i]}(${a.x.toFixed(1)},${a.y.toFixed(1)}) x ${ids[j]}(${b.x.toFixed(1)},${b.y.toFixed(1)}) gapX=${gapX.toFixed(1)} gapY=${gapY.toFixed(1)}`)
      }
    }
  }
  console.log('bad pairs:', bad)
})
