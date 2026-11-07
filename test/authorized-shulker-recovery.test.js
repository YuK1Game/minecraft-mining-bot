'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readContainerContents, compareShulkerContents } = require('../src/shulker-contents')
const { createRecoveryDocument, createManualShulkerRecovery } = require('../src/manual-shulker-recovery')

const copy = value => structuredClone(value)
const target = { x: -44, y: 89, z: -199 }
const name = 'minecraft:undyed_shulker_box'
const runtimeId = 2647010207
const names = new Map([[205, name], [291, 'minecraft:wheat_seeds'], [2, 'minecraft:grass_block'],
  [-1026, 'minecraft:leaf_litter'], [277, 'minecraft:rotten_flesh'], [3, 'minecraft:dirt'],
  [261, 'minecraft:bread'], [320, 'minecraft:diamond_pickaxe']])
const resolveName = id => names.get(id)
function stack (id = 0, count = 0, stackId = 0, tag = null) {
  const extra = { has_nbt: Boolean(tag), can_place_on: [], can_destroy: [] }
  if (tag) extra.nbt = { version: 1, nbt: { type: 'compound', name: '', value: copy(tag) } }
  return { network_id: id, count, metadata: 0, has_stack_id: stackId > 0, stack_id: stackId, block_runtime_id: 0, extra }
}
function boxContents () {
  // Field layout of the life-1 recovery box. New opens may legitimately
  // assign different network stack IDs to these same items.
  const entries = [[291,15],[2,64],[-1026,9],[2,64],[277,12],[2,64],[2,64],[3,9],[2,64],[2,64],[2,7]]
  const slots = entries.map(([id,count], index) => stack(id, count, 3338 + index))
  for (let i = 0; i < 8; i++) slots.push(stack(261,64,3311+i))
  const ench = [[16,1],[17,3],[15,5],[26,1]].map(([id,lvl]) => ({ id: { type: 'short', value: id }, lvl: { type: 'short', value: lvl } }))
  for (let i = 0; i < 8; i++) slots.push(stack(320,1,3320+i,{ Damage: { type: 'int',value:0 }, ench:{type:'list',value:{type:'compound',value:ench}} }))
  return slots
}
function carried (slots, stackId) {
  const entries = slots.flatMap((r, slot) => {
    if (!r.count) return []
    const e = { Slot:{type:'byte',value:slot}, Name:{type:'string',value:resolveName(r.network_id)}, Count:{type:'byte',value:r.count}, Damage:{type:'short',value:r.metadata} }
    if (r.extra.nbt) e.tag = { type:'compound',value:copy(r.extra.nbt.nbt.value) }
    return [e]
  })
  return stack(205,1,stackId,{Items:{type:'list',value:{type:'compound',value:entries}}})
}

const same = (a,b) => a?.x === b.x && a?.y === b.y && a?.z === b.z
function fixture (fault = null) {
  const world = { profile: 'bot', realmId: '21225335', dimension: 'overworld' }
  let clock = Date.now(), generation = 30, inventoryKnown = true, screen = null
  const state = { ...world, realm: { id: world.realmId }, connectionId: 'new-connection',
    startedAt: new Date(clock).toISOString(), phase: 'spawned', spawnPending: false, dead: false, isDead: false, health: 20,
    gameMode:'survival', runtimeEntityId:'1', lifecycle: { deathId:0, dead:false, phase:'alive' },
    position: { x: -42.5, y:90.62, z:-199.5 }, rawSelectedSlot:0, rawServerSelectedSlot:0, selectedSlot:0 }
  state.rawServerPosition = copy(state.position)
  state.positionSource = 'server_post_move'; state.positionServerConfirmed = true
  const scope = () => ({ ...world, connectionId:state.connectionId,startedAt:state.startedAt,runtimeEntityId:'1',life:state.lifecycle.deathId })
  const expected = boxContents()
  const fresh = expected.map((r,i)=>({...copy(r),stack_id:5000+i}))
  const bag = Array.from({ length:36 },()=>stack())
  // An existing, fully identical box must not be mistaken for the pickup.
  bag[15] = carried(expected,7001)
  bag[0] = stack(3,4,7010)
  const main = () => bag.flatMap((r,slot) => r.count ? [{slot,name:resolveName(r.network_id),count:r.count,stackId:r.stack_id,networkId:r.network_id,metadata:r.metadata}] : [])
  const getState = () => ({ ...copy(state), heldItem:main().find(i=>i.slot===state.selectedSlot)??null,
    inventory:{ known:inventoryKnown,uncertain:!inventoryKnown,items:main() } })
  let block = { known:true, name, runtimeId, boundingBox:'block', extra:[], position:copy(target) }
  const getBlock = (x,y,z) => {
    const p = typeof x==='object' ? x : {x,y,z}
    if (same(p,target)) return copy(block)
    const solid = p.y < 89
    return {known:true,name:solid?'minecraft:stone':'minecraft:air',runtimeId:solid?8:3690217760,position:copy(p),extra:[],boundingBox:solid?'block':'empty'}
  }
  const receivedAir = () => {block={known:true,name:'minecraft:air',runtimeId:3690217760,position:copy(target),extra:[],boundingBox:'empty'}}
  const events=[],writes=[],control=new AbortController()
  const crafting = { rawItem:slot=>copy(bag[slot]),itemNameOf:resolveName, closeContainer:()=>{events.push('close');screen=null},
    inventorySnapshot:()=>({ authority:true, inventoryKnown,pendingRequestId:null,inventory:main(),openContainer:copy(screen) }) }
  crafting.snapshot=crafting.inventorySnapshot
  const chest = {
    open:async p=>{
      events.push('open');generation++
      screen={id:1,type:'container',coordinates:copy(p)}
      return {phase:'opened',serverConfirmed:fault!=='unconfirmed_open',confirmedBy:'server_container_open_and_full_content',windowId:1,slotCount:27,scope:scope(),position:copy(p)}
    },
    snapshot:()=>({busy:false,pendingRequestId:null,contentsKnown:!!screen,slotCount:screen?27:null,
      observationSource:'server_inventory_content',window:screen&&{id:1,type:'container',kind:'shulker',blockName:name,position:fault==='foreign_window'?{...target,x:target.x+1}:copy(target),epoch:generation,scope:scope(),replayed:fault==='replay'}}),
    rawItem:slot=>copy(fresh[slot])
  }
  const auth = { id:'recovery_box_test', world, position:target, name,
    expectedContents:readContainerContents(expected,{resolveName}), authorizedAt:new Date(clock).toISOString() }
  let service
  const make = () => (service = createManualShulkerRecovery({
    getState, getBlock, crafting, chest,
    refreshInventory:async()=>{events.push('refresh');return fault!=='no_refresh'},
    prepareHand:async()=>{events.push('hand');return true},
    mine:async p=>{
      events.push('mine')
      assert.ok(same(p,target))
      assert.equal(service.ownsShulker(getState(),p,getBlock(target)),true)
      assert.equal(service.ownsShulker(getState(),{...p,x:p.x+1},getBlock(target)),false)
      assert.equal(service.ownsShulker(getState(),{...p,ownershipKey:'unrelated'},getBlock(target)),false)
      if (fault==='no_air') return {phase:'mining'}
      receivedAir()
      if (fault==='death') {state.health=0;state.dead=true;state.lifecycle.deathId++}
      if (fault==='reconnect') state.connectionId='other-connection'
      if (fault==='abort_after_break') control.abort()
      if (fault==='old_moved') { bag[2]=bag[15];bag[15]=stack() }
      if (!['no_pickup','old_moved','abort_after_break'].includes(fault)) {
        bag[2]=carried(expected,7102)
        if(fault==='wrong_pickup') bag[2].extra.nbt.nbt.value.Items.value.value[11].Count.value--
        if(fault==='multiple_pickups') bag[3]=carried(expected,7103)
        if(fault==='lost_baseline_plus_two') {
          bag[15]=stack()
          bag[3]=carried(expected,7103)
          bag[3].extra.nbt.nbt.value.Items.value.value[11].Count.value--
        }
      }
      return {phase:'completed',completed:[p]}
    },
    getMining:()=>({phase:'completed',completed:[copy(target)]}),stopMining:()=>{},cancelAction:()=>{},
    moveTo:async p=>{events.push('move');state.position={x:p.x+.5,y:p.y+1.62,z:p.z+.5};return {phase:'completed'}},
    getEntities:()=>[],canAct:()=>true,now:()=>clock,sleep:async ms=>{clock+=ms}
  }))
  if (fault==='wrong_block') block.name='minecraft:chest'
  if (fault==='unknown_block') block.known=false
  if (fault==='wrong_tag') fresh[19].extra.nbt.nbt.value.Damage.value=1
  if (fault==='wrong_count') fresh[11].count--
  if (fault==='missing_slot') fresh[26]=null
  if (fault==='no_inventory') inventoryKnown=false
  if (fault==='foreign_world') state.realm.id='different'
  const document=createRecoveryDocument(auth)
  const run=(controller,doc,options={})=>controller.run(doc,{signal:control.signal,onCheckpoint:async cp=>{writes.push(copy(cp))},...options})
  return {state,expected,fresh,bag,auth,document,make,run,writes,events,control,receivedAir}
}

test('user-authorized existing box is freshly matched by all 27 slot values and recovered once across later runs',async()=>{
  const f=fixture(),service=f.make()
  const result=await f.run(service,f.document)
  assert.equal(result.status,'completed',result.reason)
  assert.equal(result.serverConfirmed,true)
  assert.equal(f.events.filter(e=>e==='mine').length,1)
  assert.equal(compareShulkerContents(f.bag[2],f.expected,{resolveName}).matches,true)
  assert.ok(f.writes.some(cp=>cp.stage==='breaking'))
  const again=await f.run(f.make(),result.checkpoint)
  assert.equal(again.status,'completed',again.reason)
  assert.equal(f.events.filter(e=>e==='mine').length,1)
})

test('unknown or changed block, inventory, lifecycle scope or packed contents never authorize a normal break',async t=>{
  for(const fault of ['wrong_block','unknown_block','wrong_tag','wrong_count','missing_slot','replay','foreign_window','unconfirmed_open','foreign_world','no_inventory','no_refresh'])await t.test(fault,async()=>{
    const f=fixture(fault),result=await f.run(f.make(),f.document)
    assert.equal(result.status,'blocked')
    assert.notEqual(result.serverConfirmed,true)
    assert.equal(f.events.filter(e=>e==='mine').length,0)
  })
})

test('failure to persist a break intent stops before any mining request', async () => {
  const f = fixture()
  let refused = false
  const r = await f.run(f.make(), f.document, { onCheckpoint:async cp=>{
    if(cp.stage === 'breaking') { refused = true; throw Error('storage unavailable') }
  } })
  assert.equal(refused,true)
  assert.equal(r.status,'blocked')
  assert.equal(f.events.filter(e=>e==='mine').length,0)
})

test('air alone, a pre-existing matching box, a different pickup, multiple candidates or lost life cannot commit recovery',async t=>{
  for(const fault of ['no_air','no_pickup','old_moved','wrong_pickup','multiple_pickups','lost_baseline_plus_two','death','reconnect','abort_after_break'])await t.test(fault,async()=>{
    const f=fixture(fault),result=await f.run(f.make(),f.document)
    assert.equal(result.status,'blocked',fault)
    assert.notEqual(result.serverConfirmed,true)
    assert.equal(f.events.filter(e=>e==='mine').length,1)
  })
})

test('resumption after received air waits for a uniquely matching new main item and never sends a second break',async()=>{
  const f=fixture('no_pickup')
  const paused=await f.run(f.make(),f.document)
  assert.equal(paused.status,'blocked')
  assert.equal(f.events.filter(e=>e==='mine').length,1)
  f.bag[2]=carried(f.expected,7200)
  const resumed=await f.run(f.make(),paused.checkpoint)
  assert.equal(resumed.status,'completed',resumed.reason)
  assert.equal(resumed.serverConfirmed,true)
  assert.equal(f.events.filter(e=>e==='mine').length,1)
})

const path = require('node:path')
const runtimeDir = path.dirname(require.resolve('../src/runtime'))
const runtime = require('node:fs').readFileSync(require.resolve('../src/runtime'),'utf8').replace(/\r\n/g,'\n')
function excerpt (from, to) {
  const i=runtime.indexOf(from), end=runtime.indexOf(to,i+from.length)
  assert.ok(i>=0&&end>i,'runtime recovery hooks must remain present')
  return runtime.slice(i,end)
}

test('runtime accepts only authorized directory IDs, rejects stale loads during execution and drains manual cancel', async () => {
  const {auth}=fixture()
  const baseDoc=id=>createRecoveryDocument({...auth,id})
  const requests=[],cancels=[]
  let releaseLoad,reading,finishRun,runSignal
  const readStarted=new Promise(resolve=>{reading=resolve})
  const fakeFs={
    stat:async file=>{requests.push(file);return {size:file.endsWith('oversize.json')?262145:4096}},
    readFile:async file=>{
      const id=path.basename(file,'.json')
      if(id==='slow'){reading();await new Promise(resolve=>{releaseLoad=resolve})}
      return JSON.stringify(baseDoc(id==='forged'?'another':id))
    }
  }
  const fakeRequire=id=>id==='node:fs/promises'?fakeFs:id==='./manual-shulker-recovery'?require('../src/manual-shulker-recovery'):require(id)
  const controller={
    snapshot:()=>({busy:!!finishRun}),
    run:(_doc,{signal})=>{runSignal=signal;return new Promise(resolve=>{finishRun=resolve})},
    cancel:reason=>{cancels.push(reason)}
  }
  const idleGuard=runtime.split('\n').find(line=>line.includes('if (!ownedCall && manualShulkerTask)'))
  assert.ok(idleGuard)
  const moduleBody=excerpt('  function manualShulkerFile (id)', '  function getManualShulkerRecovery')
  const run=excerpt('  function runManualShulkerRecovery ()', '  function quarryDir ()')
  const group=excerpt('    shulkerRecovery: {','    quarry: {')
  const ops=Function('require','__dirname','controller',`
    let manualShulkerDocument=null,manualShulkerTask=null,manualShulkerAbort=null,manualShulkerMiningSerial=null,manualShulkerLoadSequence=0,quarryPorts={}
    const manualShulkerRecovery=controller, getManualShulkerRecovery=()=>controller, stopIdleStream=()=>{}, ownedCall=false
    function requireIdle(){${idleGuard}}
    ${moduleBody}
    ${run}
    return ({${group}}).shulkerRecovery
  `)(fakeRequire,runtimeDir,controller)
  for(const invalid of ['../secret','..\\secret','a/b','a.json','', 'a'.repeat(81)]) await assert.rejects(ops.load(invalid),/ID_INVALID/)
  assert.deepEqual(requests,[])
  await assert.rejects(ops.load('oversize'),/TOO_LARGE/)
  await assert.rejects(ops.load('forged'),/ID_MISMATCH/)
  await ops.load('one')
  assert.equal(requests.at(-1),path.resolve(runtimeDir,'..','.local','shulker-recovery','one.json'))
  const late=ops.load('slow');await readStarted
  const first=ops.run()
  assert.throws(()=>ops.run())
  await assert.rejects(ops.load('two'))
  const cancelled=ops.cancel('manual stop')
  assert.equal(runSignal.aborted,true)
  assert.deepEqual(cancels,['manual stop'])
  finishRun({status:'blocked',reason:'manual stop'});await Promise.all([cancelled,first])
  releaseLoad();await assert.rejects(late,/LOAD_INTERRUPTED/)
  assert.equal(ops.status().document.id,'one')
})

test('runtime mining-frame checks apply only to matching active recovery operations and exact native serials',()=>{
  const guard=Function('manualShulkerRecovery','mining','manualShulkerMiningSerial','portableActionOwners','frame',
    excerpt('      const recovery = manualShulkerRecovery?.snapshot(), target = mining.snapshot().activeTarget','      return generationPillar?.frame(frame)'))
  const frame={position:{x:0,y:0,z:0}};let calls=[]
  const one=(busy,key,serial,current)=>guard({snapshot:()=>({busy,operationId:'manual_shulker:one'}),beforeInput:f=>calls.push(f)},
    {snapshot:()=>({activeTarget:{ownershipKey:key}})},serial,{serial:()=>current},frame)
  one(false,'manual_shulker:one',2,2)
  one(true,'another-operation',2,2)
  one(true,'manual_shulker:one',2,3)
  assert.deepEqual(calls,[])
  one(true,'manual_shulker:one',3,3)
  assert.deepEqual(calls,[frame])
})
