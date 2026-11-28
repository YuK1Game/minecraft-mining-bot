'use strict'

// What each step of the expedition's order (dragon-runtime.js `step`) says to the decision journal
// (decision-journal.js): [branch, what it chose, the received numbers that made it choose so].
// The order itself is the runtime's; here are only the words. Every number is read where the runtime read it.
const { one } = require('./decision-journal')

// Main slots taken; null while the inventory is not received.
function taken (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return null
  return new Set((inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot)).size
}
const slots = inventory => { const n = taken(inventory); return n == null ? '持ち物は未受信' : `持ち物 ${n}/36 枠` }
const minutes = ms => Math.max(0, Math.ceil(ms / 60000))
const asked = record => { const ask = record?.early?.mine?.branch?.request; return ask ? `採掘場へ頼んでいる物: ${ask.resource} を ${ask.targetHeld} 個まで（${ask.layer ?? 'upper'}）` : null }

// The early objective (dragon-early.js `earlyObjective`) and what its step is after now.
function early (objective, record) {
  const state = record?.early ?? {}, pin = objective.id === 'home_reserve' ? state.gather : null, iron = objective.id === 'home_reserve' ? state.reserveIron : null
  const why = pin ? `予備チェストを調べた結果、${pin.name} が ${pin.count} 個要る`
    : iron ? `鉄をまとめて ${iron.target} 個そろえる`
      : objective.id === 'home_reserve' ? '予備チェストを開けて、足りない装備を調べる'
        : objective.id === 'home_spawn' ? '復帰地点（家のベッド）をまだ確認していない'
          : objective.id === 'diamond' ? 'ダイヤ装備がまだそろっていない'
            : objective.legacy ? '通常の作業の担当' : null
  return [`early.${objective.id}:${pin?.name ?? (iron ? 'iron' : '')}`, objective.label, [why, ['home_reserve', 'diamond'].includes(objective.id) ? asked(record) : null].filter(Boolean).join('・') || null]
}

module.exports = {
  taken,
  early,
  restLeave: health => ['rest.leave', '回復の穴から出ます', `体力 ${one(health)} で回復待ちが終わった`],
  night: clock => ['night', '夜なので本拠点へ戻り、朝を待ちます', `受信した時計 ${Number.isSafeInteger(clock?.time) ? ((clock.time % 24000) + 24000) % 24000 : '?'}（夕方は 11500 から）`],
  mineCargo: (inventory, pending) => ['mine.cargo', '採掘場の荷を収納します', pending ? '収納の続きが残っている' : slots(inventory)],
  pack: inventory => ['pack', 'いらない物を捨てて持ち物を空けます', `${slots(inventory)}（35 枠から）`],
  heal: (health, hunger) => ['heal', '体力の回復を先にします', `体力 ${one(health)}（12 以下で始め、18 で終わり）・満腹度 ${one(hunger)}`],
  hungry: (hunger, want) => ['hungry', want === 'eat' ? '食事を先に取ります' : '食料を先に用意します', `満腹度 ${one(hunger)}（18 未満）${want === 'eat' ? '' : 'で、食べられる物がない'}`],
  recover: record => ['recover', '死亡後の復帰・回収を先にします', record.recovery ? '復帰の記録が残っている' : '落とした物の回収の記録が残っている'],
  weapon: () => ['weapon', '石の剣を作ります', '持ち物に武器がない'],
  tree: logs => ['tree', '伐り始めた木を最後まで伐ります', Number.isFinite(logs) ? `記録した木の原木 ${logs} 個` : '足場の片付けが残っている'],
  mineExit: label => ['mine.exit', '採掘場からはしごで地上へ出ます', `通常の作業の番（${String(label ?? '').replace(/。$/, '')}）で、採掘場の中にいる`],
  mineMend: reached => ['mine.mend', reached ? '採掘場の仕上げの足場へ着いたので、仕上げを続けます' : '採掘場の設置の受信を確かめたので、作業を続けます', null],
  held: (hold, now) => ['held:' + hold.code, '進まない目的を保留して、見直しを待ちます', `保留の理由 ${hold.code}・見直しは遅くとも ${minutes(hold.until - now)} 分後`],
  stage: (name, dim) => ['stage.' + name, ({ end: 'エンドの工程を進めます', endReturn: 'エンドへの出撃・帰還の工程を進めます', nether: 'ネザーの工程を進めます', stronghold: '要塞の工程を進めます', dimension: '次元の受信を待ちます' })[name], `段階 ${name}・いまの次元 ${dim ?? '?'}`]
}
