'use strict'

const { key, mineSteps } = require('./mining/mine-geometry')

const shortLabels = {
  wood: '木', base: '拠点', stone: '石', iron: '鉄', home_reserve: '備蓄', branch_mine: 'ブランチ採掘場',
  diamond: 'ダイヤ', nether: 'ゲート', rods: 'ネザー要塞', stronghold: '地下要塞', end: 'ドラゴン', return: '帰還'
}

const diamondPieces = [
  ['pickaxe', 'ツルハシ'], ['sword', '剣'], ['helmet', 'ヘルメット'],
  ['chestplate', 'チェストプレート'], ['leggings', 'レギンス'], ['boots', 'ブーツ']
]

function diamondEquipment (items) {
  const equipment = new Set(items.filter(item => Number.isSafeInteger(item?.count) && item.count > 0).map(item => String(item.name).replace(/^minecraft:/, '')))
  return diamondPieces.map(([piece, label]) => ({
    label,
    done: equipment.has(`diamond_${piece}`) || equipment.has(`netherite_${piece}`)
  }))
}

function upperMineBuilt (site) {
  const plan = site?.plan
  const progress = site?.progress?.upper
  if (plan?.version !== 1 || !Array.isArray(plan.layers) || !Array.isArray(plan.segments) || !Array.isArray(plan.storage) ||
    !plan.layers.some(entry => entry.id === 'upper') || site.shaft?.landings?.upper !== true ||
    !Number.isSafeInteger(progress?.cursor) || !Number.isSafeInteger(progress?.confirmedSteps)) return false

  const storage = plan.storage.find(room => room.layer === 'upper')?.pairs
  if (!storage?.length || !storage.every(pair => {
    const saved = site.storage?.pairs?.[pair.id]
    return saved?.slots === 54 && saved.positions?.length === 2 &&
      pair.positions.every((position, index) => saved.positions[index] && key(position) === key(saved.positions[index]))
  })) return false

  const steps = mineSteps(plan, { layer: 'upper' })
  if (progress.cursor < 1 || progress.cursor > steps.length || progress.confirmedSteps > progress.cursor) return false
  // A skipped branch advances the cursor without adding a confirmed step.
  const storageSteps = steps.slice(0, progress.cursor).filter(step => step.kind === 'storage').length
  return progress.confirmedSteps > storageSteps
}

function branchMineChecks (record) {
  const mine = record?.early?.mine
  const sites = [mine?.branch, ...(Array.isArray(mine?.sites) ? mine.sites : [])]
  return [{ label: '鉄・石炭を採る上層の坑道・はしご・収納', status: sites.some(upperMineBuilt) ? 'done' : 'pending' }]
}

function stageChecks (stage, items, house, record) {
  const { early, nether, stronghold, end } = record ?? {}
  const check = (label, done, value) => ({ label, status: done ? 'done' : 'pending', ...(value == null ? {} : { value }) })
  switch (stage.id) {
    case 'wood': return [check('木以上のツルハシを確保', stage.reached)]
    case 'base': return [check('設計図どおりの本拠点を建築', house?.built || house?.done || stage.reached)]
    case 'stone': return [check('石以上のツルハシを確保', stage.reached)]
    case 'iron': return [check('鉄以上のツルハシを確保', stage.reached)]
    case 'home_reserve': return [
      check('本拠点のベッドを復帰地点に設定', early?.spawnReady),
      check('ラージチェストに予備の鉄装備・盾・バケツ・食料32個を備蓄', early?.reserveReady)
    ]
    case 'diamond': return diamondEquipment(items).map(piece => check(piece.label, early?.finished || piece.done))
    case 'nether': return [
      check('偵察用の装備と食料を用意', early?.outfitted),
      check('現世のゲートを点火して記録', nether?.homeGate),
      check('ネザー側のゲートと退避場所を確認', nether?.gate && nether?.sheltered),
      check('現世に戻り、ゲートの往復を確認', stage.reached)
    ]
    case 'rods': return [
      check('ネザー要塞またはブレイズの出現場所を発見', nether?.fortress || nether?.blazeSite),
      check('最初のブレイズロッド2本を本拠点へ預ける', nether?.banked),
      check('耐火のポーションを確保', nether?.brewed),
      check('アイ20個分のブレイズ素材を持って現世へ帰る', stage.reached)
    ]
    case 'stronghold': return [
      check('地下要塞のポータル部屋を発見', stronghold?.portal),
      check('前哨ベッドを復帰地点に設定', stronghold?.spawnAt),
      check('前哨のラージチェストに再出撃装備を備蓄', stronghold?.reserve),
      check('起動したポータル9マスと本戦の装備を確認', stage.reached)
    ]
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
      check('生存したまま現世に戻ったことを確認', stage.reached)
    ]
  }
}

module.exports = { shortLabels, diamondEquipment, stageChecks, branchMineChecks }
