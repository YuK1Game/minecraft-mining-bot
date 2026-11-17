'use strict'

// Player mode: a long trip starts on land. The long travel does not plan from
// water, so a trip that starts afloat fails segment after segment (live
// 2026-11-17 00:03-00:11 JST: in a pond 68 m north of the base, the trip to the
// base ended 29 times with CHUNK_TRAVEL_NO_ROUTE from the same feet, and the
// stuck-in-water exit never ran because the base trip was busy). The trip first
// swims onto the nearest ledge with the same water exit (player-water.js).
// The exit waits until the stopped autonomy has ended and tries again while
// the start is refused only for that (live 00:15 JST: the exit began 3 ms after
// the stop and was refused with 「前の操作の終了処理を待ってください。」).
const WAIT = /待って|待機|使用中|確認しています/

async function dryStart ({ needed, exit, ready = () => true, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), tries = 4 }) {
  let wet = false
  try { wet = needed() === true } catch { return null }
  if (!wet) return null
  log('プレイヤーモード: 長距離移動の前に水から上がります')
  for (let i = 0; i < 50 && !ready(); i++) await sleep(200)
  let out = null
  for (let attempt = 0; attempt < tries; attempt++) {
    try { out = await exit() } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
    if (out?.ok || !WAIT.test(String(out?.reason ?? ''))) return out
    await sleep(1000)
  }
  return out
}

module.exports = { dryStart }
