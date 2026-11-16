'use strict'

// Player mode: wood goes down with the Bot. Underground every new pickaxe
// needs a crafting table and sticks, and both are made from logs; the plans
// make a new table on the spot when logs or planks are held
// (diamond-planner.js FAR_STATION). Without wood the only way to a new
// pickaxe is the surface (real Realm 2026-11-16 18:54-19:30 JST: at y -16
// with 300 cobblestone, two sticks and two planks, both iron pickaxes wore
// out on the climb; it stood under a lake bed with four pickaxes at two uses
// and lost eleven diamonds in the cave below).
// - Near the surface (feet at y 50 or higher), when the plan's next work lies
//   six or more blocks below the feet and fewer than four logs' worth of wood
//   is held (a log, four planks or a crafting table count as one), the base
//   plan's wood work comes first: pick up a dropped log, walk to a tree, cut it.
// - Only wood work replaces the plan. With no tree in the received terrain the
//   plan goes on as it was.
const { normalizeMode } = require('./bot-mode')
const { isLogWork } = require('./player-wood')

const SURFACE_Y = 50, DEPTH = 6, WANTED = 4
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const isLog = name => /_(?:log|stem)$/.test(short(name)) && !/^stripped_/.test(short(name))

// Logs' worth of wood in the received inventory, or null when it is not known.
function woodHeld (inventory) {
  if (inventory?.known !== true || !Array.isArray(inventory.items)) return null
  let logs = 0, planks = 0, tables = 0
  for (const item of inventory.items) {
    const count = Number.isFinite(item?.count) ? item.count : 0
    if (count < 1) continue
    if (isLog(item.name)) logs += count
    else if (/_planks$/.test(short(item.name))) planks += count
    else if (short(item.name) === 'crafting_table') tables += count
  }
  return logs + Math.floor(planks / 4) + tables
}

const depthOf = (decision, feetY) => {
  const target = decision?.resourceTarget ?? decision?.target
  return Number.isFinite(target?.y) ? feetY - target.y : 0
}

function withPlayerSupply ({ mode, playing, state, decision, planLogs, log = () => {} }) {
  if (normalizeMode(mode) !== 'player' || playing !== true || !decision || isLogWork(decision)) return decision
  const feetY = Number.isFinite(state?.position?.y) ? state.position.y - 1.62 : null
  if (feetY === null || feetY < SURFACE_Y || depthOf(decision, feetY) < DEPTH) return decision
  const held = woodHeld(state.inventory)
  if (held === null || held >= WANTED) return decision
  let logs = null
  try { logs = planLogs() } catch (error) { log(`プレイヤーモード: 木の計画に失敗 ${String(error?.message ?? error).slice(0, 120)}`) }
  if (!isLogWork(logs) || ['stop', 'complete', 'wait', 'explore', 'scan_blocks'].includes(logs.type)) return decision
  return { ...logs, reason: `地下へ下りる前に原木を集めます（${logs.reason ?? ''}）` }
}

module.exports = { withPlayerSupply, woodHeld, SURFACE_Y, WANTED }
