'use strict'

const { key, mineSteps } = require('./mining/mine-geometry')
const { bare, count, home } = require('./dragon-supply-kit')
const { reserveCounts } = require('./dragon-reserve-seen')
const { ingredient } = require('./dragon-supply-recipes')

const shortLabels = {
  wood: '木', base: '拠点', stone: '石', iron: '鉄', home_reserve: '備蓄', branch_mine: 'ブランチ採掘場',
  diamond: 'ダイヤ', nether: 'ゲート', rods: 'ネザー要塞', stronghold: '地下要塞', end: 'ドラゴン', return: '帰還'
}

const diamondPieces = [
  ['pickaxe', 'ツルハシ', ingredient.diamond_pickaxe.diamond],
  ['sword', '剣', ingredient.diamond_sword.diamond],
  ['helmet', 'ヘルメット', ingredient.diamond_helmet.diamond],
  ['chestplate', 'チェストプレート', ingredient.diamond_chestplate.diamond],
  ['leggings', 'レギンス', ingredient.diamond_leggings.diamond],
  ['boots', 'ブーツ', ingredient.diamond_boots.diamond]
]

const HOME_ITEMS = [
  ['iron_pickaxe', '鉄のツルハシ', '本'],
  ['iron_sword', '鉄の剣', '本'],
  ['iron_helmet', '鉄のヘルメット', '個'],
  ['iron_chestplate', '鉄のチェストプレート', '個'],
  ['iron_leggings', '鉄のレギンス', '個'],
  ['iron_boots', '鉄のブーツ', '個'],
  ['shield', '盾', '個'],
  ['bucket', 'バケツ', '個'],
  ['food', '調理済み食料', '個']
]

const HOUSE_ITEM_LABELS = {
  oak_planks: 'オークの板材',
  oak_log: 'オークの原木',
  oak_slab: 'オークのハーフブロック',
  oak_door: 'オークのドア',
  cobblestone: '丸石',
  glass: 'ガラス',
  white_bed: 'ベッド',
  chest: 'チェスト',
  crafting_table: '作業台',
  furnace: 'かまど',
  torch: '松明'
}

function normalizeItems (items) {
  if (!Array.isArray(items)) return []
  return items
    .filter(item => item?.name && Number.isSafeInteger(item.count) && item.count > 0)
    .map(item => ({ ...item, name: 'minecraft:' + bare(item.name) }))
}

const held = (items, name) => count(name, items)

function homeCarryCount (name, items) {
  let total = held(items, name)
  if (name.startsWith('iron_')) {
    total += held(items, 'diamond_' + name.slice(5)) + held(items, 'netherite_' + name.slice(5))
  } else if (name === 'bucket') {
    total += held(items, 'water_bucket')
  }
  return total
}

function fireResistancePotions (items) {
  return items
    .filter(item => item.name === 'minecraft:potion' && [12, 13].includes(item.metadata))
    .reduce((sum, item) => sum + item.count, 0)
}

function fmtCount (known, current, target, unit = '個') {
  return known ? `${current} / ${target} ${unit}` : `必要 ${target}${unit}（受信待ち）`
}

function diamondEquipment (items) {
  const equipment = new Set(normalizeItems(items).map(item => bare(item.name)))
  return diamondPieces.map(([piece, label, cost]) => ({
    label,
    cost,
    done: equipment.has(`diamond_${piece}`) || equipment.has(`netherite_${piece}`)
  }))
}

function upperMineStatus (site) {
  const plan = site?.plan
  const progress = site?.progress?.upper
  const validPlan = plan?.version === 1 && Array.isArray(plan.layers) && Array.isArray(plan.segments) &&
    Array.isArray(plan.storage) && plan.layers.some(entry => entry.id === 'upper')
  const landed = validPlan && site.shaft?.landings?.upper === true
  const pairs = validPlan ? (plan.storage.find(room => room.layer === 'upper')?.pairs ?? []) : []
  const plannedPairs = pairs.length
  const builtPairs = pairs.filter(pair => {
    const saved = site.storage?.pairs?.[pair.id]
    return saved?.slots === 54 && saved.positions?.length === 2 &&
      pair.positions.every((position, index) => saved.positions[index] && key(position) === key(saved.positions[index]))
  }).length
  const chestsReady = plannedPairs > 0 && builtPairs === plannedPairs

  let corridorSteps = 0
  if (validPlan && Number.isSafeInteger(progress?.cursor) && Number.isSafeInteger(progress?.confirmedSteps)) {
    const steps = mineSteps(plan, { layer: 'upper' })
    if (progress.cursor >= 1 && progress.cursor <= steps.length && progress.confirmedSteps <= progress.cursor) {
      // A skipped branch advances the cursor without adding a confirmed step.
      const storageSteps = steps.slice(0, progress.cursor).filter(step => step.kind === 'storage').length
      corridorSteps = Math.max(0, progress.confirmedSteps - storageSteps)
    }
  }
  const corridorReady = corridorSteps >= 1
  return {
    built: landed && chestsReady && corridorReady,
    landed,
    plannedPairs,
    builtPairs,
    chestsReady,
    corridorSteps,
    corridorReady
  }
}

const upperMineBuilt = site => upperMineStatus(site).built

function branchMineChecks (record) {
  const mine = record?.early?.mine
  const sites = [mine?.branch, ...(Array.isArray(mine?.sites) ? mine.sites : [])].filter(Boolean)
  const chosen = sites.find(upperMineBuilt) ?? mine?.branch ?? sites[0] ?? null
  const status = upperMineStatus(chosen)
  return [
    {
      label: '上層の縦坑を着底（Y=16）',
      status: status.landed ? 'done' : 'pending',
      value: status.landed ? '着底済み' : '未着底'
    },
    {
      label: '上層収納室のラージチェストを設置',
      status: status.chestsReady ? 'done' : 'pending',
      value: status.plannedPairs ? `${status.builtPairs} / ${status.plannedPairs} 組` : '計画待ち'
    },
    {
      label: '上層の坑道を 1 区間以上掘削（達成で次へ）',
      status: status.corridorReady ? 'done' : 'pending',
      value: `${status.corridorSteps} / 1 区間`
    }
  ]
}

function baseChecks (stage, house, check) {
  const done = Boolean(house?.built || house?.done || stage.reached)
  const leftEntries = house?.left && typeof house.left === 'object'
    ? Object.entries(house.left)
      .filter(([, countLeft]) => Number.isSafeInteger(countLeft) && countLeft > 0)
      .sort((a, b) => b[1] - a[1])
    : []
  const totalLeft = leftEntries.reduce((sum, [, countLeft]) => sum + countLeft, 0)
  const rows = [
    check(
      '設計図どおりの本拠点（7×7・ベッド・チェスト2組等）を建築（達成で次へ）',
      done,
      done ? '建築完了' : totalLeft > 0 ? `残り ${totalLeft} ブロック` : '着工待ち'
    )
  ]
  if (!done && leftEntries.length) {
    for (const [item, countLeft] of leftEntries.slice(0, 6)) {
      rows.push(check(`残り設置: ${HOUSE_ITEM_LABELS[item] ?? item}`, false, `残り ${countLeft} 個`))
    }
  }
  return rows
}

function homeReserveChecks (stage, items, record, { known, shared }, check) {
  const early = record?.early
  const reserveDone = Boolean(early?.reserveReady || stage.reached)
  const chest = reserveCounts(shared)
  const batch = early?.reserveIron ?? null
  const mineReq = early?.mine?.branch?.request?.resource === 'raw_iron' ? early.mine.branch.request : null
  const rawTarget = Number.isSafeInteger(batch?.rawTarget) && batch.rawTarget > 0
    ? batch.rawTarget
    : (Number.isSafeInteger(mineReq?.targetHeld) && mineReq.targetHeld > 0 ? mineReq.targetHeld : 0)
  const ingotTarget = Number.isSafeInteger(batch?.target) && batch.target > 0 ? batch.target : 0
  const homeNeed = Object.fromEntries(home)
  const rows = [check('本拠点のベッドを復帰地点に設定', early?.spawnReady || reserveDone)]

  if (!reserveDone && rawTarget > 0) {
    const rawIron = held(items, 'raw_iron')
    rows.push(check('鉄の原石を集める（今回の精錬目標）', known && rawIron >= rawTarget, fmtCount(known, rawIron, rawTarget, '個')))
  }
  if (!reserveDone && ingotTarget > 0) {
    const ingots = held(items, 'iron_ingot')
    rows.push(check('鉄インゴットを精錬して確保（今回の目標）', known && ingots >= ingotTarget, fmtCount(known, ingots, ingotTarget, '個')))
  }

  for (const [name, label, unit] of HOME_ITEMS) {
    const need = homeNeed[name] ?? 1
    const fullLabel = `${label}（予備${need}＋携行${need}${unit}）`
    if (reserveDone) {
      rows.push(check(fullLabel, true, `箱 ${need}/${need}・持 ${need}/${need}`))
    } else if (!known) {
      rows.push(check(fullLabel, false, `計 ${need * 2}${unit}（受信待ち）`))
    } else if (chest) {
      const inChest = chest[name] ?? 0
      const carried = homeCarryCount(name, items)
      rows.push(check(fullLabel, inChest >= need && carried >= need, `箱 ${inChest}/${need}・持 ${carried}/${need}`))
    } else {
      const carried = homeCarryCount(name, items)
      rows.push(check(fullLabel, false, `持 ${carried}・箱未確認 / 計${need * 2}${unit}`))
    }
  }
  return rows
}

function stageChecks (stage, rawItems, house, record, options = {}) {
  const { early, nether, stronghold, end } = record ?? {}
  const known = options.known ?? Array.isArray(rawItems)
  const items = normalizeItems(rawItems)
  const check = (label, done, value) => ({ label, status: done ? 'done' : 'pending', ...(value == null ? {} : { value }) })

  switch (stage.id) {
    case 'wood': {
      const rows = [check('木以上のツルハシを 1 本確保（達成で次へ）', stage.reached, stage.reached ? '1 / 1 本' : known ? '0 / 1 本' : '受信待ち')]
      if (!stage.reached) {
        const logs = held(items, 'log'), planks = held(items, 'planks'), sticks = held(items, 'stick')
        rows.push(check('必要素材: 板材 3・棒 2（原木 2 本分）', known && planks >= 3 && sticks >= 2, known ? `原木${logs}・板${planks}/3・棒${sticks}/2` : '受信待ち'))
      }
      return rows
    }
    case 'base': return baseChecks(stage, house, check)
    case 'stone': {
      const rows = [check('石以上のツルハシを 1 本確保（達成で次へ）', stage.reached, stage.reached ? '1 / 1 本' : known ? '0 / 1 本' : '受信待ち')]
      if (!stage.reached) {
        const cobble = held(items, 'cobblestone'), sticks = held(items, 'stick')
        rows.push(check('必要素材: 丸石 3 個・棒 2 本', known && cobble >= 3 && sticks >= 2, known ? `丸石 ${cobble}/3・棒 ${sticks}/2` : '受信待ち'))
      }
      return rows
    }
    case 'iron': {
      const rows = [check('鉄以上のツルハシを 1 本確保（達成で次へ）', stage.reached, stage.reached ? '1 / 1 本' : known ? '0 / 1 本' : '受信待ち')]
      if (!stage.reached) {
        const ingots = held(items, 'iron_ingot'), rawIron = held(items, 'raw_iron'), sticks = held(items, 'stick')
        rows.push(check('必要素材: 鉄インゴット 3 個（原石 3）・棒 2 本', known && ingots >= 3 && sticks >= 2, known ? `鉄${ingots}/3・原石${rawIron}・棒${sticks}/2` : '受信待ち'))
      }
      return rows
    }
    case 'home_reserve': return homeReserveChecks(stage, items, record, { known, shared: options.shared }, check)
    case 'diamond': {
      const pieces = diamondEquipment(items)
      const allDone = Boolean(early?.finished || stage.reached)
      const missingDiamonds = allDone ? 0 : pieces.reduce((sum, piece) => sum + (piece.done ? 0 : piece.cost), 0)
      const heldDiamonds = held(items, 'diamond')
      return [
        check(
          'ダイヤ必要数（全6部位で29個・達成で次へ）',
          allDone || (known && heldDiamonds >= missingDiamonds),
          allDone ? '6 / 6 部位' : known ? `所持 ${heldDiamonds} / 残り ${missingDiamonds} 個` : '受信待ち'
        ),
        ...pieces.map(piece => check(
          `ダイヤの${piece.label}（ダイヤ ${piece.cost} 個）`,
          allDone || piece.done,
          allDone || piece.done ? '1 / 1' : known ? '0 / 1' : '受信待ち'
        ))
      ]
    }
    case 'nether': {
      const outfitted = Boolean(early?.outfitted || stage.reached)
      const gateLit = Boolean(nether?.homeGate || stage.reached)
      const gearCount = ['golden_boots', 'shield', 'flint_and_steel', 'bow'].filter(name => held(items, name) >= 1).length
      const arrows = held(items, 'arrow'), food = held(items, 'food'), cobble = held(items, 'cobblestone'), obsidian = held(items, 'obsidian')
      return [
        check('偵察装備（金ブーツ1・盾1・火打石1・弓1）', outfitted || (known && gearCount === 4), outfitted ? '4 / 4 種' : fmtCount(known, gearCount, 4, '種')),
        check('矢を集める（32 本）', outfitted || (known && arrows >= 32), outfitted ? '32 / 32 本' : fmtCount(known, arrows, 32, '本')),
        check('調理済み食料を集める（32 個）', outfitted || (known && food >= 32), outfitted ? '32 / 32 個' : fmtCount(known, food, 32, '個')),
        check('丸石を集める（128 個）', outfitted || (known && cobble >= 128), outfitted ? '128 / 128 個' : fmtCount(known, cobble, 128, '個')),
        check('ネザーゲート用の黒曜石（10 個）', gateLit || (known && obsidian >= 10), gateLit ? '10 / 10 個' : fmtCount(known, obsidian, 10, '個')),
        check('偵察装備の装着と本拠点での出発確認', outfitted),
        check('現世のゲートを点火して記録', gateLit),
        check('ネザー側のゲートと退避場所を確認', Boolean((nether?.gate && nether?.sheltered) || stage.reached)),
        check('現世に戻り、ゲートの往復を確認（達成で次へ）', stage.reached)
      ]
    }
    case 'rods': {
      const rods = held(items, 'blaze_rod')
      const budget = held(items, 'ender_eye') + held(items, 'blaze_powder') + 2 * rods
      const wart = held(items, 'nether_wart')
      const cream = held(items, 'magma_cream') + held(items, 'slime_ball')
      const potions = fireResistancePotions(items)
      const banked = Boolean(nether?.banked || stage.reached)
      const brewed = Boolean(nether?.brewed || stage.reached)
      return [
        check('ネザー要塞またはブレイズの出現場所を発見', Boolean(nether?.fortress || nether?.blazeSite || stage.reached)),
        check('最初のブレイズロッド 2 本を本拠点へ預ける', banked, banked ? '2 / 2 本' : fmtCount(known, rods, 2, '本')),
        check('耐火醸造素材（ウォート 1・マグマクリーム/スライム 1）', brewed || (known && wart >= 1 && cream >= 1), brewed ? '確保済み' : known ? `ウォート${wart}/1・玉${cream}/1` : '受信待ち'),
        check('耐火のポーションを確保（1 本以上・最大 3 本醸造）', brewed, brewed ? '確保済み' : known ? `${potions} / 1 本以上` : '受信待ち'),
        check('アイ 20 個分のブレイズ素材（ロッド 10 本分）で帰還（達成で次へ）', stage.reached, stage.reached ? '20 / 20 個分' : fmtCount(known, budget, 20, '個分'))
      ]
    }
    case 'stronghold': {
      const departed = Boolean(stronghold?.departed || stronghold?.portal || stage.reached)
      const eyes = held(items, 'ender_eye'), pearls = held(items, 'ender_pearl'), gold = held(items, 'gold_ingot')
      const beds = held(items, 'bed'), chests = held(items, 'chest')
      const iron = held(items, 'iron_ingot'), planks = held(items, 'planks'), tables = held(items, 'crafting_table')
      const arrows = held(items, 'arrow'), food = held(items, 'food'), cobble = held(items, 'cobblestone'), water = held(items, 'water_bucket')
      const pearlSummary = gold > 0 ? `アイ ${eyes}/20（玉${pearls}・金${gold}）` : `アイ ${eyes}/20（玉${pearls}）`
      return [
        check('エンダーアイを 20 個用意（ピグリン交易等でパール収集）', departed || (known && eyes >= 20), departed ? '20 / 20 個' : known ? pearlSummary : '受信待ち'),
        check('前哨用のベッド 1 個・チェスト 2 個を用意', departed || (known && beds >= 1 && chests >= 2), departed ? '準備済み' : known ? `ベッド${beds}/1・箱${chests}/2` : '受信待ち'),
        check('前哨予備の圧縮資材（鉄27・板材12・作業台1）', departed || Boolean(stronghold?.reserve) || (known && iron >= 27 && planks >= 12 && tables >= 1), departed || stronghold?.reserve ? '準備済み' : known ? `鉄${iron}/27・板${planks}/12・台${tables}/1` : '受信待ち'),
        check('地下要塞のポータル部屋を発見', Boolean(stronghold?.portal || stage.reached)),
        check('前哨ベッドを復帰地点に設定', Boolean(stronghold?.spawnAt || stage.reached)),
        check('前哨チェストに再出撃装備を現地クラフトして備蓄', Boolean(stronghold?.reserve || stage.reached)),
        check('本戦用の消耗品（矢128・食料32・丸石128・水バケツ1）', stage.reached || (known && arrows >= 128 && food >= 32 && cobble >= 128 && water >= 1), stage.reached ? '確認済み' : known ? `矢${arrows}/128・食${food}/32・石${cobble}/128` : '受信待ち'),
        check('起動したポータル 9 マスと本戦の装備を確認（達成で次へ）', stage.reached)
      ]
    }
    case 'end': {
      const cleared = Array.from({ length: 10 }, (_, index) => end?.spikes?.[index]?.cleared).filter(Boolean).length
      if (end?.preexisting) return [
        { label: 'クリスタルのない柱を確認', status: 'skipped' },
        check('開通済みの帰還ポータルを確認', true)
      ]
      return [
        check('ドラゴンを観測', end?.dragon),
        check('クリスタルのない柱を確認', cleared === 10, `${cleared} / 10 本`),
        check('戦闘後に帰還ポータルが開通したことを確認', end?.victory)
      ]
    }
    case 'return': return [
      check('帰還ポータルを確認', end?.victory || end?.preexisting),
      check('生存したまま現世に戻ったことを確認（遠征完了）', stage.reached)
    ]
  }
}

module.exports = { shortLabels, diamondEquipment, stageChecks, branchMineChecks }
