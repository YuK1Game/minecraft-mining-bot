'use strict'
// Actual Runtime + actual Runner.request adapter; HTTP is a controlled capture,
// never a game/API request or physical movement.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const file=path.join(__dirname,'runtime-user-behaviors.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));let source=fs.readFileSync(file,'utf8').split('\ntest(')[0]
source=source.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)","loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8').replace('  const operations = {', '  const operations = {\\n    __testRunner: runner, __testSetPortableLease: value => { portableMovementLease = value },'), filename)")
m._compile(source+'\nmodule.exports={scene}',file)
function fixture(t){const calls=[];t.mock.method(globalThis,'fetch',async(url,o)=>{calls.push({url:String(url),options:o,body:o.body?JSON.parse(o.body):null});return{ok:true,text:async()=>JSON.stringify({ready:true})}});const f=m.exports.scene(t);f.shared.autoWanted=true;f.shared.deathRespawn.deathId=7
 const received=value=>f.runtime.applyPacket('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:player.hunger',current:value}]});received(16)
 const request=(path='/move/preview',body={target:{x:2.5,y:65,z:.5},options:{allowWater:false,maxDistance:6}},options={})=>f.runtime.operations.__testRunner.request('POST',path,body,options)
 return {...f,calls,received,request,last:()=>calls.at(-1)?.body}
}
test('low current-life received hunger and confirmed empty main add sprintfalse to real Runner preview and start without mutating caller body',async t=>{
 const f=fixture(t),body={target:{x:2.5,y:65,z:.5},options:{allowWater:false,maxDistance:6}},before=structuredClone(body);await f.request('/move/preview',body);assert.equal(f.last().options.sprint,false);await f.request('/move/start',body);assert.equal(f.last().options.sprint,false);assert.deepEqual(body,before);assert.equal(f.wire.length,0);assert.equal(f.mockMovement.snapshot().phase,'idle');assert.equal(f.raw.health,20)
})
test('each actual request reads fresh hunger; explicittrue/false and healthy or unknown defaults remain intact',async t=>{
 const f=fixture(t);await f.request();assert.equal(f.last().options.sprint,false);f.received(18);await f.request('/move/start');assert.equal(Object.hasOwn(f.last().options,'sprint'),false);f.received(17);await f.request('/move/start');assert.equal(f.last().options.sprint,false)
 for(const sprint of [true,false]){await f.request('/move/preview',{target:{x:2.5,y:65,z:.5},options:{sprint}});assert.equal(f.last().options.sprint,sprint)}
 for(const change of [()=>{f.shared.vitals.hunger.source='client_prediction'},()=>{delete f.shared.vitals.hunger.scope},()=>{f.shared.vitals.hunger.scope.deathId=6},()=>{f.shared.vitals.hunger.observedAt=new Date(Date.now()+1000).toISOString()},()=>{f.shared.deathRespawn=null}]){f.shared.deathRespawn={deathId:7};f.received(16);change();await f.request();assert.equal(Object.hasOwn(f.last().options,'sprint'),false)}
 f.shared.deathRespawn={deathId:7};f.received(16);f.shared.vitals.hunger.observedAt=new Date(Date.now()-300000).toISOString();await f.request();assert.equal(f.last().options.sprint,false,'unchanged current-life server hunger has no arbitrary TTL')
})
test('actual supported food or rotten reserve preserves ordinary default; incomplete raw inventory never invents food absence',async t=>{
 const f=fixture(t),air={network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}
 f.runtime.applyPacket('item_registry',{itemstates:[{runtime_id:301,name:'minecraft:bread'},{runtime_id:302,name:'minecraft:rotten_flesh'}]})
 for(const network_id of [301,302]){f.runtime.applyPacket('inventory_slot',{window_id:'inventory',slot:0,item:{...air,network_id,count:2,has_stack_id:true,stack_id:81}});f.raw.inventory={known:true,items:f.facadeOptions.crafting.snapshot().inventory};await f.request();assert.equal(Object.hasOwn(f.last().options,'sprint'),false)}
 f.raw.inventory.items[0].name='minecraft:stone';await f.request();assert.equal(Object.hasOwn(f.last().options,'sprint'),false,'actual registry food name cannot be hidden by a mismatched DTO')
 f.raw.inventory={known:true,items:[]};await f.request();assert.equal(Object.hasOwn(f.last().options,'sprint'),false,'nonempty raw slot missing from DTO cannot prove no food')
 f.runtime.applyPacket('inventory_slot',{window_id:'inventory',slot:0,item:air});await f.request();assert.equal(f.last().options.sprint,false)
 f.raw.inventory.known=false;await f.request();assert.equal(Object.hasOwn(f.last().options,'sprint'),false)
})
test('adapter preserves portable lease marker, other options and AbortSignal; unrelated direct controller paths are untouched',async t=>{
 const f=fixture(t),controller=new AbortController(),target={x:2.5,y:65,z:.5};f.runtime.operations.__testSetPortableLease({id:'CONTROLLED-portable'})
 await f.request('/move/preview',{target,options:{allowWater:false,avoidance:[{id:'far',position:{x:50,y:65,z:50},minDistance:5}],maxTicks:100}},{signal:controller.signal});const sent=f.calls.at(-1);assert.equal(sent.body.options.sprint,false);assert.equal(sent.body.options._portableMovementLease,'CONTROLLED-portable');assert.equal(sent.body.options.maxTicks,100);assert.equal(sent.options.signal.aborted,false);controller.abort();assert.equal(sent.options.signal.aborted,true)
 await f.request('/action',{group:'movement',method:'preview',args:[target,{allowWater:false}]});assert.equal(f.last().group,'movement');assert.equal(f.last().args[1].sprint,undefined);assert.equal(f.wire.length,0)
})
