'use strict'

// Player mode: the starter house's bed takes three wool, from sheep. When the
// house still needs wool and a grown sheep is received within 24 m, the
// autonomy stops and the sheep are hunted by the long-trip preparation's wool
// step (operations.prepGather: walk beside, ordinary hits, pick the drops up,
// counted by the received inventory), then play goes on.
// - Not while a hostile is within 12 m, another job runs or the Bot travels.
// - Two minutes between tries; ten after one that gained no wool.
const { normalizeMode } = require('../bot-mode')
const { pending, needsNow } = require('./house-supply')

const NEAR_M = 24, AGAIN_MS = 120000, FAILED_MS = 600000, RUN_MS = 120000
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const wool = inventory => (inventory?.items ?? []).filter(item => /_wool$/.test(short(item?.name))).reduce((sum, item) => sum + (item.count ?? 0), 0)

function createHouseWool ({ getMode, shared, agent, gather, getState, getBlock, actors, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  function sheepNear (position) {
    return (actors() ?? []).some(actor => actor?.entityType === 'minecraft:sheep' && actor.alive !== false && actor.baby !== true && actor.isBaby !== true && actor.position && Math.hypot(actor.position.x - position.x, actor.position.z - position.z) <= NEAR_M)
  }

  async function tick () {
    if (!live() || busy || blocked() || now() < waitUntil) return null
    const state = getState()
    if (!state?.position || !pending({ mode: getMode(), playing: shared.playerWanted === true, shared, state })) return null
    const needs = needsNow({ shared, state, getBlock })
    if (!needs || needs.need.wool <= 0 || !sheepNear(state.position)) return null
    busy = true
    const before = wool(state.inventory)
    let gained = 0
    try {
      log(`プレイヤーモード: 拠点の家のベッドにする羊毛を集めます（あと${needs.need.wool}個）`)
      agent.stop('拠点の家の羊毛を集めます。')
      await settle()
      await gather({ logs: 0, wool: before + needs.need.wool, maxMs: RUN_MS })
      gained = wool(getState()?.inventory) - before
      log(`プレイヤーモード: 羊毛 ${gained > 0 ? `${gained} 個を得ました` : 'を得られませんでした'}（手元 ${before + Math.max(0, gained)} 個）`)
      return gained > 0
    } catch (error) {
      log(`プレイヤーモード: 羊毛を集められません ${String(error?.message ?? error).slice(0, 100)}`)
      return false
    } finally {
      waitUntil = now() + (gained > 0 ? AGAIN_MS : FAILED_MS)
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '拠点の家の羊毛を集めています。' : null }) }
}

module.exports = { createHouseWool }
