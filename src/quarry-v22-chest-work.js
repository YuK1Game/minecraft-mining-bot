'use strict'

// The surface double chest is only a start/end station. All intermediate
// mining material is deposited into carried shulkers underground. This
// controller never creates items and never treats a wire send as a transfer.
const { isDeepStrictEqual } = require('node:util')
const { serialize, deserialize } = require('node:v8')
const { validateV22Loadout, CARGO, roles, singles } = require('./quarry-v22-loadout')
const { isShulkerBox } = require('./quarry-inventory')
const copy = value => structuredClone(value)
const pack = value => serialize(value).toString('base64')
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const fail = code => Object.assign(new Error(code), { code })
const pkey = p => [p?.x, p?.y, p?.z].join(',')
const valid = r => r && Number.isInteger(r.network_id) && Number.isInteger(r.count) &&
  (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isInteger(r.stack_id) && r.stack_id > 0)
const empty = r => valid(r) && r.network_id === 0
const clean = name => String(name ?? '').replace(/^minecraft:/, '')
const mainItems = view => view?.known === true && view.slots?.length === 36 ? view.slots : null
const equipmentEmpty = view => view?.armor?.known === true && view?.offhand?.known === true &&
  view.armor.slots?.length === 4 && view.armor.slots.every(s => s?.known && s.empty) && view.offhand.slots?.[0]?.known && view.offhand.slots[0].empty
const chestSlots = (view, at) => {
  const box = view?.openContainer
  if (box?.known !== true || box.slotCount !== 54 || box.slots?.length !== 54 ||
    pkey(box.position) !== pkey(at) || box.slots.some(slot => slot?.known !== true)) throw fail('LOADOUT_CHEST_UNCONFIRMED')
  return box.slots
}
const worldKey = s => JSON.stringify([s?.profile, s?.realm?.id, s?.dimension])
const lifeKey = s => JSON.stringify([worldKey(s), s?.lifecycle?.deathId])
const itemName = raw => typeof raw?.name === 'string' ? raw.name : null
const sameNbt = (a,b) => {
  if (!valid(a) || !valid(b) || a.network_id !== b.network_id || a.count !== b.count || a.metadata !== b.metadata) return false
  return isDeepStrictEqual(a.extra, b.extra)
}
const known = s => s?.known === true && s.empty !== true && typeof s.name === 'string' && Number.isInteger(s.count) && s.count > 0

function buildStartupPlan (slots) {
  const used = new Set(), plan = []
  const pick = (fn, label) => {
    const index = slots.findIndex((item,i)=>!used.has(i)&&fn(item))
    if (index < 0) throw fail('LOADOUT_MISSING_' + label)
    used.add(index); return index
  }
  // Equip armor after withdrawal. Its four main slots can then be re-used
  // for the three initial tools / consumables.
  const initial = [
    ...['diamond_sword', 'bow', 'bread', 'arrow'].map(name => ({ name: 'minecraft:' + name, count: name === 'bread'|| name === 'arrow' ? 64 : 1 })),
    ...['diamond_helmet','diamond_chestplate','diamond_leggings','diamond_boots'].map(name => ({ name:'minecraft:'+name,count:1 }))
  ]
  for (const expected of initial) {
    const source = pick(item => item.name === expected.name && item.count === expected.count && (expected.name !== 'minecraft:bow' ||
      item.enchantmentsKnown === true && item.enchantments?.some(x=>clean(x.name)==='infinity'&&x.level>=1)), clean(expected.name))
    plan.push({ from: source, to: plan.length, name: expected.name, count: expected.count })
  }
  for (const role of ['pickaxe','shovel','dirt','totem']) {
    const name = roles[role].box
    const source = pick(item => item.name===name&&item.count===1,role)
    plan.push({ from: source, to: plan.length, name, count:1 })
  }
  for (let i=0; i<CARGO; i++) {
    const name='minecraft:purple_shulker_box'
    const source=pick(item=>item.name===name&&item.count===1,'cargo')
    plan.push({ from: source, to: plan.length, name, count:1 })
  }
  if(plan.length!==34)throw fail('LOADOUT_PLAN_INVALID')
  return plan
}

function createQuarryV22ChestWork ({ getState, getView, getRawMain, getRawChest, open, close,
  withdraw, deposit, equipArmor, equipmentTransfer, resync = async()=>true, now=Date.now } = {}) {
  if ([getState,getView,getRawMain,getRawChest,open,close,withdraw,deposit,equipArmor,equipmentTransfer,resync,now].some(fn=>typeof fn!=='function')) throw new TypeError('V22 chest work requires observed 54-slot and equipment ports')
  let busy=false
  const current = (expectedWorld=null,expectedLife=null) => {
    const s=getState(), view=getView()
    if(s?.phase!=='spawned'||s.dead||s.isDead||s.lifecycle?.dead||!(s.health>0)||view?.known!==true||s.inventory?.known!==true||s.inventory?.uncertain) throw fail('LOADOUT_INVENTORY_UNKNOWN')
    if(expectedWorld!==null && worldKey(s)!==expectedWorld) throw fail('LOADOUT_WORLD_CHANGED')
    if(expectedLife!==null && lifeKey(s)!==expectedLife) throw fail('LOADOUT_LIFE_CHANGED')
    return {s,view}
  }
  const inStation = async request => {
    const pos=request.position
    if(!pos||!['x','y','z'].every(k=>Number.isSafeInteger(pos[k])&&Math.abs(pos[k])<=30000000)) throw fail('LOADOUT_CHEST_POSITION_INVALID')
    close()
    const opened=await open(pos,undefined,{expectedSlots:54})
    if(opened?.serverConfirmed!==true || opened.slotCount!==54) throw fail('LOADOUT_CHEST_OPEN_UNCONFIRMED')
    return chestSlots(current().view,pos)
  }
  const checkReceipt = (receipt,op) => {
    if(receipt?.serverConfirmed!==true||receipt.inventoryConfirmed!==true||receipt.containerConfirmed!==true||receipt.item!==op.name||receipt.count!==op.count||receipt.playerSlot!==op.to||receipt.chestSlot!==op.from)throw fail('LOADOUT_TRANSFER_UNCONFIRMED')
  }
  const rawFull = () => Array.from({length:36},(_,i)=>getRawMain(i))
  async function saveCheckpoint(cp,cb) {
    if(typeof cb!=='function')throw fail('LOADOUT_PERSISTENCE_REQUIRED')
    await cb(copy(cp))
  }
  async function withdrawAll (request,{onCheckpoint,signal}={}) {
    if(busy)throw fail('LOADOUT_BUSY')
    busy=true
    let cp=request?.checkpoint?copy(request.checkpoint):null
    try {
      signal?.throwIfAborted()
      const {s,view}=current()
      if(!cp) {
        if(!mainItems(view).every(slot=>slot.empty)||!equipmentEmpty(view))throw fail('START_INVENTORY_NOT_EMPTY')
        const slots=await inStation(request)
        const validation=validateV22Loadout({known:true,slots})
        if(!validation.ready) {
          const error=fail('LOADOUT_MISSING')
          error.details=validation.errors;throw error
        }
        cp={version:1,direction:'withdraw',operationId:request.operationId,jobId:request.jobId,world:worldKey(s),life:lifeKey(s),
          position:copy(request.position), phase:'withdraw',index:0,plan:buildStartupPlan(slots),intent:null,receipts:[],startedAt:now()}
        await saveCheckpoint(cp,onCheckpoint)
      }
      if(cp.version!==1||cp.direction!=='withdraw'||cp.jobId!==request.jobId||cp.operationId!==request.operationId||pkey(cp.position)!==pkey(request.position)||!Array.isArray(cp.plan)||cp.plan.length!==34||!Number.isInteger(cp.index)||cp.index<0||cp.index>34)throw fail('LOADOUT_CHECKPOINT_INVALID')
      current(cp.world,cp.life)
      await inStation(request)
      for(;cp.index<cp.plan.length;) {
        signal?.throwIfAborted()
        const op=cp.plan[cp.index],main=getRawMain(op.to),box=getRawChest(op.from)
        if(!valid(main)||!valid(box))throw fail('LOADOUT_RECEIPT_UNKNOWN')
        if(cp.intent) {
          if(cp.intent.index!==cp.index)throw fail('LOADOUT_CHECKPOINT_INVALID')
          if(await resync({signal})!==true)throw fail('LOADOUT_RECONCILE_MAIN_UNCONFIRMED')
          await inStation(request)
          const currentMain=getRawMain(op.to), currentBox=getRawChest(op.from)
          const beforeBox=unpack(cp.intent.beforeBox)
          // A crash between dispatch and checkpoint may only be resolved from
          // both received sides. Ambiguous changes remain paused.
          const done=empty(currentBox)&&currentMain.count===op.count&&sameNbt(currentMain,beforeBox)
          const unchanged=empty(currentMain)&&sameNbt(currentBox,beforeBox)
          if(!done&&!unchanged)throw fail('LOADOUT_TRANSFER_AMBIGUOUS')
          if(done){cp.receipts.push({kind:'reconciled_withdraw',from:op.from,to:op.to,name:op.name,count:op.count});cp.index++;cp.intent=null;await saveCheckpoint(cp,onCheckpoint);continue}
          cp.intent=null;await saveCheckpoint(cp,onCheckpoint)
        }
        if(!empty(main)||empty(box))throw fail('LOADOUT_SOURCE_CHANGED')
        cp.intent={index:cp.index,beforeMain:pack(main),beforeBox:pack(box)}
        await saveCheckpoint(cp,onCheckpoint)
        const receipt=await withdraw({chestSlot:op.from,targetSlot:op.to,count:op.count,expectedName:op.name,signal})
        checkReceipt(receipt,op)
        const afterMain=getRawMain(op.to),afterBox=getRawChest(op.from)
        if(!empty(afterBox)||afterMain.count!==op.count||!sameNbt(afterMain,box))throw fail('LOADOUT_TRANSFER_UNCONFIRMED')
        cp.receipts.push({requestId:receipt.requestId,from:op.from,to:op.to,name:op.name,count:op.count})
        cp.intent=null;cp.index++
        await saveCheckpoint(cp,onCheckpoint)
      }
      close()
      cp.phase='armor'
      await saveCheckpoint(cp,onCheckpoint)
      const equipped=await equipArmor({maxMoves:4})
      const view=current(cp.world,cp.life).view
      if(view.armor?.known!==true || !['diamond_helmet','diamond_chestplate','diamond_leggings','diamond_boots'].every((piece,i)=>view.armor.slots[i]?.name==='minecraft:'+piece))throw fail('LOADOUT_ARMOR_UNCONFIRMED')
      if(equipped?.some(x=>x.serverConfirmed!==true))throw fail('LOADOUT_ARMOR_UNCONFIRMED')
      cp.phase='completed';await saveCheckpoint(cp,onCheckpoint)
      return {status:'completed',serverConfirmed:true,checkpoint:copy(cp)}
    }catch(e){return {status:'blocked',reason:e.code??String(e.message??e),details:copy(e.details??null),serverConfirmed:false,checkpoint:copy(cp)}}
    finally{try{close()}catch{}busy=false}
  }
  async function depositAll (request,{onCheckpoint,signal}={}) {
    if(busy)throw fail('LOADOUT_BUSY')
    busy=true
    let cp=request?.checkpoint?copy(request.checkpoint):null
    try {
      signal?.throwIfAborted()
      const {s}=current()
      if(!cp){cp={version:1,direction:'deposit',operationId:request.operationId,jobId:request.jobId,world:worldKey(s),life:lifeKey(s),
        position:copy(request.position),phase:'deposit',index:0,intent:null,receipts:[],startedAt:now()};await saveCheckpoint(cp,onCheckpoint)}
      if(cp.version!==1||cp.direction!=='deposit'||cp.jobId!==request.jobId||cp.operationId!==request.operationId||pkey(cp.position)!==pkey(request.position))throw fail('FINAL_CHEST_CHECKPOINT_INVALID')
      current(cp.world,cp.life)
      await inStation(request)
      for(let i=0;i<128;i++){
        signal?.throwIfAborted()
        const view=current(cp.world,cp.life).view
        chestSlots(view,request.position)
        if(cp.intent) {
          if(await resync({signal})!==true)throw fail('FINAL_CHEST_RECONCILE_MAIN_UNCONFIRMED')
          await inStation(request)
          const source=getRawMain(cp.intent.from), dest=getRawChest(cp.intent.to),previous=unpack(cp.intent.beforeMain)
          const done=empty(source)&&dest.count===previous.count&&sameNbt(dest,previous)
          const unchanged=sameNbt(source,previous)&&empty(dest)
          if(!done&&!unchanged)throw fail('FINAL_CHEST_TRANSFER_AMBIGUOUS')
          if(done){cp.receipts.push({kind:'reconciled_deposit',name:cp.intent.name,count:cp.intent.count});cp.index++;cp.intent=null;await saveCheckpoint(cp,onCheckpoint);continue}
          cp.intent=null;await saveCheckpoint(cp,onCheckpoint)
        }
        const items=mainItems(current(cp.world,cp.life).view)
        const first=items.find(x=>known(x))
        if(first) {
          const spot=chestSlots(current().view,request.position).findIndex(x=>x.empty)
          if(spot<0)throw fail('FINAL_CHEST_FULL')
          const before=getRawMain(first.slot), dst=getRawChest(spot)
          if(!valid(before)||!empty(dst)||!Number.isInteger(first.count)||first.count<1||first.count>64)throw fail('FINAL_CHEST_INVENTORY_CHANGED')
          cp.intent={from:first.slot,to:spot,name:first.name,count:first.count,beforeMain:pack(before)}
          await saveCheckpoint(cp,onCheckpoint)
          const result=await deposit({sourceSlot:first.slot,chestSlot:spot,count:first.count,expectedName:first.name,signal})
          checkReceipt(result,{name:first.name,count:first.count,to:first.slot,from:spot})
          if(!empty(getRawMain(first.slot))||!sameNbt(getRawChest(spot),before))throw fail('FINAL_CHEST_TRANSFER_UNCONFIRMED')
          cp.receipts.push({kind:'deposit',requestId:result.requestId,name:first.name,count:first.count})
          cp.index++;cp.intent=null;await saveCheckpoint(cp,onCheckpoint)
          continue
        }
        close()
        const refreshed=current(cp.world,cp.life).view
        const armor=refreshed.armor?.slots?.find(x=>known(x))
        const hand=refreshed.offhand?.slots?.[0]
        const equip=armor?{kind:'armor',slot:armor.slot,name:armor.name}:known(hand)?{kind:'offhand',slot:0,name:hand.name}:null
        if(equip) {
          const emptySlot=mainItems(refreshed).find(x=>x.empty)
          if(!emptySlot)throw fail('FINAL_EQUIPMENT_TARGET_FULL')
          cp.equipmentIntent={...equip,targetSlot:emptySlot.slot}
          await saveCheckpoint(cp,onCheckpoint)
          const receipt=await equipmentTransfer({from:equip.kind,fromSlot:equip.slot,to:'main',toSlot:emptySlot.slot,expectedName:equip.name,signal})
          if(receipt?.serverConfirmed!==true)throw fail('FINAL_EQUIPMENT_UNCONFIRMED')
          cp.equipmentIntent=null;await saveCheckpoint(cp,onCheckpoint)
          await inStation(request)
          continue
        }
        if(!equipmentEmpty(refreshed)||!mainItems(refreshed).every(x=>x.empty))throw fail('FINAL_INVENTORY_UNCONFIRMED')
        cp.phase='completed';await saveCheckpoint(cp,onCheckpoint)
        return {status:'completed',serverConfirmed:true,checkpoint:copy(cp)}
      }
      throw fail('FINAL_CHEST_STEP_LIMIT')
    }catch(e){return {status:'blocked',reason:e.code??String(e.message??e),serverConfirmed:false,checkpoint:copy(cp)}}
    finally{try{close()}catch{}busy=false}
  }
  return { withdrawAll, depositAll, status:()=>({busy}) }
}
module.exports = { createQuarryV22ChestWork, buildStartupPlan }
