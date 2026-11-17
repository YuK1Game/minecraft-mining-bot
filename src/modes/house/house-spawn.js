'use strict'

// When the starter house is finished: its large chest A becomes the base
// (player-base.js banks diamonds there) and its bed sets the respawn point.
// The respawn point counts only when the server's set_spawn_position names a
// place within 3 blocks of the bed (shared.lastSpawnSet).
const { placements } = require('./house-blueprint')
const { standable } = require('./house-steps')

// Chest A's first block in the blueprint (b_3_1_1): origin + (3, 1, 1).
const chestOf = origin => ({ x: origin.x + 3, y: origin.y + 1, z: origin.z + 1 })
const bedOf = origin => placements(origin).find(step => step.item === 'white_bed')?.position ?? null

// Stands from which the bed may be used: received ground within 3 blocks of
// the bed, nearest first. Inside the house the cells beside the bed may hold
// the table (live 2026-11-17 13:39-14:35 JST: the walk went to the cell south
// of the foot, a crafting table, and every use from outside the wall failed
// 「The real bed shape has no known visible face within normal reach」).
function bedStands (getBlock, foot) {
  const out = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1, -1]) {
    const x = foot.x + dx, y = foot.y + dy, z = foot.z + dz
    if (Math.hypot(dx, dz) <= 3 && standable(getBlock, x, y, z)) out.push({ x: x + 0.5, y, z: z + 0.5 })
  }
  return out.sort((a, b) => Math.hypot(a.x - foot.x - 0.5, a.z - foot.z - 0.5) + Math.abs(a.y - foot.y) - Math.hypot(b.x - foot.x - 0.5, b.z - foot.z - 0.5) - Math.abs(b.y - foot.y))
}

async function setSpawn ({ origin, shared, useBed, wakeBed, walk, getFeet, getBlock = null, previewUse = null, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const foot = bedOf(origin)
  if (!foot) return false
  const ready = () => previewUse?.(foot)?.ready === true
  if (getBlock && previewUse) {
    // From here when the bed can be used; else from the stands around it.
    if (!ready()) for (const stand of bedStands(getBlock, foot).slice(0, 6)) { try { if (await walk(stand) !== false && ready()) break } catch {} }
  } else {
    const feet = getFeet()
    if (!feet || Math.hypot(foot.x + 0.5 - feet.x, foot.z + 0.5 - feet.z) > 3) {
      // Inside the house, south of the bed's foot.
      try { await walk({ x: foot.x + 0.5, y: foot.y, z: foot.z + 1.5 }) } catch {}
    }
  }
  const t0 = now()
  try { await useBed(foot) } catch (error) { log(`プレイヤーモード: 拠点の家のベッドを使えません ${String(error?.message ?? error).slice(0, 80)}`) }
  const until = now() + 6000
  while (now() < until && !(shared.lastSpawnSet?.at > t0)) await sleep(200)
  try { await wakeBed(foot) } catch {}
  const set = shared.lastSpawnSet
  const ok = set?.at > t0 && !!set.position && Math.hypot(set.position.x - foot.x, set.position.z - foot.z) <= 3
  log(ok ? `プレイヤーモード: リスポーン地点を拠点の家のベッド (${foot.x}, ${foot.y}, ${foot.z}) にしました（サーバーの通知で確認）` : 'プレイヤーモード: 拠点の家のベッドに触れましたが、リスポーン地点の設定を確認できません')
  return ok
}

module.exports = { chestOf, bedOf, setSpawn, bedStands }
