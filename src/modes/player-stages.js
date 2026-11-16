'use strict'

// The player mode's road to the Ender Dragon, as ordered stages. A stage counts
// as reached only from the inventory received from the server; an inventory that
// is unknown or uncertain reaches nothing. Stages without `implemented` are on
// the road but the Bot cannot work on them yet.
const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite']
const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const pickaxeTier = name => { const match = /^(\w+)_pickaxe$/.exec(bare(name)); return match ? TIERS.indexOf(match[1] === 'golden' ? 'wooden' : match[1]) : -1 }
const has = (items, test) => items.some(item => Number.isSafeInteger(item?.count) && item.count > 0 && test(bare(item.name)))
const FULL_SET = ['sword', 'helmet', 'chestplate', 'leggings', 'boots']
const pickaxeAtLeast = tier => items => items.some(item => item?.count > 0 && pickaxeTier(item.name) >= TIERS.indexOf(tier))

const STAGES = Object.freeze([
  { id: 'wood', label: '木の道具', implemented: true, reached: pickaxeAtLeast('wooden') },
  { id: 'stone', label: '石の道具', implemented: true, reached: pickaxeAtLeast('stone') },
  { id: 'iron', label: '鉄の道具', implemented: true, reached: pickaxeAtLeast('iron') },
  // The full diamond set, held or worn: pickaxe, sword and all four armour pieces
  // (user 2026-11-16 20:37 JST: 「ダイヤ装備できてないのに、目標が『ネザー』になってる」;
  // 21:39 JST: 「ダイヤ一式くらい揃えないとBotでネザーは厳しいでしょ」).
  { id: 'diamond', label: 'ダイヤ', implemented: true, reached: items => pickaxeAtLeast('diamond')(items) && FULL_SET.every(piece => has(items, name => name === `diamond_${piece}` || name === `netherite_${piece}`)) },
  { id: 'nether', label: 'ネザー', implemented: false, reached: items => has(items, name => name === 'blaze_rod' || name === 'blaze_powder' || name === 'ender_eye') },
  { id: 'end', label: 'エンド', implemented: false, reached: items => has(items, name => name === 'dragon_egg' || name === 'elytra') }
])

// { known, current, stages: [{ id, label, implemented, reached }] }.
// `current` is the first stage not yet reached, or null when all are reached
// or the inventory is not known.
// `worn` is the armour snapshot ({ known, worn: [{ name }] }); worn pieces count
// as held. Unreceived armour counts as nothing worn.
function playerStages (inventory, worn = null) {
  const known = inventory?.known === true && inventory.uncertain !== true && Array.isArray(inventory.items)
  const wearing = worn?.known === true && Array.isArray(worn.worn) ? worn.worn.filter(piece => piece?.name).map(piece => ({ name: piece.name, count: 1 })) : []
  const items = known ? [...inventory.items, ...wearing] : []
  const stages = STAGES.map(stage => ({ id: stage.id, label: stage.label, implemented: stage.implemented, reached: known && stage.reached(items) }))
  // A later stage reached implies the earlier ones (an iron pickaxe covers wood and stone).
  for (let i = stages.length - 2; i >= 0; i--) if (stages[i + 1].reached) stages[i].reached = true
  return { known, current: known ? stages.find(stage => !stage.reached)?.id ?? null : null, stages }
}

module.exports = { STAGES, playerStages }
