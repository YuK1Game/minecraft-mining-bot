'use strict'

// The expedition's night: home, and into the bed of the house.
//
// While the expedition owns the work, the ordinary crew's night shelter
// (player-shelter.js) is not run: the food step went on hunting in the open
// after dusk (real Realm 2026-11-18 22:03-22:07 JST: beside the house a
// phantom, a skeleton and two creepers took health from 19.1 to 3.6 in nine
// hits; the creeper evasion found no retreat 62 times and the idle escape was
// cancelled 53 times). The house has a bed: it is the night's place while the house is whole or its repair is held
// (house/house-repair.js); a bed received as gone is asked for like any other thing of the house (dragon-home-use.js).
//
// From dusk by the received world clock (travel/night-stop.js), in the
// overworld part before the Nether: walk home, use the bed, and wait for the
// morning. The night counts as slept only by the received clock; when the bed
// cannot be used (monsters near, not yet dark enough) the Bot stays in the
// house and tries again after TRY_MS. An unknown clock is not a night.
const { dayPhase } = require('../travel/night-stop')
const { bedOf, bedStands } = require('./house/house-spawn')
const { approachHome } = require('./dragon-early-home')
const { houseDuty } = require('./house/house-repair')
const { homeUse } = require('./dragon-home-use')

const TRY_MS = 30000, SLEEP_MS = 12000, POLL_MS = 500
const waiting = reason => ({ phase: 'waiting', reason })
// In the house until morning: a wait on purpose, with a name and the ledger's limit (goal/goal-ledger.js WAITS.DAWN).
const dawn = reason => ({ phase: 'waiting', reason, wait: { code: 'DAWN' } })

async function nightHome (ctx, { clock, approach = approachHome, now = ctx.now ?? Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const house = ctx.shared.playerHouse
  const night = () => { const phase = dayPhase(clock()); return phase.known && phase.shelter }
  if (!night() || !house?.origin || houseDuty(house)) return null
  const bed = bedOf(house.origin)
  if (!bed) return null
  if (!await approach(ctx, bed)) return waiting('夜のため、本拠点へ戻ります。')
  const block = ctx.getBlock(bed.x, bed.y, bed.z)
  const state = ctx.shared.dragonNight ??= {}
  // Received as something else: the bed's repair is asked for; this night is waited out in the house.
  if (block?.known === true && !/bed$/.test(block.name)) homeUse(ctx, 'bed')
  if (block?.known !== true || !/bed$/.test(block.name) || now() - (state.triedAt ?? -Infinity) < TRY_MS) return dawn('夜のため、本拠点の中で朝を待ちます。')
  state.triedAt = now()
  const use = ctx.operations.interactions
  if (use.previewUseBed(bed)?.ready !== true) {
    for (const stand of bedStands(ctx.getBlock, bed).slice(0, 6)) {
      if (ctx.cancelled()) return waiting('夜のため、本拠点の中で朝を待ちます。')
      try { if (await ctx.hands.walk(stand) !== false && use.previewUseBed(bed)?.ready === true) break } catch { /* The next stand. */ }
    }
  }
  if (ctx.cancelled()) return waiting('夜のため、本拠点の中で朝を待ちます。')
  try { await use.useBed(bed) } catch (error) {
    ctx.log?.(`プレイヤーモード: 本拠点のベッドを使えません（${String(error?.message ?? error).slice(0, 80)}）。家の中で朝を待ちます`)
    return dawn('夜のため、本拠点の中で朝を待ちます。')
  }
  ctx.goal?.wait?.('DAWN')
  const until = now() + SLEEP_MS
  while (now() < until && night() && !ctx.cancelled()) await sleep(POLL_MS)
  const slept = !night()
  // Still night (others awake, monsters near): out of the bed, so that combat can act; the house is the shelter.
  if (!slept) { try { await use.wakeBed(bed) } catch { /* Not in the bed. */ } }
  ctx.log?.(slept ? 'プレイヤーモード: 本拠点のベッドで眠り、朝になりました（受信した時計で確認）' : 'プレイヤーモード: 本拠点のベッドを使いましたが、朝になりません。家の中で朝を待ちます')
  return slept ? waiting('朝になりました。作業に戻ります。') : dawn('夜のため、本拠点の中で朝を待ちます。')
}

module.exports = { nightHome, TRY_MS }
