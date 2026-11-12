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
const connectionKey = s => JSON.stringify([s?.connectionId,s?.startedAt,String(s?.runtimeEntityId)])
const itemName = raw => typeof raw?.name === 'string' ? raw.name : null
const sameNbt = (a,b) => {
  if (!valid(a) || !valid(b) || a.network_id !== b.network_id || a.count !== b.count || a.metadata !== b.metadata || a.block_runtime_id !== b.block_runtime_id) return false
  return isDeepStrictEqual(a.extra, b.extra)
}
const known = s => s?.known === true && s.empty !== true && typeof s.name === 'string' && Number.isInteger(s.count) && s.count > 0
const armorSlot = name => ['diamond_helmet','diamond_chestplate','diamond_leggings','diamond_boots'].indexOf(clean(name))
const nbtKnown = raw => raw?.extra && (['false',false,0].includes(raw.extra.has_nbt) && raw.extra.nbt == null || ['true',true,65535].includes(raw.extra.has_nbt) && raw.extra.nbt != null)
function receivedTag (raw) {
  if (!nbtKnown(raw)) return null
  const extra=copy(raw.extra)
  if (['false',false,0].includes(extra.has_nbt)) { delete extra.has_nbt;delete extra.nbt;return {extra,tag:{type:'compound',name:'',value:{}}} }
  const tag=extra.nbt?.nbt??extra.nbt
  if(tag?.type!=='compound'||!tag.value||typeof tag.value!=='object'||Array.isArray(tag.value))return null
  delete extra.has_nbt;delete extra.nbt
  return {extra,tag:copy(tag)}
}
function receivedPrefixMatch (op,before,actual) {
  if(!valid(before)||!valid(actual)||before.network_id!==actual.network_id||before.metadata!==actual.metadata||before.block_runtime_id!==actual.block_runtime_id||before.count!==op.count)return null
  const a=receivedTag(before),b=receivedTag(actual)
  if(!a||!b)return null
  if(op.name==='minecraft:bread')return actual.count>0&&actual.count<=before.count&&isDeepStrictEqual(before.extra,actual.extra)?{damage:null}:null
  if(actual.count!==before.count)return null
  const wears=armorSlot(op.name)>=0||['minecraft:diamond_sword','minecraft:bow'].includes(op.name)
  if(!wears)return sameNbt(before,actual)?{damage:null}:null
  const damage=tag=>{
    if(!Object.hasOwn(tag.value,'Damage'))return 0
    const value=tag.value.Damage
    return value?.type==='int'&&Number.isSafeInteger(value.value)&&value.value>=0?value.value:null
  }
  const original=damage(a.tag),current=damage(b.tag)
  if(original===null||current===null||current<original)return null
  delete a.tag.value.Damage;delete b.tag.value.Damage
  return isDeepStrictEqual(a.extra,b.extra)&&isDeepStrictEqual(a.tag,b.tag)?{damage:current}:null
}
const validRequestId = id => Number.isSafeInteger(id) && id < 0 && id >= -2147483647 && Math.abs(id % 2) === 1
function equipmentAllocationAnchor(cp,proof,last) {
  let anchor=last?.requestId
  for(const audit of cp.equipmentRecoveries??[]) {
    if(audit.consumed!==true||audit.source!=='connection_request_allocator'||audit.operationId!==cp.operationId||audit.connection!==proof.connection||
      audit.scope!==proof.scope||audit.afterRequestId!==last.requestId)continue
    if((audit.afterAllocationId??audit.afterRequestId)!==anchor||!validRequestId(audit.reservedRequestId)||audit.reservedRequestId!==anchor-2)return null
    anchor=audit.reservedRequestId
  }
  return anchor
}

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
  withdraw, deposit, equipArmor, equipmentTransfer, resync = async()=>true, now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), getRawEquipment = null, proveEquipmentNotDispatched = null } = {}) {
  if ([getState,getView,getRawMain,getRawChest,open,close,withdraw,deposit,equipArmor,equipmentTransfer,resync,now,sleep].some(fn=>typeof fn!=='function')) throw new TypeError('V22 chest work requires observed 54-slot and equipment ports')
  if(getRawEquipment!==null&&typeof getRawEquipment!=='function')throw new TypeError('Equipment observations must be a function')
  if(proveEquipmentNotDispatched!==null&&typeof proveEquipmentNotDispatched!=='function')throw new TypeError('Unsent equipment proof must be a function')
  let busy=false
  const current = (expectedWorld=null,expectedLife=null,{allowUncertain=false}={}) => {
    const s=getState(), view=getView()
    if(s?.phase!=='spawned'||s.dead||s.isDead||s.lifecycle?.dead||!(s.health>0)||!s.inventory||(!allowUncertain&&(view?.known!==true||s.inventory.known!==true||s.inventory.uncertain))) throw fail('LOADOUT_INVENTORY_UNKNOWN')
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
  const equipmentRaw = (view,kind,slot) => {
    const section=kind==='armor'?view.armor:view.offhand
    if(section?.known!==true||section.slots?.[slot]?.known!==true||!getRawEquipment)return null
    const raw=getRawEquipment(kind,slot)
    return valid(raw)?raw:null
  }
  async function waitEquipment(verify,ready,reason) {
    for(let waited=0;;waited+=100){
      const frame=verify()
      if(ready(frame.view))return frame.view
      if(waited>=5000)throw fail(reason)
      await sleep(100)
    }
  }
  async function observeEquipment(cp,{signal,connection,ready,reason}) {
    const verify=(allowUncertain=false)=>{
      signal?.throwIfAborted()
      const frame=current(cp.world,cp.life,{allowUncertain})
      if(connectionKey(frame.s)!==connection)throw fail('LOADOUT_CONNECTION_CHANGED')
      return frame
    }
    if(ready(verify().view))return verify().view
    close();let refreshed
    try{refreshed=await resync({signal})}catch(error){
      if(error.code!=='RESYNC_RATE_LIMIT')throw error
      for(let waited=0;waited<20000;waited+=100){verify(true);await sleep(100)}
      verify(true);refreshed=await resync({signal})
    }
    verify(true)
    if(refreshed!==true)throw fail(reason)
    return waitEquipment(verify,ready,reason)
  }
  function prefixItem(op,view) {
    const main=getRawMain(op.to),descriptor=view.slots?.[op.to]
    if(!valid(main)||descriptor?.known!==true)throw fail('LOADOUT_PREFIX_UNKNOWN')
    if(!empty(main))return {raw:main,descriptor}
    const slot=armorSlot(op.name)
    if(slot<0)throw fail('LOADOUT_PREFIX_CHANGED')
    const raw=equipmentRaw(view,'armor',slot)
    if(!raw)throw fail('LOADOUT_PREFIX_UNKNOWN')
    return {raw,descriptor:view.armor.slots[slot]}
  }
  function prefixManifestMatches(op,raw,descriptor) {
    if(!known(descriptor)||descriptor.name!==op.name||descriptor.count!==op.count||raw.count!==op.count||descriptor.enchantmentsKnown!==true||!nbtKnown(raw))return false
    if(op.name==='minecraft:bow'&&!(descriptor.enchantmentsKnown===true&&descriptor.enchantments?.some(x=>clean(x.name)==='infinity'&&x.level>=1)))return false
    if(isShulkerBox(op.name)) {
      const slots=descriptor.container?.slots
      if(descriptor.container?.known!==true||slots?.length!==27)return false
      if(op.name==='minecraft:purple_shulker_box')return slots.every(x=>x==null||x.empty===true||x.count===0)
      const role=Object.values(roles).find(x=>x.box===op.name)
      if(!role||!slots.every(x=>known(x)&&x.count===role.each&&(role.item instanceof RegExp?role.item.test(x.name):x.name===role.item)))return false
    }
    return true
  }
  async function verifyPrefix(cp,onCheckpoint,request,signal) {
    if(request.allowReceivedPrefixUse===true)return verifyReceivedPrefix(cp,onCheckpoint,request,signal)
    let frame=current(cp.world,cp.life),view=frame.view
    const connection=connectionKey(frame.s)
    const wornSlots=cp.plan.slice(0,cp.index).filter(op=>armorSlot(op.name)>=0&&empty(getRawMain(op.to))).map(op=>armorSlot(op.name))
    if(wornSlots.some(slot=>!equipmentRaw(view,'armor',slot))){
      await observeEquipment(cp,{signal,connection,reason:'LOADOUT_PREFIX_UNKNOWN',ready:received=>wornSlots.every(slot=>!!equipmentRaw(received,'armor',slot))})
      await inStation(request)
      signal?.throwIfAborted();frame=current(cp.world,cp.life)
      if(connectionKey(frame.s)!==connection)throw fail('LOADOUT_CONNECTION_CHANGED')
      view=frame.view
    }
    let changed=false
    cp.identities??=[]
    for(let index=0;index<cp.index;index++) {
      const op=cp.plan[index],actual=prefixItem(op,view),saved=cp.identities[index]
      if(!prefixManifestMatches(op,actual.raw,actual.descriptor)||saved&&!sameNbt(actual.raw,unpack(saved)))throw fail('LOADOUT_PREFIX_CHANGED')
      // Old checkpoints did not retain completed stack NBT. Migrate only from
      // current received stacks that still satisfy the original kit manifest.
      if(!saved){cp.identities[index]=pack(actual.raw);changed=true}
    }
    if(changed){cp.prefixIdentitySource='received_manifest_migration';await saveCheckpoint(cp,onCheckpoint)}
  }
  async function verifyReceivedPrefix(cp,onCheckpoint,request,signal) {
    const connection=connectionKey(current(cp.world,cp.life).s)
    const verify=()=>{
      signal?.throwIfAborted()
      const frame=current(cp.world,cp.life)
      if(connectionKey(frame.s)!==connection)throw fail('LOADOUT_CONNECTION_CHANGED')
      return frame
    }
    if(!Array.isArray(cp.receipts)||cp.receipts.length!==cp.index||!Array.isArray(cp.identities))throw fail('LOADOUT_PREFIX_UNKNOWN')
    const expected=cp.plan.slice(0,cp.index).map((op,index)=>{
      if(['from','to','name','count'].some(field=>cp.receipts[index]?.[field]!==op[field])||typeof cp.identities[index]!=='string')throw fail('LOADOUT_PREFIX_CHANGED')
      let raw;try{raw=unpack(cp.identities[index])}catch{throw fail('LOADOUT_PREFIX_UNKNOWN')}
      if(!valid(raw)||!receivedTag(raw))throw fail('LOADOUT_PREFIX_UNKNOWN')
      return {op,index,raw}
    })
    const previous=cp.prefixUseObservations??[]
    if(!Array.isArray(previous)||previous.some(entry=>!Number.isInteger(entry?.index)||entry.index<0||entry.index>=cp.index||entry.connection!==connection||
      !['main','armor'].includes(entry.location)||!Number.isInteger(entry.slot)||entry.slot<0||entry.slot>=(entry.location==='main'?36:4)||
      !Number.isInteger(entry.count)||entry.count<1||entry.damage!=null&&(!Number.isSafeInteger(entry.damage)||entry.damage<0))||new Set(previous.map(entry=>entry.index)).size!==previous.length)throw fail('LOADOUT_PREFIX_UNKNOWN')
    const candidates=()=>{
      const {view}=verify(),main=mainItems(view)
      if(!main||main.some(row=>row?.known!==true))throw fail('LOADOUT_PREFIX_UNKNOWN')
      const rows=main.map((descriptor,slot)=>({location:'main',slot,descriptor,raw:getRawMain(slot)}))
      if(rows.some(row=>!valid(row.raw)))throw fail('LOADOUT_PREFIX_UNKNOWN')
      for(let slot=0;slot<4;slot++){
        const raw=equipmentRaw(view,'armor',slot)
        if(raw)rows.push({location:'armor',slot,descriptor:view.armor.slots[slot],raw})
      }
      return rows.filter(row=>!empty(row.raw))
    }
    let rows=candidates()
    const missingArmor=expected.filter(({op,raw})=>armorSlot(op.name)>=0&&!rows.some(row=>row.location==='main'&&receivedPrefixMatch(op,raw,row.raw))&&
      !equipmentRaw(verify().view,'armor',armorSlot(op.name))).map(({op})=>armorSlot(op.name))
    if(missingArmor.length){
      await observeEquipment(cp,{signal,connection,reason:'LOADOUT_PREFIX_UNKNOWN',ready:view=>missingArmor.every(slot=>!!equipmentRaw(view,'armor',slot))})
      await inStation(request);verify();rows=candidates()
    }
    const used=new Set(),usedIds=new Set(),observed=[],audits=new Map(previous.map(entry=>[entry.index,copy(entry)]))
    for(const {op,index,raw}of expected){
      const prior=audits.get(index),ordered=[...rows].sort((a,b)=>(a.location==='main'&&a.slot===op.to?-1:0)-(b.location==='main'&&b.slot===op.to?-1:0))
      let match=null,usage=null
      for(const row of ordered){
        const key=row.location+':'+row.slot
        if(used.has(key)||usedIds.has(row.raw.stack_id)||row.location==='armor'&&row.slot!==armorSlot(op.name))continue
        const state=receivedPrefixMatch(op,raw,row.raw)
        if(!state||prior?.damage!=null&&(state.damage===null||state.damage<prior.damage)||!prefixManifestMatches({...op,count:row.raw.count},row.raw,row.descriptor))continue
        match=row;usage=state;break
      }
      if(!match)throw fail('LOADOUT_PREFIX_CHANGED')
      used.add(match.location+':'+match.slot);usedIds.add(match.raw.stack_id);observed.push({...match,op})
      const originalDamage=receivedPrefixMatch(op,raw,raw)?.damage
      if(prior||match.location!=='main'||match.slot!==op.to||match.raw.count!==op.count||usage.damage!==originalDamage){
        audits.set(index,{index,location:match.location,slot:match.slot,count:match.raw.count,damage:usage.damage,connection})
      }
    }
    const next=[...audits.values()].sort((a,b)=>a.index-b.index)
    if(!isDeepStrictEqual(previous,next)){
      cp.prefixUseObservations=next
      await saveCheckpoint(cp,onCheckpoint)
    }
    const {view}=verify()
    for(const row of observed){
      const actual=row.location==='main'?getRawMain(row.slot):equipmentRaw(view,'armor',row.slot)
      const descriptor=row.location==='main'?view.slots?.[row.slot]:view.armor?.slots?.[row.slot]
      if(!isDeepStrictEqual(actual,row.raw)||!prefixManifestMatches({...row.op,count:row.raw.count},actual,descriptor))throw fail('LOADOUT_PREFIX_CHANGED')
    }
  }
  async function reconcileWithdrawal(cp,op,request,signal) {
    signal?.throwIfAborted()
    const connection=connectionKey(current(cp.world,cp.life,{allowUncertain:true}).s)
    const verify=(allowUncertain=false)=>{
      const frame=current(cp.world,cp.life,{allowUncertain})
      if(connectionKey(frame.s)!==connection)throw fail('LOADOUT_CONNECTION_CHANGED')
      return frame
    }
    close()
    let refreshed
    try { refreshed=await resync({signal}) } catch(error) {
      if(error.code!=='RESYNC_RATE_LIMIT')throw error
      // The shared server refresh has a 20-second cooldown. Respect it with
      // one bounded retry; keep checking the recorded life while waiting.
      for(let waited=0;waited<20000;waited+=100) {
        signal?.throwIfAborted()
        verify(true)
        await sleep(100)
      }
      signal?.throwIfAborted()
      verify(true)
      refreshed=await resync({signal})
    }
    if(refreshed!==true)throw fail('LOADOUT_RECONCILE_MAIN_UNCONFIRMED')
    signal?.throwIfAborted()
    verify()
    await inStation(request)
    verify()
    const main=getRawMain(op.to),box=getRawChest(op.from),beforeBox=unpack(cp.intent.beforeBox)
    if(!valid(main)||!valid(box)||!valid(beforeBox))throw fail('LOADOUT_RECONCILE_RECEIPT_UNKNOWN')
    // ACK counts alone never supply item/NBT data. A fresh full main view and
    // a newly opened chest must agree on the exact previously recorded stack.
    const slot=armorSlot(op.name)
    if(slot>=0&&empty(main)&&empty(box))await waitEquipment(()=>verify(),view=>!!equipmentRaw(view,'armor',slot),'LOADOUT_RECONCILE_EQUIPMENT_UNKNOWN')
    const worn=slot<0?null:equipmentRaw(current(cp.world,cp.life).view,'armor',slot)
    const equipped=empty(main)&&worn&&sameNbt(worn,beforeBox)
    const done=empty(box)&&(main.count===op.count&&sameNbt(main,beforeBox)||equipped)
    const unchanged=empty(main)&&sameNbt(box,beforeBox)
    if(!done&&!unchanged)throw fail('LOADOUT_TRANSFER_AMBIGUOUS')
    return done
  }
  async function withdrawAll (request,{onCheckpoint,signal}={}) {
    if(busy)throw fail('LOADOUT_BUSY')
    busy=true
    let cp=request?.checkpoint?copy(request.checkpoint):null
    try {
      signal?.throwIfAborted()
      // A sent, journaled request may make the ordinary inventory uncertain.
      // Only its read-only reconciliation may run until fresh receipts arrive.
      const {s,view}=current(cp?.world??null,cp?.life??null,{allowUncertain:!!cp?.intent})
      if(!cp) {
        if(!mainItems(view).every(slot=>slot.empty)||!equipmentEmpty(view))throw fail('START_INVENTORY_NOT_EMPTY')
        const slots=await inStation(request)
        const validation=validateV22Loadout({known:true,slots})
        if(!validation.ready) {
          const error=fail('LOADOUT_MISSING')
          error.details=validation.errors;throw error
        }
        const plan=buildStartupPlan(slots)
        cp={version:1,direction:'withdraw',operationId:request.operationId,jobId:request.jobId,world:worldKey(s),life:lifeKey(s),
          position:copy(request.position), phase:'withdraw',index:0,plan,identities:plan.map(op=>pack(getRawChest(op.from))),intent:null,receipts:[],startedAt:now()}
        await saveCheckpoint(cp,onCheckpoint)
      }
      if(cp.version!==1||cp.direction!=='withdraw'||cp.jobId!==request.jobId||cp.operationId!==request.operationId||pkey(cp.position)!==pkey(request.position)||!Array.isArray(cp.plan)||cp.plan.length!==34||!Number.isInteger(cp.index)||cp.index<0||cp.index>34)throw fail('LOADOUT_CHECKPOINT_INVALID')
      current(cp.world,cp.life,{allowUncertain:!!cp.intent})
      if(!cp.intent){await inStation(request);await verifyPrefix(cp,onCheckpoint,request,signal)}
      for(;cp.index<cp.plan.length;) {
        signal?.throwIfAborted()
        const op=cp.plan[cp.index]
        if(cp.intent) {
          if(cp.intent.index!==cp.index)throw fail('LOADOUT_CHECKPOINT_INVALID')
          // A crash between dispatch and checkpoint may only be resolved from
          // both received sides. Ambiguous changes remain paused.
          const done=await reconcileWithdrawal(cp,op,request,signal)
          await verifyPrefix(cp,onCheckpoint,request,signal)
          if(done){cp.identities??=[];cp.identities[cp.index]=cp.intent.beforeBox;cp.receipts.push({kind:'reconciled_withdraw',from:op.from,to:op.to,name:op.name,count:op.count});cp.index++;cp.intent=null;await verifyPrefix(cp,onCheckpoint,request,signal);await saveCheckpoint(cp,onCheckpoint);continue}
          cp.intent=null;await saveCheckpoint(cp,onCheckpoint)
          await verifyPrefix(cp,onCheckpoint,request,signal)
        }
        // Reconciliation can replace cached descriptors and stack IDs.
        const main=getRawMain(op.to),box=getRawChest(op.from)
        if(!valid(main)||!valid(box))throw fail('LOADOUT_RECEIPT_UNKNOWN')
        if(!empty(main)||empty(box))throw fail('LOADOUT_SOURCE_CHANGED')
        cp.identities??=[];cp.identities[cp.index]=pack(box)
        cp.intent={index:cp.index,beforeMain:pack(main),beforeBox:pack(box)}
        await saveCheckpoint(cp,onCheckpoint)
        let receipt
        try {
          receipt=await withdraw({chestSlot:op.from,targetSlot:op.to,count:op.count,expectedName:op.name,signal})
        } catch(error) {
          signal?.throwIfAborted()
          // A timeout may follow a transfer that really applied. Refresh both
          // sides once, never reissue this failed dispatch in the same call.
          if(!await reconcileWithdrawal(cp,op,request,signal))throw error
          await verifyPrefix(cp,onCheckpoint,request,signal)
          cp.receipts.push({kind:'reconciled_withdraw',from:op.from,to:op.to,name:op.name,count:op.count})
          cp.identities??=[];cp.identities[cp.index]=cp.intent.beforeBox;cp.intent=null;cp.index++
          await verifyPrefix(cp,onCheckpoint,request,signal)
          await saveCheckpoint(cp,onCheckpoint)
          continue
        }
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
      signal?.throwIfAborted()
      const armorConnection=connectionKey(current(cp.world,cp.life).s)
      const equipped=await equipArmor({maxMoves:4})
      const equippedView=current(cp.world,cp.life).view
      if(equippedView.armor?.known!==true || !['diamond_helmet','diamond_chestplate','diamond_leggings','diamond_boots'].every((piece,i)=>equippedView.armor.slots[i]?.name==='minecraft:'+piece))throw fail('LOADOUT_ARMOR_UNCONFIRMED')
      if(equipped?.some(x=>x.serverConfirmed!==true))throw fail('LOADOUT_ARMOR_UNCONFIRMED')
      await observeEquipment(cp,{signal,connection:armorConnection,reason:'LOADOUT_ARMOR_RECEIPT_UNKNOWN',ready:view=>{
        for(let slot=0;slot<4;slot++){
          const raw=equipmentRaw(view,'armor',slot)
          if(!raw)return false
          const index=cp.plan.findIndex(op=>armorSlot(op.name)===slot),saved=cp.identities?.[index]
          if(!saved||!(request.allowReceivedPrefixUse===true?receivedPrefixMatch(cp.plan[index],unpack(saved),raw):sameNbt(raw,unpack(saved))))throw fail('LOADOUT_ARMOR_UNCONFIRMED')
        }
        return true
      }})
      await verifyPrefix(cp,onCheckpoint,request,signal)
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
      const pending=!!(cp?.intent||cp?.equipmentIntent)
      const {s}=current(cp?.world??null,cp?.life??null,{allowUncertain:pending})
      const connection=connectionKey(s)
      if(!cp){cp={version:1,direction:'deposit',operationId:request.operationId,jobId:request.jobId,world:worldKey(s),life:lifeKey(s),
        position:copy(request.position),phase:'deposit',index:0,intent:null,receipts:[],startedAt:now()};await saveCheckpoint(cp,onCheckpoint)}
      if(cp.version!==1||cp.direction!=='deposit'||cp.jobId!==request.jobId||cp.operationId!==request.operationId||pkey(cp.position)!==pkey(request.position))throw fail('FINAL_CHEST_CHECKPOINT_INVALID')
      if(cp.intent&&cp.equipmentIntent)throw fail('FINAL_CHEST_CHECKPOINT_INVALID')
      const verify=(allowUncertain=false)=>{
        signal?.throwIfAborted()
        const frame=current(cp.world,cp.life,{allowUncertain})
        if(connectionKey(frame.s)!==connection)throw fail('LOADOUT_CONNECTION_CHANGED')
        return frame
      }
      const refresh=async reason=>{
        verify(true);close()
        let refreshed
        try{refreshed=await resync({signal})}catch(error){
          if(error.code!=='RESYNC_RATE_LIMIT')throw error
          for(let waited=0;waited<20000;waited+=100){verify(true);await sleep(100)}
          verify(true);refreshed=await resync({signal})
        }
        verify(true)
        if(refreshed!==true)throw fail(reason)
        return verify().view
      }
      verify(pending)
      if(!pending){await inStation(request);verify()}
      for(let i=0;i<128;i++){
        signal?.throwIfAborted()
        if(cp.equipmentIntent) {
          let receipt=await refresh('FINAL_EQUIPMENT_RECONCILE_UNCONFIRMED')
          const intent=cp.equipmentIntent
          if(!['armor','offhand'].includes(intent.kind)||!Number.isInteger(intent.slot)||intent.slot<0||intent.slot>=(intent.kind==='armor'?4:1)||!Number.isInteger(intent.targetSlot)||intent.targetSlot<0||intent.targetSlot>=36||typeof intent.beforeEquipment!=='string'||typeof intent.beforeMain!=='string')throw fail('FINAL_EQUIPMENT_RECONCILE_UNKNOWN')
          receipt=await waitEquipment(()=>verify(),view=>!!equipmentRaw(view,intent.kind,intent.slot),'FINAL_EQUIPMENT_RECONCILE_UNKNOWN')
          const source=equipmentRaw(receipt,intent.kind,intent.slot),destination=getRawMain(intent.targetSlot)
          const before=unpack(intent.beforeEquipment),beforeMain=unpack(intent.beforeMain)
          if(!valid(source)||!valid(destination)||!valid(before)||!empty(beforeMain)||before.count!==1||!nbtKnown(before)||receipt.slots?.[intent.targetSlot]?.known!==true)throw fail('FINAL_EQUIPMENT_RECONCILE_UNKNOWN')
          const applied=empty(source)&&sameNbt(destination,before)
          const unchanged=sameNbt(source,before)&&empty(destination)
          if(!applied&&!unchanged)throw fail('FINAL_EQUIPMENT_TRANSFER_AMBIGUOUS')
          if(unchanged) {
            const last=cp.receipts.at(-1),proof=await proveEquipmentNotDispatched?.(copy(cp))
            verify()
            if(!proof||proof.source!=='connection_request_allocator'||proof.operationId!==cp.operationId||proof.connection!==connection||
              last?.kind!=='deposit'||!validRequestId(last.requestId)||proof.afterRequestId!==last.requestId||
              (proof.afterAllocationId??proof.afterRequestId)!==equipmentAllocationAnchor(cp,proof,last)||!validRequestId(proof.reservedRequestId)||
              proof.reservedRequestId!==(proof.afterAllocationId??proof.afterRequestId)-2)throw fail('FINAL_EQUIPMENT_TRANSFER_PENDING')
            // A reservation is evidence of no dispatch, never a transfer receipt.
            // Recheck both observed sides and retain the original intent in audit.
            if(!sameNbt(equipmentRaw(verify().view,intent.kind,intent.slot),before)||!empty(getRawMain(intent.targetSlot)))throw fail('FINAL_EQUIPMENT_TRANSFER_AMBIGUOUS')
            cp.equipmentRecoveries??=[]
            let audit={...copy(proof),intent:copy(intent),consumed:false}
            const saved=cp.equipmentRecoveries.find(entry=>isDeepStrictEqual(entry,audit))
            if(saved)audit=saved
            else cp.equipmentRecoveries.push(audit)
            await saveCheckpoint(cp,onCheckpoint)
            verify()
            if(!sameNbt(equipmentRaw(verify().view,intent.kind,intent.slot),before)||!empty(getRawMain(intent.targetSlot)))throw fail('FINAL_EQUIPMENT_TRANSFER_AMBIGUOUS')
            // Consume this proof with the intent-clear checkpoint, before a
            // retry could create an identical but already-dispatched intent.
            audit.consumed=true
          } else cp.receipts.push({kind:'reconciled_equipment',from:intent.kind,fromSlot:intent.slot,to:intent.targetSlot,name:intent.name,count:1,identity:intent.beforeEquipment})
          cp.equipmentIntent=null
          await saveCheckpoint(cp,onCheckpoint)
          await inStation(request);verify()
          continue
        }
        if(cp.intent) {
          await refresh('FINAL_CHEST_RECONCILE_MAIN_UNCONFIRMED')
          await inStation(request);verify()
          if(!Number.isInteger(cp.intent.from)||cp.intent.from<0||cp.intent.from>=36||!Number.isInteger(cp.intent.to)||cp.intent.to<0||cp.intent.to>=54||typeof cp.intent.beforeMain!=='string')throw fail('FINAL_CHEST_CHECKPOINT_INVALID')
          const source=getRawMain(cp.intent.from), dest=getRawChest(cp.intent.to),previous=unpack(cp.intent.beforeMain)
          if(!valid(source)||!valid(dest)||!valid(previous)||empty(previous)||!nbtKnown(previous))throw fail('FINAL_CHEST_RECONCILE_RECEIPT_UNKNOWN')
          const done=empty(source)&&dest.count===previous.count&&sameNbt(dest,previous)
          const unchanged=sameNbt(source,previous)&&empty(dest)
          if(!done&&!unchanged)throw fail('FINAL_CHEST_TRANSFER_AMBIGUOUS')
          if(done){cp.receipts.push({kind:'reconciled_deposit',name:cp.intent.name,count:cp.intent.count});cp.index++;cp.intent=null;await saveCheckpoint(cp,onCheckpoint);continue}
          throw fail('FINAL_CHEST_TRANSFER_PENDING')
        }
        const view=verify().view
        chestSlots(view,request.position)
        const items=mainItems(view)
        const first=items.find(x=>known(x))
        if(first) {
          const spot=chestSlots(current().view,request.position).findIndex(x=>x.empty)
          if(spot<0)throw fail('FINAL_CHEST_FULL')
          const before=getRawMain(first.slot), dst=getRawChest(spot)
          if(!valid(before)||!empty(dst)||!Number.isInteger(first.count)||first.count<1||first.count>64)throw fail('FINAL_CHEST_INVENTORY_CHANGED')
          cp.intent={from:first.slot,to:spot,name:first.name,count:first.count,beforeMain:pack(before)}
          await saveCheckpoint(cp,onCheckpoint)
          const result=await deposit({sourceSlot:first.slot,chestSlot:spot,count:first.count,expectedName:first.name,signal})
          verify()
          checkReceipt(result,{name:first.name,count:first.count,to:first.slot,from:spot})
          if(!empty(getRawMain(first.slot))||!sameNbt(getRawChest(spot),before))throw fail('FINAL_CHEST_TRANSFER_UNCONFIRMED')
          cp.receipts.push({kind:'deposit',requestId:result.requestId,name:first.name,count:first.count})
          cp.index++;cp.intent=null;await saveCheckpoint(cp,onCheckpoint)
          continue
        }
        close()
        const refreshed=verify().view
        const armor=refreshed.armor?.slots?.find(x=>known(x))
        const hand=refreshed.offhand?.slots?.[0]
        const equip=armor?{kind:'armor',slot:armor.slot,name:armor.name}:known(hand)?{kind:'offhand',slot:0,name:hand.name}:null
        if(equip) {
          const emptySlot=mainItems(refreshed).find(x=>x.empty)
          if(!emptySlot)throw fail('FINAL_EQUIPMENT_TARGET_FULL')
          const observed=await observeEquipment(cp,{signal,connection,reason:'FINAL_EQUIPMENT_IDENTITY_UNKNOWN',ready:view=>{
            const raw=equipmentRaw(view,equip.kind,equip.slot)
            if(!raw)return false
            const descriptor=equip.kind==='armor'?view.armor.slots[equip.slot]:view.offhand.slots[0]
            if(descriptor.name!==equip.name||raw.count!==1||!nbtKnown(raw))throw fail('FINAL_EQUIPMENT_IDENTITY_UNKNOWN')
            return true
          }})
          const before=equipmentRaw(observed,equip.kind,equip.slot),beforeMain=getRawMain(emptySlot.slot)
          if(!valid(before)||before.count!==1||!nbtKnown(before)||!empty(beforeMain))throw fail('FINAL_EQUIPMENT_IDENTITY_UNKNOWN')
          cp.equipmentIntent={...equip,targetSlot:emptySlot.slot,beforeEquipment:pack(before),beforeMain:pack(beforeMain)}
          await saveCheckpoint(cp,onCheckpoint)
          const receipt=await equipmentTransfer({from:equip.kind,fromSlot:equip.slot,to:'main',toSlot:emptySlot.slot,expectedName:equip.name,signal})
          verify()
          if(receipt?.serverConfirmed!==true)throw fail('FINAL_EQUIPMENT_UNCONFIRMED')
          await observeEquipment(cp,{signal,connection,reason:'FINAL_EQUIPMENT_UNCONFIRMED',ready:view=>!!equipmentRaw(view,equip.kind,equip.slot)})
          if(!empty(equipmentRaw(verify().view,equip.kind,equip.slot))||!sameNbt(getRawMain(emptySlot.slot),before))throw fail('FINAL_EQUIPMENT_UNCONFIRMED')
          cp.equipmentIntent=null;await saveCheckpoint(cp,onCheckpoint)
          await inStation(request);verify()
          continue
        }
        if(!equipmentEmpty(refreshed)||!mainItems(refreshed).every(x=>x.empty))throw fail('FINAL_INVENTORY_UNCONFIRMED')
        await observeEquipment(cp,{signal,connection,reason:'FINAL_INVENTORY_UNCONFIRMED',ready:view=>{
          for(const [kind,size] of [['armor',4],['offhand',1]])for(let slot=0;slot<size;slot++){
            const raw=equipmentRaw(view,kind,slot)
            if(!raw)return false
            if(!empty(raw))throw fail('FINAL_INVENTORY_UNCONFIRMED')
          }
          return true
        }})
        if(!equipmentEmpty(verify().view)||!mainItems(verify().view).every(x=>x.empty))throw fail('FINAL_INVENTORY_UNCONFIRMED')
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
