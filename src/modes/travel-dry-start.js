'use strict'

// Player mode: a long trip starts on land. The long travel does not plan from
// water, so a trip that starts afloat fails segment after segment (live
// 2026-11-17 00:03-00:11 JST: in a pond 68 m north of the base, the trip to the
// base ended 29 times with CHUNK_TRAVEL_NO_ROUTE from the same feet, and the
// stuck-in-water exit never ran because the base trip was busy). The trip first
// swims onto the nearest ledge with the same water exit (player-water.js).
async function dryStart ({ needed, exit, log = () => {} }) {
  let wet = false
  try { wet = needed() === true } catch { return null }
  if (!wet) return null
  log('プレイヤーモード: 長距離移動の前に水から上がります')
  try { return await exit() } catch (error) { return { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
}

module.exports = { dryStart }
