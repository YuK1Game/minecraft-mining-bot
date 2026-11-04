'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {planContinuationResource}=require('../src/continuation-resource')
const {nextDiamondAction}=require('../src/diamond-planner')
const {continuationScope}=require('../src/base-continuation')
const fixtureFile=path.resolve(__dirname,'diamond-planner.test.js'),loaded=new Module(fixtureFile,module)
loaded.filename=fixtureFile;loaded.paths=Module._nodeModulePaths(path.dirname(fixtureFile));loaded._compile(fs.readFileSync(fixtureFile,'utf8').split('\ntest(')[0]+'\nmodule.exports={fixture};',fixtureFile)
function fixture(){
  const f=loaded.exports.fixture()
  Object.assign(f.state,{profile:'bot',realm:{id:'21225335'},connectionId:'current-cid',startedAt:'2026-11-01T13:50:28.443Z',lifecycle:{phase:'alive',deathId:0},entities:[],entityStats:{unknownPositions:0}})
  f.plan=(resource,targetCount,options={})=>planContinuationResource({state:f.state,observations:f.observations,intent:{kind:'work',scope:continuationScope(f.state),resource,targetCount},options})
  return f
}
const copy=v=>structuredClone(v)

test('raw log reserve uses the real natural-tree planner despite owned tools/boards/table and historical progress, without mutating those observations',()=>{
  const f=fixture();f.items([['iron_pickaxe',1],['cobblestone',163],['oak_planks',5],['stick',64],['crafting_table',1],['oak_log',2],['diamond',1]]);f.hold('iron_pickaxe');f.table()
  f.observations.progress={logsCollected:96,stoneCollected:466,excludedResources:[],excludedDropIds:[]}
  const before=copy({state:f.state,observations:f.observations}),p=f.plan('logs',8)
  assert.equal(p.type,'gather_logs');assert.equal(p.count,6);assert.equal(p.block,'minecraft:oak_log')
  assert.deepEqual(p.goal,{logs:8});assert.equal(p.counts.logs,2);assert.equal(p.counts.stone,163);assert.equal(p.counts.planks,5);assert.equal(p.counts.sticks,64);assert.equal(p.counts.craftingTables,1);assert.equal(p.counts.diamond,1)
  assert.deepEqual({state:f.state,observations:f.observations},before)
  assert.equal(p.continuation.remaining,6);assert.equal(p.continuous,true)
})

test('actual logs count, real tree exclusions and actual fulfilled reserve remain authoritative',()=>{
  const f=fixture();f.items([['iron_pickaxe',1],['oak_log',7],['cobblestone',64]]);f.hold('iron_pickaxe')
  assert.equal(f.plan('logs',8).count,1)
  f.observations.progress={logsCollected:999,excludedResources:[{resource:'logs',position:{x:3,y:65,z:0}}],excludedDropIds:[]}
  const p=f.plan('logs',8);assert.notDeepEqual(p.target,{x:3,y:65,z:0})
  const before=copy(f.observations.progress);f.state.inventory.items.find(i=>i.name==='minecraft:oak_log').count=8
  const done=f.plan('logs',8);assert.equal(done.type,'wait');assert.equal(done.resourceGoalMet,true);assert.deepEqual(done.goal,{logs:8});assert.deepEqual(f.observations.progress,before)
})

test('stone64 reuses actual Bootstrap equipment and stone geometry without returning a diamond-complete decision',()=>{
  const f=fixture();f.items([['iron_pickaxe',1],['cobblestone',50],['diamond',1]]);f.hold('iron_pickaxe')
  const p=f.plan('stone',64)
  assert.equal(p.type,'mine_stone');assert.equal(p.count,14);assert.equal(p.block,'minecraft:stone');assert.deepEqual(p.goal,{stone:64});assert.equal(p.counts.stone,50);assert.equal(p.counts.diamond,1)
  f.state.inventory.items.find(i=>i.name==='minecraft:cobblestone').count=64
  assert.equal(f.plan('stone',64).resourceGoalMet,true)
})

test('explicit iron reserve uses owned stone-or-higher tools and real iron ore even while an actual diamond is held',()=>{
  for(const tool of ['iron_pickaxe','stone_pickaxe']){
    const f=fixture();f.items([[tool,1],['raw_iron',1],['iron_ingot',2],['diamond',1]]);f.hold(tool);f.ore('iron','iron_ore',{x:2,y:65,z:0})
    const p=f.plan('iron',8)
    assert.equal(p.type,'mine_ore');assert.equal(p.resource,'iron');assert.equal(p.block,'minecraft:iron_ore');assert.equal(p.requiredToolTier,2);assert.equal(p.count,5)
    assert.equal(p.counts.iron,3);assert.equal(p.counts.diamond,1);assert.deepEqual(p.goal,{iron:8})
    assert.equal(f.next().type,'complete','the ordinary diamond default is preserved')
    f.state.inventory.items=f.state.inventory.items.filter(i=>i.name!=='minecraft:diamond')
    f.observations.drops=[{known:true,name:'minecraft:diamond',count:1,entityId:'900',position:{x:1,y:65,z:0}}]
    assert.equal(f.plan('iron',8).resource,'iron','a diamond drop does not replace the explicit iron reserve')
  }
})

test('iron reserve requires actual equip and ordinary tool bootstrap, never inventing an iron tool or asking for diamonds',()=>{
  const equip=fixture();equip.items([['iron_pickaxe',1],['stone_sword',1],['diamond',1]]);equip.hold('stone_sword')
  assert.equal(equip.plan('iron',8).type,'equip');assert.equal(equip.plan('iron',8).item,'minecraft:iron_pickaxe')
  const boot=fixture();boot.items([['diamond',1]])
  const p=boot.plan('iron',8);assert.equal(p.type,'gather_logs');assert.deepEqual(p.goal,{iron:8});assert.equal(p.counts.diamond,1)
})

test('buried iron remains real iron, while current unknown/protected/scoped excluded ore cannot become a reserve mining target',()=>{
  const f=fixture();f.items([['iron_pickaxe',1],['diamond',1]]);f.hold('iron_pickaxe');f.ore('iron','deepslate_iron_ore',{x:4,y:62,z:0},{requiresTunnel:true})
  const p=f.plan('iron',8);assert.equal(p.type,'tunnel');assert.equal(p.resource,'iron');assert.equal(p.targetOre.name,'minecraft:deepslate_iron_ore')
  for(const flags of [{known:false},{protected:true}]){
    const b=fixture();b.items([['iron_pickaxe',1]]);b.hold('iron_pickaxe');b.ore('iron','iron_ore',{x:2,y:65,z:0});b.set(2,65,0,'iron_ore',flags);b.refresh()
    const q=b.plan('iron',8);assert.ok(!['mine_ore','tunnel'].includes(q.type));assert.equal(q.resource,'iron')
  }
  f.observations.progress={excludedResources:[{resource:'iron',position:{x:4,y:62,z:0},scope:JSON.stringify(['bot','21225335','overworld','current-cid','41'])}]}
  assert.notDeepEqual(f.plan('iron',8).target,{x:4,y:62,z:0})
})

test('held iron reserve completion uses actual raw-plus-ingot counts and adapter returns reclassification instead of old diamond completion',()=>{
  const f=fixture();f.items([['iron_pickaxe',1],['raw_iron',5],['iron_ingot',3],['diamond',1]]);f.hold('iron_pickaxe')
  const direct=nextDiamondAction(f.state,f.observations,{reserveResource:'iron',reserveCount:8})
  assert.equal(direct.type,'complete');assert.equal(direct.stage,'iron_reserve');assert.deepEqual(direct.goal,{iron:8});assert.equal(direct.confirmedBy,'server_inventory')
  const p=f.plan('iron',8);assert.equal(p.type,'wait');assert.equal(p.resourceGoalMet,true);assert.equal(p.counts.iron,8)
  assert.equal(nextDiamondAction(f.state,f.observations,{reserveResource:'iron',reserveCount:50000}).code,'invalid_reserve_goal')
})

test('zero-food work uses only the actual existing foraging preview and never forges private nutrition admission',()=>{
  const f=fixture();f.items([['iron_pickaxe',1]])
  assert.equal(f.plan('food',1).code,'foraging_preview_required')
  f.observations.foragingPreview={ready:true,kind:'drop',target:{runtimeId:'12',name:'minecraft:mutton',position:{x:2,y:65,z:0}}}
  const p=f.plan('food',1);assert.equal(p.type,'forage');assert.equal(p.purpose,'food');assert.equal(p.requiresNutritionAdmission,true)
  assert.deepEqual(p.foragingOptions,{maxSteps:3,maxHits:3,timeoutMs:30000});assert.equal(Object.hasOwn(p,'nutritionScope'),false);assert.equal(Object.hasOwn(p,'nutritionWindow'),false)
  f.observations.foragingPreview={ready:false,code:'NO_KNOWN_FOOD_SOURCE'};assert.equal(f.plan('food',1).code,'NO_KNOWN_FOOD_SOURCE')
})

test('owned food truthfully defers a higher advisory reserve rather than hiding inventory or looping successful no-ops',()=>{
  const f=fixture();f.items([['mutton',2],['diamond',1]])
  const before=copy(f.state),p=f.plan('food',4)
  assert.equal(p.type,'wait');assert.equal(p.code,'continuation_food_reserve_deferred');assert.equal(p.skipAdvisoryReserve,true);assert.equal(p.continuationDeferred,true);assert.equal(p.counts.food,2);assert.equal(p.resourceGoalMet,undefined)
  assert.deepEqual(f.state,before);assert.equal(f.plan('food',1).resourceGoalMet,true)
})

test('work goals are bounded actual deficits and stale intent, unknown inventory, active tasks or actor threats never dispatch resources',()=>{
  const f=fixture();f.items([['iron_pickaxe',1]])
  const bounded=f.plan('logs',1000);assert.equal(bounded.continuation.targetCount,16);assert.equal(bounded.continuation.remaining,16);assert.equal(bounded.count,16)
  assert.equal(f.plan('diamond',1).code,'invalid_continuation_resource');assert.equal(f.plan('logs',50000).code,'invalid_continuation_resource')
  const intent={kind:'work',resource:'iron',targetCount:8,scope:{...continuationScope(f.state),life:9}}
  assert.equal(planContinuationResource({state:f.state,observations:f.observations,intent}).code,'continuation_scope_changed')
  f.state.inventory.uncertain=true;assert.equal(f.plan('iron',8).code,'inventory_unknown');f.state.inventory.uncertain=false
  f.state.mining={busy:true};assert.equal(f.plan('iron',8).code,'task_in_progress');delete f.state.mining
  f.state.entities=[{runtimeId:'100',uniqueId:'-100',kind:'mob',entityType:'minecraft:zombie',alive:true,positionKnown:true,dimension:'overworld',position:{x:1,y:65,z:0}}]
  assert.equal(f.plan('iron',8).code,'continuation_safety')
})

test('ordinary DiamondPlanner output is unchanged across bootstrap, furnace preparation, iron tools and actual diamond completion',()=>{
  for(const [values,type] of [[[],'gather_logs'],[[['stone_pickaxe',1],['cobblestone',8]],'gather_logs'],[[['iron_pickaxe',1]],'prospect'],[[['diamond',1]],'complete']]){
    const f=fixture();f.items(values);if(values.some(([n])=>n.includes('pickaxe')))f.hold(values[0][0])
    assert.equal(nextDiamondAction(f.state,f.observations).type,type)
  }
})
