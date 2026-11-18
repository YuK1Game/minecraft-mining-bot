'use strict'

const { windowAt, transferBrew } = require('./dragon-brew-window')
const { approach } = require('./dragon-supply-gather')

const EFFECTS = {
  fire_resistance: { base: 12, extended: 13, reagent: 'magma_cream', effect: 12 },
  slow_falling: { base: 40, extended: 41, reagent: 'phantom_membrane', effect: 27 }
}
const pending = reason => ({ done: false, reason })
const success = reason => ({ done: true, reason })
const tag = name => 'minecraft:' + name

function brewStep (slots, fuel, inv, spec, nameOf, wanted = 1) {
  const bottle = raw => nameOf(raw?.network_id) === tag('potion') ? raw.metadata : null
  const own = (name, metadata) => inv.find(i => i.name === tag(name) && i.count > 0 && (metadata == null || i.metadata === metadata))
  const bottles = slots.slice(1, 4), complete = bottles.findIndex(b => bottle(b) === spec.extended)
  if (complete >= 0) return { take: complete + 1 }
  if (bottles.some(b => b.network_id && ![0,4,spec.base].includes(bottle(b)))) return { wait: '醸造台に別の種類のポーションが入っています。' }
  if (slots[0].network_id) return { wait: '材料の醸造が完了し、瓶の種類が変わるのを待ちます。' }
  const empty = bottles.findIndex(b => !b.network_id)
  const active = bottles.filter(b => b.network_id).map(bottle)
  if (empty >= 0 && (!active.length || active.every(x => x === 0) && (active.length < wanted || own('potion',0)))) {
    const row = own('potion',0)
    return row ? { slot: 1 + empty, row } : { need:'water_bottle' }
  }
  if (new Set(active).size > 1) return { wait:'醸造台の瓶の種類が揃っていません。' }
  if (!slots[4].network_id && !(fuel > 0)) {
    const row = own('blaze_powder')
    return row ? { slot:4,row } : { need:'blaze_powder' }
  }
  const ingredient = active[0] === 0 ? 'nether_wart' : active[0] === 4 ? spec.reagent : 'redstone'
  const row = own(ingredient)
  return row ? { slot:0,row } : { need:ingredient }
}

function createDragonBrewing (ctx, { rows, acquire, station, fill, sleep }) {
  const { runtime, operations, cancelled } = ctx
  const items = runtime.dragonItems
  function countPotion (effect) {
    const spec = EFFECTS[effect]
    return spec ? rows().filter(i => i.name === tag('potion') && [spec.extended, spec.base].includes(i.metadata)).reduce((n,i) => n+i.count,0) : 0
  }
  function remainingEffect (effect) {
    if (effect === 'slow_falling') {
      const state = operations.diagnostics.slowFalling()
      return state?.active && state.serverConfirmed ? state.remainingMsEstimate : 0
    }
    const event = operations.diagnostics.effectEvents().events.findLast(e => e.effectId === EFFECTS[effect]?.effect)
    return event && event.event !== 'remove' ? Math.max(0, event.durationTicks * 50 - (Date.now() - event.receivedAt)) : 0
  }
  async function brew (effect, { count = 1, position } = {}) {
    const spec = EFFECTS[effect]
    if (!spec || cancelled()) return pending('醸造の開始条件を確認します。')
    if (countPotion(effect) >= count) return success('必要なポーションの所持を確認しました。')
    const ledger = ctx.memory?.early ?? ctx.shared
    async function gather (name) {
      if (name === 'water_bottle') {
        if (rows().some(i => i.name === tag('potion') && i.metadata === 0)) return true
        await fill(name)
        return rows().some(i => i.name === tag('potion') && i.metadata === 0)
      }
      return (await acquire(name, 1)).done
    }
    // Gathering can move the player out of range of the stand. Complete the
    // observed shortage before travelling back; a dry base must not pull the
    // bot back from its water search on every dispatch.
    if (ledger.brewNeed?.effect === effect) {
      if (!await gather(ledger.brewNeed.name)) return pending(ledger.brewNeed.name + ' を醸造用に準備しています。')
      delete ledger.brewNeed
    }
    const host = runtime.host(), at = position ?? await station('brewing_stand')
    if (!at || cancelled() || !await approach(ctx, at) || cancelled()) return pending('醸造台を準備しています。')
    let needed = null, window = null
    try {
      const receipt = await items.openStand(at)
      for (let i=0; i<30 && !cancelled(); i++) {
        window = windowAt(host, at)
        if (window && window.id === (receipt.windowId === 'first' ? 1 : receipt.windowId)) break
        window = null
        await sleep(100)
      }
      if (!window || cancelled()) return pending('醸造台の5スロットの受信を待ちます。')
      const step = brewStep(window.slots, window.fuel, rows(), spec, items.name, Math.min(3, count - countPotion(effect)))
      if (step.wait) return pending(step.wait)
      if (step.need) needed = step.need
      else {
        const take = step.take != null
        const playerSlot = take ? Array.from({length:36}, (_,i)=>i).find(i=>items.rawItem(i)?.network_id === 0) : step.row.slot
        if (playerSlot == null) return pending('醸造したポーションを置く持ち物の空きを待っています。')
        const moved = await transferBrew({ host, w:window, playerSlot, brewSlot:take ? step.take : step.slot, take, rawItem:items.rawItem, commit:items.commit, cancelled, sleep })
        if (!moved && !cancelled()) await operations.inventory.resync()
        return pending('醸造台と持ち物の移動結果を再確認します。')
      }
    } finally {
      if (window && !cancelled() && windowAt(host,at) === window) operations.crafting.closeContainer()
    }
    if (cancelled()) return pending('醸造の操作を中断しました。')
    ledger.brewNeed = { effect, name:needed }
    if (await gather(needed)) delete ledger.brewNeed
    return pending(needed + ' を醸造用に準備しています。')
  }

  async function drink (effect) {
    const spec = EFFECTS[effect]
    if (!spec || cancelled()) return pending('飲用を中断しました。')
    if (remainingEffect(effect) > 20000) return success('効果を確認しました。')
    const potion = rows().find(i=>i.name === tag('potion') && i.metadata === spec.extended) ??
      rows().find(i=>i.name === tag('potion') && i.metadata === spec.base)
    if (!potion) return pending('対象のポーションがありません。')
    const selected = await operations.inventory.equip(potion.slot)
    if (cancelled()) return pending('飲用を中断しました。')
    const slot = selected?.slot ?? potion.slot, raw = items.rawItem(slot)
    if (slot > 8 || raw?.metadata !== potion.metadata || items.name(raw.network_id) !== tag('potion')) return pending('飲用するポーションの装備を確認します。')
    const input = items.input(), start = input?.stats()
    if (!input || start.running || start.target) return pending('飲用のための入力が空くのを待ちます。')
    const bottleId = items.id(tag('glass_bottle'))
    if (!Number.isInteger(bottleId)) return pending('空き瓶のアイテム登録を待っています。')
    let startedAt = null, sent = null
    const zero = { x:0,y:0,z:0 }
    const send = completion => {
      const newItem = {network_id:bottleId,count:1,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:'false',can_place_on:[],can_destroy:[]}}
      const legacy = completion ? {legacy_request_id:runtime.host().allocate('interaction'),legacy_transactions:[{container_id:12,changed_slots:[{slot_id:slot}]}]} : {legacy_request_id:0,legacy_transactions:null}
      const actions = completion ? [{source_type:'container',window_id:0,flags:null,slot,old_item:raw,new_item:newItem}] : []
      input.sendTransaction({ legacy, actions, data: { action_type:'click_air',trigger_type:completion?'simulation_tick':'player_input',block_position:zero,face:0,hotbar_slot:slot,hand:'main_hand',held_item:raw,player_pos:ctx.where(),click_pos:zero,block_runtime_id:0,client_prediction:'success',client_cooldown_state:'off' } }, {onSent:()=>{ if (!completion) {startedAt=Date.now();sent=input.stats().sent + 1} }})
    }
    try {
      input.start(); send(false)
      let completed = false
      const baseline = remainingEffect(effect)
      for (let i=0;i<70 && !cancelled();i++) {
        if (remainingEffect(effect)>baseline+500 && rows().every(i=>i.slot!==slot || i.name!==tag('potion') || i.metadata!==potion.metadata)) return success('飲用後の効果と消費をサーバーで確認しました。')
        if (!completed && startedAt !== null && Date.now()-startedAt>=1600 && input.stats().sent >= sent+32 && items.rawItem(slot)?.stack_id === raw.stack_id) { send(true); completed=true }
        await sleep(100)
      }
      return pending('飲用後の効果通知を待ちます。')
    } finally { input.stop() }
  }
  return { brew, drink, countPotion, remainingEffect }
}
module.exports = { createDragonBrewing, brewStep, EFFECTS }
