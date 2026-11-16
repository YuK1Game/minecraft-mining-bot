'use strict'

// When the starter house is finished: its large chest A becomes the base
// (player-base.js banks diamonds there) and its bed sets the respawn point.
// The respawn point counts only when the server's set_spawn_position names a
// place within 3 blocks of the bed (shared.lastSpawnSet).
const { placements } = require('./house-blueprint')

// Chest A's first block in the blueprint (b_3_1_1): origin + (3, 1, 1).
const chestOf = origin => ({ x: origin.x + 3, y: origin.y + 1, z: origin.z + 1 })
const bedOf = origin => placements(origin).find(step => step.item === 'white_bed')?.position ?? null

async function setSpawn ({ origin, shared, useBed, wakeBed, walk, getFeet, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const foot = bedOf(origin)
  if (!foot) return false
  const feet = getFeet()
  if (!feet || Math.hypot(foot.x + 0.5 - feet.x, foot.z + 0.5 - feet.z) > 3) {
    // Inside the house, south of the bed's foot.
    try { await walk({ x: foot.x + 0.5, y: foot.y, z: foot.z + 1.5 }) } catch {}
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

module.exports = { chestOf, bedOf, setSpawn }
