'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createPhysics}=require('../src/physics'),capture=require('./fixtures/navigation-origin-avoidance-tdz169.json'),copy=x=>structuredClone(x),navFile=path.resolve(__dirname,'../src/navigation.js'),moveFile=path.resolve(__dirname,'../src/movement.js')
const blocks=new Map(capture.blocks.map(b=>[`${b.position.x},${b.position.y},${b.position.z}`,b])),world={getBlock:(x,y,z)=>blocks.get(`${x},${y},${z}`)??{known:false,position:{x,y,z}}},physics=createPhysics({world,version:'1.26.60'})
function scene(t,{old=false}={}){
 t.mock.timers.enable({apis:['setInterval']});let elapsed=0;const state=copy(capture.state),packets=[],frames=[],changes=new Map(),received={getBlock:(x,y,z)=>changes.get(`${x},${y},${z}`)??world.getBlock(x,y,z)},p=physics.withWorld(received)
 t.mock.method(Date,'now',()=>Date.parse(state.predicted.updatedAt)+elapsed)
 const load=new Module(moveFile,module);load.filename=moveFile;load.paths=Module._nodeModulePaths(path.dirname(moveFile));const original=load.require.bind(load)
 let capturedStack=null
 load.require=id=>{if(old&&id==='./navigation'){const n=new Module(navFile,load);n.filename=navFile;n.paths=Module._nodeModulePaths(path.dirname(navFile));n.require=original;n.__recordStack=x=>{capturedStack=x};let source=fs.readFileSync(navFile,'utf8');assert.equal(source.split('const waypointDistance =').length,2,'counterfactual changes only the fixed waypoint binding');source=source.replace(/\bwaypointDistance\b/g,'distance');source=source.replace("} catch (error) { phase = 'failed'; reason = error.message; return snapshot() }","} catch (error) { module.__recordStack(error.stack); phase = 'failed'; reason = error.message; return snapshot() }");n._compile(source,navFile);return n.exports}return original(id)}
 load._compile(fs.readFileSync(moveFile,'utf8'),moveFile)
 const movement=load.exports.createMovement({world:received,physics:p,version:'1.26.60',getState:()=>copy(state),startGame:{current_tick:1000n},startGameReceivedAt:0,clock:()=>elapsed,client:{queue:(name,packet)=>{packets.push({name,packet:copy(packet)});return{tick:packet.tick}}},onQueuedFrame:f=>frames.push(copy(f))})
 t.after(()=>movement.stop('offline cleanup'))
 return{movement,packets,frames,changes,stack:()=>capturedStack,advance:()=>{elapsed+=50;t.mock.timers.tick(50)}}
}
test('old actual Nav shadow reproduces full first-frame TDZ stack before any real Movement queue',t=>{
 const source=fs.readFileSync(navFile,'utf8'),statement='const required = distance(circle.position, a) < padded - CONTACT_EPSILON ? circle.minDistance : padded'
 assert.equal(source.split(statement).length,2,'the exact historical shadow call has one source location')
 const line=source.slice(0,source.indexOf(statement)).split('\n').length
 assert.equal(source.split('\n')[line-1].trim(),statement,'the stack location follows the verified source line')
 const f=scene(t,{old:true});assert.equal(f.movement.preview(capture.target,capture.options).ready,true);const result=f.movement.start(capture.target,capture.options);assert.equal(result.phase,'failed');assert.match(result.reason,/Cannot access 'distance' before initialization/);assert.equal(f.packets.length,0);assert.match(f.stack(),/^ReferenceError: Cannot access 'distance' before initialization\n/);assert.match(f.stack(),new RegExp('navigation\\.js:'+line+':\\d+'))
})
test('renamed waypoint distance lets actual Movement queue the captured origin connector with unchanged current circles and goal',t=>{
 const f=scene(t);const p=f.movement.preview(capture.target,capture.options);assert.equal(p.ready,true);assert.ok(p.originRecenter);const result=f.movement.start(capture.target,capture.options);assert.equal(result.phase,'moving');assert.equal(f.packets.length,1);assert.deepEqual(result.target,capture.target);assert.deepEqual(result.route.avoidance,capture.options.avoidance)
 for(let i=0;i<5&&f.movement.snapshot().phase==='moving';i++)f.advance();assert.ok(f.frames.length>=5);assert.ok(f.frames.slice(0,5).every(x=>x.modeled&&x.receiptConfirmed&&x.predictedState.onGround));assert.equal(f.movement.snapshot().serverConfirmed,false);assert.ok(f.packets.every(x=>x.name==='player_auth_input'))
 for(const frame of f.frames.slice(0,5))for(const c of capture.options.avoidance)assert.ok(Math.hypot(frame.packetPosition.x-c.position.x,frame.packetPosition.y-c.position.y,frame.packetPosition.z-c.position.z)>=c.minDistance-1e-4)
})
test('unknown captured support still denies the connector without any queue',t=>{
 const f=scene(t);f.changes.set('8,74,-36',{known:false});const p=f.movement.preview(capture.target,capture.options);assert.equal(p.ready,false);assert.equal(f.packets.length,0)
})
