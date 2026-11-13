'use strict'
const { FAILURE_PROBE } = require('./loadout-command')

// Explicit operator debug reset: clear the Bot, then prepare a double chest.
// Game play (excavation, storage, combat, return) never calls this controller.
// A fresh destructive confirmation is required. Empty inventory/equipment and
// the temporary enchanted bow are verified from actual server observations.
const { randomUUID, createHash } = require('node:crypto')
const { observedScope } = require('./server-position-verifier')
const { findDebugChestSite, debugSiteReachable } = require('./quarry-debug-site')
const { normalizeChunkArea, areaContainsFeet, chunkAreaKey } = require('./chunk-area')
const { CARGO, roles, singles, validateV22Loadout } = require('./quarry-v22-loadout')
const fail = (code, details = null) => Object.assign(new Error(code), {code, ...(details ? {details}: {})})
const copy = v => structuredClone(v)
const at = p => p.x+' '+p.y+' '+p.z
const key = p => p.x+','+p.y+','+p.z
const worldOf = s => JSON.stringify([s.profile,String(s.realm?.id),s.dimension])
const stamp = o => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const isAir = block => block?.known === true && /^minecraft:(?:air|cave_air|void_air)$/.test(block.name) && !block.extra?.length && !block.protected && !block.protectionSource
const isFloor = b => b?.known === true && b.boundingBox === 'block' && !b.extra?.length && !b.protected && !b.protectionSource && !/water|lava|magma|fire|powder_snow|scaffolding|cactus/.test(b.name??'')
const same = (a,b) => a && b && key(a)===key(b)
const known = item => item?.known === true && !item.empty && typeof item.name === 'string' && item.count > 0
const mainView = view => view?.known===true && view.uncertain!==true && Array.isArray(view.slots) && view.slots.length===36 && view.slots.every(x=>x?.known===true)
const fullView = view => mainView(view) && view.armor?.known===true && view.armor.slots?.length===4 &&
  view.armor.slots.every(x=>x?.known===true) && view.offhand?.known===true && view.offhand.slots?.[0]?.known===true
const emptySlot = row => row?.known===true && row.empty===true && row.count===0
const emptyBot = v => fullView(v) && v.slots.every(emptySlot) && v.armor.slots.every(emptySlot) && emptySlot(v.offhand.slots[0])
const vec = p => p && ['x','y','z'].every(n=>Number.isSafeInteger(p[n])&&Math.abs(p[n])<30000000)
const ROLE_ORDER = ['pickaxe','shovel','dirt','totem']
const CARGO_NAME = 'minecraft:purple_shulker_box'
function summary () {
  return {
    version:'quarry-v22-surface-double-chest',cargoBoxes:CARGO,
    tools:[{name:'minecraft:diamond_sword',enchants:{}},{name:'minecraft:bow',enchants:{infinity:1}}],
    armor:['helmet','chestplate','leggings','boots'].map(x=>({name:'minecraft:diamond_'+x,enchants:{}})),
    supplies: ROLE_ORDER.map(role=>({role,name:roles[role].box,item:{name:role==='shovel'?'minecraft:diamond_shovel':roles[role].item,enchants:{}},slots:27,total:27*roles[role].each})),
    hand:{bread:64,dirt:0,arrows:64}
  }
}
function createQuarryV22Reset ({ adapter, commands, now = Date.now, sleep = ms => new Promise(r=>setTimeout(r,ms)),
  observationTimeoutMs = 8000, uuid = randomUUID, feedbackToggle = false } = {}) {
  const required=['getState','getView','getBlock','assertIdle','acquire','release','cancelJob','save','load','select','open','close','deposit','container','cancelTransfers']
  if(required.some(k=>typeof adapter?.[k]!=='function')||typeof commands?.send!=='function')throw TypeError('V22 reset requires receipt-backed server ports')
  let preview=null,active=null,task=null,result=null,lastError=null,abort=null,acquisition=null
  const jobIdentity = () => adapter.jobIdentity?.() ?? null
  const sameIdentity = (a,b) => a===undefined||b===undefined ? a===b : stamp(a)===stamp(b)
  const fingerprint = view => stamp({slots:view.slots,armor:view.armor,offhand:view.offhand})
  function scene () {
    const s=adapter.getState(), scope=observedScope(s)
    if(!scope||s.phase!=='spawned'||s.dead||s.isDead||!(s.health>0)||s.dimension!=='overworld'||!['survival',0].includes(s.gameMode)||!s.position)throw fail('RESET_NOT_READY')
    const feet={x:Math.floor(s.position.x),y:Math.floor(s.position.y-1.62+0.001),z:Math.floor(s.position.z)}
    if(!vec(feet)||!isAir(adapter.getBlock(feet.x,feet.y,feet.z))||!isAir(adapter.getBlock(feet.x,feet.y+1,feet.z))||!isFloor(adapter.getBlock(feet.x,feet.y-1,feet.z)))throw fail('RESET_UNSAFE_STANCE')
    const view=adapter.getView()
    if(!mainView(view)||s.inventory?.uncertain)throw fail('RESET_INVENTORY_UNKNOWN')
    return {s,scope,feet,view}
  }
  function site ({feet,s},registered=null) {
    if(registered && registered.position && registered.other && registered.stage && registered.stand) {
      if(!vec(registered.position)||!vec(registered.other)||!vec(registered.stage)||!same(registered.stand,feet))throw fail('RESET_SITE_REACHABILITY_CHANGED')
      if(!debugSiteReachable(registered,s.position))throw fail('RESET_SITE_REACHABILITY_CHANGED')
      const both=[registered.position,registered.other].every(p=>{const block=adapter.getBlock(p.x,p.y,p.z);return block?.known===true&&block.name==='minecraft:chest'&&!block.extra?.length})
      if(!both)throw fail('RESET_REGISTERED_CHEST_CHANGED')
      if(!isAir(adapter.getBlock(registered.stage.x,registered.stage.y,registered.stage.z))||
        ![registered.position,registered.other,registered.stage].every(p=>isFloor(adapter.getBlock(p.x,p.y-1,p.z))&&isAir(adapter.getBlock(p.x,p.y+1,p.z))))throw fail('RESET_STAGING_UNSAFE')
      return {...copy(registered),existing:true}
    }
    const selected=findDebugChestSite({feet,position:s.position,getBlock:adapter.getBlock,isAir,isFloor})
    if(selected)return selected
    throw fail('RESET_CHEST_SITE_UNAVAILABLE')
  }
  const siteIdentity = p => stamp({position:p.position,other:p.other,stage:p.stage,stand:p.stand})
  function selectedSite (frame, home, area) {
    if(!area)return
    if(!areaContainsFeet(area,{x:frame.s.position.x,y:frame.feet.y,z:frame.s.position.z}))throw fail('RESET_OUTSIDE_SELECTED_CHUNKS')
    if(home&&![home.position,home.other,home.stage,home.stand].every(p=>areaContainsFeet(area,{x:p.x+0.5,y:p.y,z:p.z+0.5})))throw fail('RESET_SITE_OUTSIDE_SELECTED_CHUNKS')
  }
  async function confirmSelected (area, scope, signal) {
    if(!area)return
    const receipt=await adapter.confirmArea?.(copy(area),{signal})
    if(receipt?.serverConfirmed!==true||receipt.scope!==scope)throw fail('RESET_POSITION_UNCONFIRMED')
  }
  async function prepare (options={}) {
    if(task)throw fail('RESET_BUSY')
    adapter.assertIdle()
    const snap=scene()
    const generation=adapter.generation?.()??0,job=copy(jobIdentity())
    const selectedArea=options?.area==null?null:normalizeChunkArea(options.area)
    selectedSite(snap,null,selectedArea)
    await confirmSelected(selectedArea,snap.scope)
    const prior=await adapter.load()
    if(prior && prior.world===worldOf(snap.s) && prior.phase!=='completed' && prior.phase!=='idle')throw fail('RESET_RECOVERY_REQUIRED',{stage:prior.home?.stage,operationId:prior.operationId})
    const home=site(snap,prior?.phase==='completed'&&prior.world===worldOf(snap.s)&&same(prior.home?.stand,snap.feet)?prior.home:null)
    selectedSite(snap,home,selectedArea)
    const after=scene()
    if(after.scope!==snap.scope||!same(after.feet,snap.feet)||fingerprint(after.view)!==fingerprint(snap.view)||(adapter.generation?.()??0)!==generation||!sameIdentity(jobIdentity(),job)||siteIdentity(site(after,home.existing?home:null))!==siteIdentity(home))throw fail('RESET_PREVIEW_STALE')
    preview={token:uuid(),expiresAt:now()+120000,scope:snap.scope,world:worldOf(snap.s),home,feet:snap.feet,
      fingerprint:fingerprint(snap.view),jobIdentity:job,generation,selectedArea}
    return {token:preview.token,expiresAt:preview.expiresAt,target:{player:snap.s.playerName??snap.s.profile,realm:snap.s.realm?.name??'',realmId:String(snap.s.realm?.id),dimension:snap.s.dimension},
      stage:copy(home.stage),homeChest:copy(home),...(selectedArea?{area:copy(selectedArea)}:{}),manifest:summary(),replaces:{surfaceChest:home.existing,inventory:true,armor:true,offhand:true}}
  }
  function guard () {
    abort?.signal.throwIfAborted()
    const frame=scene()
    if(!active||frame.scope!==active.scope||worldOf(frame.s)!==active.world||!same(frame.feet,active.feet)||(adapter.generation?.()??0)!==active.generation)throw fail('RESET_CONTEXT_CHANGED')
    if(!debugSiteReachable(active.home,frame.s.position))throw fail('RESET_SITE_REACHABILITY_CHANGED')
    selectedSite(frame,active.home,active.selectedArea)
    if(!sameIdentity(jobIdentity(),active.jobIdentity))throw fail('RESET_JOB_CHANGED')
    if(!active.clearStarted && fingerprint(frame.view)!==active.fingerprint)throw fail('RESET_PREVIEW_STALE')
    if(!active.clearStarted || active.phase==='clearing') {
      if(siteIdentity(site(frame,active.home.existing?active.home:null))!==siteIdentity(active.home))throw fail('RESET_SITE_CHANGED')
    }
    return frame
  }
  async function mark(step,info={}) {
    Object.assign(active,{step,...info,updatedAt:now()})
    await adapter.save(copy(active))
  }
  async function waitFor(predicate,label) {
    const deadline=now()+observationTimeoutMs
    do {guard();if(predicate())return;await sleep(80)}while(now()<deadline)
    throw fail('RESET_OBSERVATION_UNCONFIRMED',{label})
  }
  async function command(cmd,label) {
    await mark(label,{pending:{type:'command',label,cmd}})
    guard()
    if(active.phase==='clearing'&&!active.clearStarted&&(cmd==='/clear @s'||cmd.startsWith('/replaceitem entity @s ')))active.clearStarted=true
    const out=await commands.send(cmd,{signal:abort?.signal})
    guard()
    if(out?.serverConfirmed!==true||out.scope!==active.scope)throw fail('RESET_COMMAND_UNCONFIRMED',{label})
    active.steps++;await mark(label,{pending:null})
  }
  async function clearBot () {
    await mark('Botの持ち物と装備を空にする準備',{phase:'clearing',pending:{type:'clear_bot'}})
    guard() // Recheck confirmation, site and durable intent before the first write.
    const armorNames=['head','chest','legs','feet']
    const pieces=['helmet','chestplate','leggings','boots']
    // Non-empty writes force an actual slot observation for previously unknown
    // equipment. A command ACK never supplies an item descriptor or emptiness.
    for(let slot=0;slot<4;slot++) {
      if(adapter.getView().armor?.slots?.[slot]?.known===true)continue
      const name='minecraft:diamond_'+pieces[slot]
      await command('/replaceitem entity @s slot.armor.'+armorNames[slot]+' 0 '+name+' 1','未受信の防具枠を同期')
      await waitFor(()=>{const row=adapter.getView().armor?.slots?.[slot];return known(row)&&row.name===name&&row.count===1},'armor_bootstrap_'+slot)
    }
    if(adapter.getView().offhand?.slots?.[0]?.known!==true) {
      await command('/replaceitem entity @s slot.weapon.offhand 0 minecraft:arrow 1','未受信のオフハンドを同期')
      await waitFor(()=>{const row=adapter.getView().offhand?.slots?.[0];return known(row)&&row.name==='minecraft:arrow'&&row.count===1},'offhand_bootstrap')
    }
    if(!adapter.getView().slots.every(emptySlot)) {
      await command('/clear @s','主所持品を空にする')
      await waitFor(()=>{const view=adapter.getView();return mainView(view)&&view.slots.every(emptySlot)},'empty_main_inventory')
    }
    for(let slot=0;slot<4;slot++) {
      if(emptySlot(adapter.getView().armor?.slots?.[slot]))continue
      await command('/replaceitem entity @s slot.armor.'+armorNames[slot]+' 0 minecraft:air 1','防具枠を空にする')
      await waitFor(()=>emptySlot(adapter.getView().armor?.slots?.[slot]),'empty_armor_'+slot)
    }
    if(!emptySlot(adapter.getView().offhand?.slots?.[0])) {
      await command('/replaceitem entity @s slot.weapon.offhand 0 minecraft:air 1','オフハンドを空にする')
      await waitFor(()=>emptySlot(adapter.getView().offhand?.slots?.[0]),'empty_offhand')
    }
    if(!emptyBot(guard().view))throw fail('RESET_CLEAR_UNCONFIRMED')
    await mark('Botの空の持ち物と装備を受信確認',{pending:null})
    if(!emptyBot(guard().view))throw fail('RESET_CLEAR_UNCONFIRMED')
    active.clearStarted=true
  }
  async function openAt(p,n) {
    guard();await adapter.close()
    const receipt=await adapter.open(p,n)
    if(receipt?.serverConfirmed!==true||receipt.slotCount!==n)throw fail('RESET_CONTAINER_OPEN_UNCONFIRMED',{at:p,expected:n})
    const c=adapter.container()
    if(c?.known!==true||c.slots?.length!==n||!same(c.position,p)||c.slots.some(slot=>slot?.known!==true))throw fail('RESET_CONTAINER_CONTENTS_UNCONFIRMED',{at:p})
    return c.slots
  }
  async function mainSlots () {return openAt(active.home.position,54)}
  async function stageSlots() {return openAt(active.home.stage,27)}
  function physicalSlot(index) {
    if(!Number.isSafeInteger(index)||index<0||index>=54)throw fail('RESET_CHEST_SLOT_INVALID')
    // Combined addressing: either block of the pair takes the 54-slot index.
    if(active.home.addressing==='combined'){if(!vec(active.home.position))throw fail('RESET_CHEST_HALVES_UNKNOWN');return {position:active.home.position,slot:index}}
    const p=index<27?active.home.firstHalf:active.home.secondHalf
    if(!vec(p))throw fail('RESET_CHEST_HALVES_UNKNOWN')
    return {position:p,slot:index%27}
  }
  async function calibrateHalves () {
    const first=active.home.position,second=active.home.other
    // A server may address each 27-slot half separately, or the whole 54-slot
    // pair from either block (live 2026-11-11 18:51: the Realm wrote slot 0
    // from both blocks into the same combined slot, and slot 30 into 30).
    // Probe and use only the addressing actually observed.
    await adapter.close()
    await command('/replaceitem block '+at(first)+' slot.container 0 minecraft:dirt 1','片側チェストを識別')
    await command('/replaceitem block '+at(second)+' slot.container 0 minecraft:bread 1','反対側チェストを識別')
    let slots=await mainSlots()
    const one=(name,count)=>slots.flatMap((v,i)=>v?.name===name&&v.count===count?[i]:[])
    const dirt=one('minecraft:dirt',1),bread=one('minecraft:bread',1),others=slots.filter((v,i)=>!v.empty&&!dirt.includes(i)&&!bread.includes(i))
    if(dirt.length===1&&bread.length===1&&[0,27].includes(dirt[0])&&[0,27].includes(bread[0])&&dirt[0]!==bread[0]&&!others.length){
      active.home.addressing='halves'
      active.home.firstHalf=copy(dirt[0]===0?first:second)
      active.home.secondHalf=copy(dirt[0]===0?second:first)
    } else if(!dirt.length&&bread.length===1&&bread[0]===0&&!others.length){
      // Both commands wrote the same slot: confirm that a second-half index
      // from the first block lands at that same combined index.
      await adapter.close()
      await command('/replaceitem block '+at(first)+' slot.container 27 minecraft:dirt 2','結合番号を確認')
      slots=await mainSlots()
      if(one('minecraft:dirt',2).join()!=='27'||one('minecraft:bread',1).join()!=='0'||slots.filter(v=>!v.empty).length!==2)throw fail('RESET_CHEST_HALF_MAPPING_UNKNOWN')
      active.home.addressing='combined'
    } else throw fail('RESET_CHEST_HALF_MAPPING_UNKNOWN')
    await mark('左右チェストを識別',{chestMappingConfirmed:true,addressing:active.home.addressing})
    await adapter.close()
    for(const n of [0,27])await command('/replaceitem block '+at(active.home.addressing==='combined'?first:physicalSlot(n).position)+' slot.container '+(active.home.addressing==='combined'?n:0)+' minecraft:air 1','識別用アイテムを片付ける')
    const cleared=await mainSlots()
    if(cleared.some(x=>!x.empty))throw fail('RESET_CHEST_CALIBRATION_UNCONFIRMED')
    await adapter.close()
  }
  async function existingChest() {
    const {home}=active
    if(!home.existing) {
      for(const p of [home.position,home.other]) {
        if(!isAir(adapter.getBlock(p.x,p.y,p.z)))throw fail('RESET_CHEST_POSITION_CHANGED')
        await command('/setblock '+at(p)+' minecraft:chest keep','ラージチェストを設置')
        await waitFor(()=>adapter.getBlock(p.x,p.y,p.z)?.name==='minecraft:chest','chest_'+key(p))
      }
    }
    const slots=await mainSlots()
    if(home.existing) {
      if(home.addressing!=='combined'&&(!vec(home.firstHalf)||!vec(home.secondHalf)))throw fail('RESET_OLD_CHEST_MAPPING_UNKNOWN')
      for(let i=0;i<54;i++) {
        if(slots[i].empty)continue
        const target=physicalSlot(i)
        await adapter.close()
        await command('/replaceitem block '+at(target.position)+' slot.container '+target.slot+' minecraft:air 1','地上チェストを初期化')
      }
      const cleared=await mainSlots()
      if(cleared.some(x=>!x.empty))throw fail('RESET_CHEST_CLEAR_UNCONFIRMED')
    } else if(slots.some(x=>!x.empty))throw fail('RESET_CHEST_NOT_EMPTY')
    await adapter.close()
    await calibrateHalves()
  }
  async function put(i,name,count) {
    guard();await adapter.close()
    const target=physicalSlot(i)
    await command('/replaceitem block '+at(target.position)+' slot.container '+target.slot+' '+name+' '+count,'初期アイテムを格納')
    const slots=await mainSlots()
    if(slots[i].name!==name||slots[i].count!==count)throw fail('RESET_CHEST_ITEM_UNCONFIRMED',{slot:i,name})
    await adapter.close()
  }
  async function prepareStage(role,i) {
    const {home}=active, def=role==='cargo'?{box:CARGO_NAME,item:null,each:0}:roles[role]
    if(!isAir(adapter.getBlock(home.stage.x,home.stage.y,home.stage.z)))throw fail('RESET_STAGE_NOT_EMPTY')
    await command('/setblock '+at(home.stage)+' '+def.box+' keep','一時シュルカーを設置')
    await waitFor(()=>adapter.getBlock(home.stage.x,home.stage.y,home.stage.z)?.name===def.box,'stage_placed')
    let slots=await stageSlots()
    if(slots.some(x=>!x.empty))throw fail('RESET_STAGE_NOT_EMPTY')
    if(role!=='cargo') {
      const item=role==='shovel'?'minecraft:diamond_shovel':def.item
      for(let n=0;n<27;n++) {
        await adapter.close()
        await command('/replaceitem block '+at(home.stage)+' slot.container '+n+' '+item+' '+def.each,'補給箱を充填')
        active.supplyProgress={role,filled:n+1,total:27}
      }
      slots=await stageSlots()
      if(slots.some(x=>x.name!==item||x.count!==def.each))throw fail('RESET_SUPPLY_CONTENTS_UNCONFIRMED',{role})
    }
    await adapter.close()
    const end=role==='cargo'?CARGO:i+1
    for(let n=i;n<end;n++) {
      const target=physicalSlot(n)
      await command('/loot replace block '+at(target.position)+' slot.container '+target.slot+' 1 mine '+at(home.stage)+' minecraft:diamond_pickaxe','シュルカーを地上チェストへ格納')
      const box=(await mainSlots())[n]
      if(box.name!==def.box||box.count!==1)throw fail('RESET_BOX_TRANSFER_UNCONFIRMED',{role,slot:n})
      if(box.container?.known!==true||box.container.slots?.length!==27||role==='cargo'&&box.container.slots.some(x=>x&&!x.empty)) {
        throw fail('RESET_BOX_CONTENTS_UNCONFIRMED',{role,slot:n,reason:box.container?.reason??null})
      }
      await adapter.close()
    }
    // A looted placed shulker is NOT consumed. Remove its contents before
    // clearing the source block, otherwise duplicates spill into the Realm.
    if(role!=='cargo') {
      for(let n=0;n<27;n++)await command('/replaceitem block '+at(home.stage)+' slot.container '+n+' minecraft:air 1','一時箱の中身を片付ける')
      slots=await stageSlots()
      if(slots.some(x=>!x.empty))throw fail('RESET_STAGE_CLEAR_UNCONFIRMED')
      await adapter.close()
    }
    await command('/execute if block '+at(home.stage)+' '+def.box+' run setblock '+at(home.stage)+' minecraft:air replace','一時箱を片付ける')
    await waitFor(()=>isAir(adapter.getBlock(home.stage.x,home.stage.y,home.stage.z)),'stage_cleared')
    active.supplyProgress=null
    if(role!=='cargo')active.suppliesCompleted++
  }
  async function enchantedBow () {
    const slot=26+singles.findIndex(row=>row.name==='minecraft:bow')
    if(!emptyBot(guard().view))throw fail('RESET_BOW_NEEDS_EMPTY_BOT')
    await command('/replaceitem entity @s slot.hotbar 0 minecraft:bow 1','無限の弓を準備')
    await waitFor(()=>guard().view.slots[0].name==='minecraft:bow','bow_in_hand')
    // The server does not always echo our own selection at once (live
    // 2026-11-11 21:12: the main-hand probe answered noTargetMatch). As in the
    // shulker reset, only an explicit negative answer to this read-only probe
    // re-selects and asks again, at most three times.
    for(let attempt=0;;attempt++){
      if(guard().view.slots[0]?.name!=='minecraft:bow')throw fail('RESET_HAND_CHANGED')
      await adapter.select(0)
      try{await command('/testfor @s[hasitem={item=minecraft:bow,location=slot.weapon.mainhand,quantity=1}]','弓の主手を確認');break}
      catch(error){
        if(error.code!=='RESET_COMMAND_REJECTED'||error.serverRejected!==true||!['commands.generic.noTargetMatch','commands.testfor.failure'].includes(error.messageId))throw error
        if(attempt===2)throw fail('RESET_HAND_UNCONFIRMED')
        await sleep(150)
      }
    }
    await command('/enchant @s infinity 1','弓に無限を付与')
    await waitFor(()=>guard().view.slots[0]?.enchantmentsKnown===true &&
      guard().view.slots[0].enchantments.some(x=>x.name==='infinity'&&x.level>=1),'bow_infinity')
    await mainSlots()
    const receipt=await adapter.deposit({sourceSlot:0,chestSlot:slot,count:1,expectedName:'minecraft:bow'})
    if(receipt?.serverConfirmed!==true||receipt.inventoryConfirmed!==true||receipt.containerConfirmed!==true||receipt.count!==1||receipt.playerSlot!==0||receipt.chestSlot!==slot)throw fail('RESET_BOW_DEPOSIT_UNCONFIRMED')
    if(!guard().view.slots[0].empty)throw fail('RESET_BOW_MAIN_UNCONFIRMED')
    const box=adapter.container()
    if(box?.slots?.[slot]?.name!=='minecraft:bow'||!box.slots[slot].enchantments?.some(x=>x.name==='infinity'&&x.level>=1))throw fail('RESET_BOW_CHEST_UNCONFIRMED')
    await adapter.close()
  }
  // The reset needs success replies, which sendcommandfeedback=false suppresses
  // (2026-11-13). It is switched on for the reset only; the success reply of
  // /testfor @s proves it, and it is switched back off in finally. "Off" is
  // proven by the failure probe still replying while /testfor @s stays silent.
  async function enableFeedback() {
    if(feedbackToggle!==true)return
    active.feedback={enabledAt:null,restored:false}
    await mark('コマンド応答を有効化',{feedback:copy(active.feedback)})
    try{await commands.send('/gamerule sendcommandfeedback true',{signal:abort?.signal})}catch(error){if(error.code!=='RESET_COMMAND_TIMEOUT')throw error}
    active.feedback.enabledAt=now()
    await mark('コマンド応答を有効化',{feedback:copy(active.feedback)})
  }
  async function restoreFeedback(record) {
    if(feedbackToggle!==true)return null
    if(!record?.feedback||record.feedback.restored===true)return null
    try{await commands.send('/gamerule sendcommandfeedback false')}catch(error){if(!['RESET_COMMAND_TIMEOUT','RESET_COMMAND_REJECTED'].includes(error.code))throw error}
    let alive=false,silent=false
    try{await commands.send(FAILURE_PROBE)}catch(error){alive=error.serverRejected===true}
    try{await commands.send('/testfor @s');silent=false}catch(error){silent=error.code==='RESET_COMMAND_TIMEOUT'}
    record.feedback={...record.feedback,restored:alive&&silent,checkedAt:now(),failureProbeReplied:alive,successSuppressed:silent}
    await adapter.save(copy(record))
    return record.feedback
  }
  async function execute() {
    try {
      await acquisition
      guard()
      await confirmSelected(active.selectedArea,active.scope,abort?.signal)
      guard()
      const view=adapter.getView()
      if(fingerprint(view)!==active.fingerprint)throw fail('RESET_PREVIEW_STALE')
      await enableFeedback()
      guard()
      await command('/testfor @s','管理者権限を確認')
      guard()
      const expected=copy(active.jobIdentity),cancelled=await adapter.cancelJob({expectedJobIdentity:expected})
      if(cancelled?.serverConfirmed!==true||!sameIdentity(cancelled.previousJobIdentity,expected)||!sameIdentity(cancelled.jobIdentity,jobIdentity()))throw fail('RESET_JOB_STOP_UNCONFIRMED')
      active.jobIdentity=copy(cancelled.jobIdentity)
      guard()
      await clearBot()
      await mark('ラージチェストを準備',{phase:'running'})
      await existingChest()
      await prepareStage('cargo',0)
      await prepareStage('pickaxe',22)
      await prepareStage('shovel',23)
      await prepareStage('dirt',24)
      await prepareStage('totem',25)
      for(let i=0;i<singles.length;i++) {
        const row=singles[i]
        if(row.name==='minecraft:bow')continue
        await put(26+i,row.name,row.count)
      }
      await enchantedBow()
      const slots=await mainSlots()
      const validation=validateV22Loadout({known:true,slots})
      if(!validation.ready)throw fail('RESET_FINAL_CHEST_MISMATCH',validation.errors)
      if(!emptyBot(guard().view))throw fail('RESET_BOT_LEFT_WITH_ITEMS')
      await adapter.close()
      await mark('最終保存',{phase:'verified',verifiedAt:now(),pending:null})
      await adapter.save({...copy(active),phase:'completed',completedAt:now(),serverConfirmed:true})
      result={operationId:active.operationId,phase:'completed',serverConfirmed:true,homeChest:copy(active.home),manifestVersion:summary().version}
      active.phase='completed';active.step='完了';active.serverConfirmed=true
      adapter.publishHomeSite?.(copy(active.home))
    } catch(error) {
      lastError={code:error.code??'RESET_FAILED',message:String(error.message??error).slice(0,250),details:error.details??null}
      if(active){active.phase='failed';active.serverConfirmed=false;active.error=lastError;try{await adapter.save(copy(active))}catch{}}
      result={operationId:active?.operationId,phase:'failed',serverConfirmed:false,error:lastError}
    } finally {
      try{await adapter.cancelTransfers(active?.operationId)}catch{}
      try{await adapter.close()}catch{}
      try{const restored=await restoreFeedback(active);if(restored&&restored.restored!==true&&result)result.feedbackRestore=copy(restored)}catch(error){if(active)active.feedbackRestoreError=String(error.message??error).slice(0,160)}
      adapter.release(active?.operationId)
    }
  }
  // After a reconnect: a reset that switched feedback on and never confirmed
  // switching it off is restored once (no reset is running).
  async function restoreFeedbackIfPending() {
    if(task)return null
    const record=await adapter.load?.()
    if(!record?.feedback||record.feedback.restored===true)return null
    return restoreFeedback(record)
  }
  function start ({token,confirm,area}={}) {
    const prepared=preview;preview=null
    if(task)throw fail('RESET_BUSY')
    if(!prepared||prepared.token!==token||prepared.expiresAt<=now()||confirm!=='REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY')throw fail('RESET_CONFIRMATION_REQUIRED')
    if(prepared.selectedArea||area!=null){
      let matches=false
      try{matches=chunkAreaKey(area)===chunkAreaKey(prepared.selectedArea)}catch{}
      if(!matches)throw fail('RESET_SELECTION_CHANGED')
    }
    adapter.assertIdle()
    const snapshot=scene()
    if(snapshot.scope!==prepared.scope||worldOf(snapshot.s)!==prepared.world||!same(snapshot.feet,prepared.feet)||fingerprint(snapshot.view)!==prepared.fingerprint||
      (adapter.generation?.()??0)!==prepared.generation||!sameIdentity(jobIdentity(),prepared.jobIdentity)||siteIdentity(site(snapshot,prepared.home.existing?prepared.home:null))!==siteIdentity(prepared.home))throw fail('RESET_PREVIEW_STALE')
    active={operationId:uuid(),phase:'preparing',scope:prepared.scope,world:prepared.world,home:prepared.home,feet:prepared.feet,
      fingerprint:prepared.fingerprint,jobIdentity:copy(prepared.jobIdentity),selectedArea:copy(prepared.selectedArea),clearStarted:false,generation:prepared.generation,steps:0,suppliesCompleted:0,supplyProgress:null,pending:null,serverConfirmed:false,
      startedAt:now()}
    let acquired
    try{acquired=adapter.acquire(active.operationId)}catch(error){active=null;throw error}
    abort=new AbortController();acquisition=Promise.resolve(acquired)
    const promise=Promise.resolve().then(execute)
    task=promise.finally(()=>{if(task===tracked)task=null})
    const tracked=task
    return status()
  }
  function cancel () {
    preview=null
    abort?.abort(fail('RESET_CANCELLED'))
    commands.cancel?.()
    return status()
  }
  function status () {return {busy:!!task,operationId:active?.operationId??null,phase:active?.phase??'idle',step:active?.step??null,
    steps:active?.steps??0,suppliesCompleted:active?.suppliesCompleted??0,supplyProgress:copy(active?.supplyProgress??null),
    stage:active?.phase==='failed'?copy(active?.home?.stage??null):null,error:lastError,serverConfirmed:!task&&result?.serverConfirmed===true,result:copy(result)}}
  return {prepare,start,cancel,status,restoreFeedbackIfPending,drain:()=>task??Promise.resolve(),applyPacket:(...args)=>commands.applyPacket(...args)}
}
module.exports={createQuarryV22Reset,summary}
