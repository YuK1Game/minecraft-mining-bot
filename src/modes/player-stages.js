'use strict'

const { shortLabels, diamondEquipment, stageChecks } = require('./player-stage-checks')

// The player mode's road to the Ender Dragon, as ordered stages. A stage counts
// as reached from received equipment, the house record, or a scoped expedition receipt.
const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite']
const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const pickaxeTier = name => { const match = /^(\w+)_pickaxe$/.exec(bare(name)); return match ? TIERS.indexOf(match[1] === 'golden' ? 'wooden' : match[1]) : -1 }
const pickaxeAtLeast = tier => items => items.some(item => item?.count > 0 && pickaxeTier(item.name) >= TIERS.indexOf(tier))

const STAGES = Object.freeze([
  { id: 'wood', label: '木の道具', implemented: true, reached: pickaxeAtLeast('wooden') },
  // The house of the user's blueprint, built right after the wooden tools
  // (house/; user 2026-11-17 03:06-03:07 JST). Reached only from the house record
  // (shared.playerHouse.done, set when every received block matches), never
  // implied by a later stage (user 23:16 JST: 「02目標に『拠点の作成』も追加しといて」).
  { id: 'base', label: '拠点の作成', implemented: true, record: true, reached: (items, house) => house?.done === true },
  { id: 'stone', label: '石の道具', implemented: true, reached: pickaxeAtLeast('stone') },
  { id: 'iron', label: '鉄の道具', implemented: true, reached: pickaxeAtLeast('iron') },
  { id: 'home_reserve', label: '本拠点に予備の鉄装備と食料を備蓄', expedition: true, reached: record => record.early?.reserveReady === true },
  // The full diamond set, held or worn: pickaxe, sword and all four armour pieces
  // (user 2026-11-16 20:37 JST: 「ダイヤ装備できてないのに、目標が『ネザー』になってる」;
  // 21:39 JST: 「ダイヤ一式くらい揃えないとBotでネザーは厳しいでしょ」).
  { id: 'diamond', label: 'ダイヤ', implemented: true, reached: items => diamondEquipment(items).every(piece => piece.done) },
  { id: 'nether', label: 'ネザー遠征の準備・ゲート往復', expedition: true, reached: record => record.nether?.roundTrip === true || record.nether?.finished === true },
  { id: 'rods', label: 'ネザー要塞・耐火・ロッド', expedition: true, reached: record => record.nether?.finished === true },
  { id: 'stronghold', label: '地下要塞と再出撃拠点', expedition: true, reached: record => record.stronghold?.prepared === true },
  { id: 'end', label: 'エンド・クリスタルとドラゴン', expedition: true, reached: record => Boolean(record.end?.victory || record.end?.preexisting) },
  { id: 'return', label: '現世へ帰還', expedition: true, reached: record => record.stage === 'complete' }
])

// { known, current, stages: [{ id, label, implemented, reached }] }.
// `current` is the first stage not yet reached, or null when all are reached
// or the inventory is not known.
// `worn` is the armour snapshot ({ known, worn: [{ name }] }); worn pieces count
// as held. Unreceived armour counts as nothing worn.
// `house` is the house record (shared.playerHouse: { origin, done }).
function playerStages (inventory, worn = null, house = null, record = null) {
  const known = inventory?.known === true && inventory.uncertain !== true && Array.isArray(inventory.items)
  const wearing = worn?.known === true && Array.isArray(worn.worn) ? worn.worn.filter(piece => piece?.name).map(piece => ({ name: piece.name, count: 1 })) : []
  const items = known ? [...inventory.items, ...wearing] : []
  const stages = STAGES.map(stage => {
    const reached = stage.expedition
      ? Boolean(record && stage.reached(record))
      : Boolean(record?.early?.finished || (known && stage.reached(items, house)))
    // The received reserve kit included an iron pickaxe even if it is now in the chest.
    const ironInReserve = stage.id === 'iron' && record?.early?.reserveReady === true
    const label = stage.id === 'end' && record?.end?.preexisting ? '開通済みエンドの確認' : stage.label
    return { id: stage.id, label, implemented: true, reached: reached || ironInReserve }
  })
  // Tool tiers imply earlier tools, but gear in a chest, a borrowed blaze rod
  // or an elytra never proves a visit to another dimension or a dragon kill.
  const gear = stages.filter((stage, index) => !STAGES[index].record && !STAGES[index].expedition)
  for (let i = gear.length - 2; i >= 0; i--) if (gear[i + 1].reached) gear[i].reached = true
  const current = known || record?.early?.finished ? stages.find(stage => !stage.reached)?.id ?? null : null
  return {
    known, current,
    stages: stages.map(stage => ({
      ...stage,
      shortLabel: shortLabels[stage.id],
      checks: stageChecks(stage, items, house, record)
    }))
  }
}

module.exports = { STAGES, playerStages }
