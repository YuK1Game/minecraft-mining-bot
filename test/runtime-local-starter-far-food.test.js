'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module')
const file=path.join(__dirname,'runtime-local-work-priority.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports={prepare}',file);const {prepare}=m.exports
function scene(t,{health=17,hunger=16,distance=32.294,learning=true}={}){const f=prepare(t,{health,hunger,night:false,learning,source:null});f.actors.splice(0);f.setItems([]);f.setForagePreview({ready:true,kind:'drop',target:{runtimeId:'17257',name:'minecraft:potato',position:{x:f.raw.position.x+distance,y:f.raw.position.y,z:f.raw.position.z}}});return f}
test('current L96 policy inputs H17/hunger16 or15 with full local body choose existing two-log sword before distant potato',t=>{
 for(const hunger of [16,15]){const f=scene(t,{hunger}),d=f.plan(),diag=f.runtime.snapshot().startupPriority;assert.equal(diag.bodyProof,true);assert.equal(diag.actualDanger,0);assert.equal(diag.distantFoodDeferred,true);assert.ok(diag.sourceDistance>27);assert.equal(d.type,'gather_logs');assert.equal(d.count,2);assert.equal(d.preparation,'wooden_sword');assert.equal(f.host.shared.nutritionTask,undefined)}
})
test('old threshold produces the actual far-forage scheduling class with identical healthy local inputs',t=>{
 const current=process.env.RUNTIME_TEST_SOURCE,source=fs.readFileSync(current??path.resolve(__dirname,'../src/runtime.js'),'utf8'),needle='const distantFoodDeferred = (stoneBootstrapVitals || localStarterVitals)'
 assert.equal(source.split(needle).length,2,'counterfactual changes only the actual first-sword deferral expression')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minecraft-starter-baseline-')),file=path.join(dir,'runtime.js')
 fs.writeFileSync(file,source.replace(needle,()=>'const distantFoodDeferred = stoneBootstrapVitals'))
 t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir)})
 try{process.env.RUNTIME_TEST_SOURCE=file;const f=scene(t);assert.equal(f.plan().type,'forage');assert.equal(f.runtime.snapshot().startupPriority.bodyProof,true);assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)}finally{if(current===undefined)delete process.env.RUNTIME_TEST_SOURCE;else process.env.RUNTIME_TEST_SOURCE=current}
})
test('near food and urgent/unknown vitals retain ordinary food priority; owned food still precedes starter work',t=>{
 for(const options of [{distance:7},{health:8,hunger:16},{hunger:6}]){const f=scene(t,options),d=f.plan();assert.notEqual(d?.preparation,'wooden_sword');assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)}
 const own=scene(t);own.setItems([['bread',1]]);assert.equal(own.plan().type,'eat')
 const unknown=scene(t);unknown.host.shared.vitals.hunger.source='client_prediction';unknown.plan();assert.equal(unknown.runtime.snapshot().startupPriority.distantFoodDeferred,false)
})
test('unverified body, actual danger and balanced policy cannot enable the new starter deferral',t=>{
 for(const mode of ['body','danger','balanced']){const f=scene(t,{learning:mode!=='balanced'});if(mode==='body'){const read=f.host.world.getBlock;f.host.world.getBlock=(x,y,z)=>x===0&&y===64&&z===0?{known:false}:read(x,y,z)}if(mode==='danger')f.actors.push(f.enemy('zombie',3));const d=f.plan();assert.notEqual(d?.preparation,'wooden_sword');assert.notEqual(f.runtime.snapshot().startupPriority?.distantFoodDeferred,true)}
})
test('nonurgent starter boundary is HP14/H10 with source strictly beyond8; lower vitals or an existing sword do not use it',t=>{
 const edge=scene(t,{health:14,hunger:10,distance:8.001});assert.equal(edge.plan().type,'gather_logs');assert.equal(edge.runtime.snapshot().startupPriority.distantFoodDeferred,true)
 for(const options of [{health:13.999,hunger:10},{health:14,hunger:9},{health:14,hunger:10,distance:8}]){const f=scene(t,options);f.plan();assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)}
 const armed=scene(t);armed.setItems([['wooden_sword',1]]);armed.plan();assert.equal(armed.runtime.snapshot().startupPriority.distantFoodDeferred,false)
})
