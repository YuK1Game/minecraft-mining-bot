'use strict'

// Player mode: the starter house comes right after the wooden tools (user
// 2026-11-17 03:06 JST: 「序盤にこの設計で拠点を作るようにしてほしい、最優先で」;
// 03:07 JST: 「木の道具を次くらいじゃないと立てられないよね？」 - its floor and
// furnaces take 68 cobblestone, so a pickaxe comes first).
// - While a pickaxe is held and the house is not finished (shared.playerHouse.done),
//   the plan's next work is replaced by gathering what the house still needs
//   (house-needs.js): logs from whole natural trees first, then cobblestone.
// - Logs: the base wood plan, asked as if no wood were held, so it goes on
//   cutting until the house's logs are in hand instead of crafting the first one.
// - Cobblestone: the base plan's stone work with the count the house needs.
// - A plan that stops, completes or only waits keeps the original decision.
// - Then sand for the glass (the base plan's stone work on received sand).
// - Wool comes from sheep (house-wool.js); coal, the crafting and the build
//   itself come next (docs/player-roadmap.md).
const { normalizeMode } = require('../bot-mode')
const { counts, remaining } = require('./house-blueprint')
const { houseNeeds } = require('./house-needs')

const short = name => String(name ?? '').replace(/^minecraft:/, '')
const hasPickaxe = inventory => (inventory?.items ?? []).some(item => item?.count > 0 && /_pickaxe$/.test(short(item.name)))
const WOOD = /(?:_(?:log|stem|planks)|^crafting_table|^stick)$/

// The plan input for house logs: no pickaxe, no wood held (so the plan asks for
// more logs instead of crafting), and the logs the house still needs.
function houseLogInput (state, options, logs) {
  const items = (state?.inventory?.items ?? []).filter(item => !/_pickaxe$/.test(short(item?.name)) && !WOOD.test(short(item?.name)))
  return { state: { ...state, inventory: { ...state.inventory, items } }, options: { ...options, allowLogs: true, logCount: logs, stoneCount: 2304 } }
}

// The plan input for house cobblestone: the stone the house needs on top of what is held.
function houseStoneInput (state, options, cobblestone) {
  const stone = (state?.inventory?.items ?? []).filter(item => ['cobblestone', 'cobbled_deepslate'].includes(short(item?.name))).reduce((sum, item) => sum + (item.count ?? 0), 0)
  return { state, options: { ...options, stoneCount: stone + cobblestone } }
}

// The plan input for house sand (sand or red sand both make glass).
const SAND = ['sand', 'red_sand']
function houseSandInput (state, options, sand) {
  const held = (state?.inventory?.items ?? []).filter(item => SAND.includes(short(item?.name))).reduce((sum, item) => sum + (item.count ?? 0), 0)
  return { state, options: { ...options, stoneCount: 2304, material: { blocks: SAND, items: SAND, count: held + sand } } }
}

function pending ({ mode, playing, shared, state }) {
  return normalizeMode(mode) === 'player' && playing === true && shared?.playerHouse?.done !== true && hasPickaxe(state?.inventory)
}

function needsNow ({ shared, state, getBlock }) {
  const origin = shared?.playerHouse?.origin ?? null
  return houseNeeds(state?.inventory, counts(origin && getBlock ? remaining(getBlock, origin) : remaining(null, null)))
}

function withHouseSupply ({ mode, playing, shared, state, decision, getBlock = null, planLogs, planStone, planSand = null, log = () => {} }) {
  if (!decision || !pending({ mode, playing, shared, state })) return decision
  const needs = needsNow({ shared, state, getBlock })
  if (!needs?.short) return decision
  const tell = (key, text) => { if (shared.houseSupplyNote !== key) { shared.houseSupplyNote = key; log(`プレイヤーモード: ${text}`) } }
  const { need, total } = needs
  const ask = (plan, label) => {
    let next = null
    try { next = plan() } catch (error) { log(`プレイヤーモード: 拠点の材料の計画に失敗 ${String(error?.message ?? error).slice(0, 120)}`) }
    if (!next || ['stop', 'complete', 'wait'].includes(next.type)) return null
    return { ...next, houseMaterial: label, reason: `拠点の材料を集めます（${label}）: ${next.reason ?? ''}` }
  }
  if (need.logs > 0) {
    tell(`logs:${total.logs}`, `拠点の家の材料を集めます（原木 あと${need.logs}本・丸石 あと${need.cobblestone}個・砂 ${need.sand}・羊毛 ${need.wool}・石炭 ${need.coal}）`)
    return ask(() => planLogs(need.logs), `原木 あと${need.logs}本`) ?? decision
  }
  if (need.cobblestone > 0) {
    tell(`stone:${total.cobblestone}`, `拠点の家の丸石を集めます（あと${need.cobblestone}個）`)
    return ask(() => planStone(need.cobblestone), `丸石 あと${need.cobblestone}個`) ?? decision
  }
  // Sand for the glass, from received sand with nothing falling on it. With
  // none received the plan goes on (the wool, coal and build steps do not wait).
  if (need.sand > 0 && planSand) {
    const sand = ask(() => planSand(need.sand), `砂 あと${need.sand}個`)
    if (sand && sand.type !== 'scan_blocks') { tell(`sand:${total.sand}`, `拠点の家のガラスにする砂を集めます（あと${need.sand}個）`); return sand }
    tell(`nosand:${total.sand}`, `拠点の家のガラスにする砂が近くに見つかりません（あと${need.sand}個）`)
  }
  return decision
}

module.exports = { withHouseSupply, houseLogInput, houseStoneInput, houseSandInput, pending, needsNow }
