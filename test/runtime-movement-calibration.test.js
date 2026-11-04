'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve(__dirname, 'runtime-user-behaviors.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
let prefix = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
prefix = prefix.replace('  let worldReads = 0,', '  let queuedObserver;\n  let worldReads = 0,')
prefix = prefix.replace("  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", `  const inputFactory = overrides['./input'].createInput
  overrides['./input'] = { createInput: options => { queuedObserver = options.onQueuedFrame; return inputFactory(options) } }
  const historyFactory = overrides['./input-history'].createInputHistory
  overrides['./input-history'] = { createInputHistory: options => { const history = historyFactory(options); return { ...history, observeAnchor: value => { events.push({ type: 'anchor_after_calibration', pairCount: runtime.snapshot().movementCalibration.pairs.length }); return history.observeAnchor(value) } } } }
  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)`)
prefix = prefix.replace('return { runtime, host, raw,', 'return { queueFrame: frame => queuedObserver(frame), runtime, host, raw,')
loaded._compile(prefix + '\nmodule.exports = { scene };',file)
const { scene } = loaded.exports
function emit (f,tick,at=Date.now(),x=Number(tick)/1000) {
  const physical = { position: { x, y: 65, z: 0.5 }, velocity: { x: 0.1, y: -0.0784, z: 0 }, onGround: true, isInWater: false, isInLava: false, yaw: -90, pitch: 0, gameMode: 'survival', controls: { forward: true }, effects: {}, attributes: {} }
  f.queueFrame({ tick: String(tick), queuedAt: at, modeled: true, receiptConfirmed: true, producer: 'navigation', controls: { forward: true }, predictedState: physical, packetPosition: { x, y: 66.62, z: 0.5 }, yaw: -90, pitch: 0, health: 20 })
}
function correction (f,tick) { const p={ x:Number(tick)/1000+0.01,y:66.62,z:0.5 }; f.raw.position={...p}; f.raw.positionUpdatedAt=Date.now(); f.runtime.applyPacket('correct_player_move_prediction',{prediction_type:'player',tick:BigInt(tick),position:p,delta:{x:0.1,y:0,z:0},on_ground:true,rotation:{x:0,z:0}}) }
test('exact received correction tick pairs its queued Native frame and two prior frames before history rebasing', t => {
  const f=scene(t), now=Date.now(), beforeWire=f.wire.length
  for (let n=1001;n<=1004;n++) emit(f,n,now-(1004-n)*50)
  correction(f,1003)
  const d=f.runtime.snapshot().movementCalibration,pair=d.pairs[0]
  assert.equal(d.frameCount,4);assert.equal(pair.correction.tick,'1003');assert.deepEqual(pair.frames.map(row=>row[0]),['1001','1002','1003']);assert.notEqual(pair.frames.at(-1)[0],'1004')
  assert.equal(pair.previousSteady,true);assert.equal(pair.frames[2][2][0],1.003);assert.equal(pair.correction.position[0],1.013)
  assert.equal(pair.frames[2][3][1],65);assert.equal(pair.frames[2][6],1);assert.equal(pair.frames[2][5],true)
  assert.ok(f.events.some(e=>e.type==='anchor_after_calibration'&&e.pairCount===1));assert.equal(f.wire.length,beforeWire)
  for(let n=1010;n<1070;n+=3){emit(f,n);emit(f,n+1);emit(f,n+2);correction(f,n+2)}
  const final=f.runtime.snapshot().movementCalibration
  assert.ok(final.frameCount<=48);assert.ok(final.pairs.length>1&&final.pairs.length<=12);assert.ok(Buffer.byteLength(JSON.stringify(final),'utf8')<=12288)
})
test('late, cross-life, scope, force, duplicate and unmatched corrections cannot pair with a newer unrelated frame', t => {
  const f=scene(t)
  const sequence=(base,at=Date.now())=>{for(let n=base;n<base+3;n++)emit(f,n,at-(base+2-n)*50)}
  sequence(1001);f.runtime.applyPacket('motion_prediction_hints',{entity_runtime_id:1n,velocity:{x:0.2,y:0,z:0},on_ground:true});correction(f,1003)
  sequence(1011);f.shared.deathRespawn.deathId++;correction(f,1013)
  sequence(1021);f.raw.startedAt='new-start';correction(f,1023)
  sequence(1031,Date.now()-4000);correction(f,1033)
  sequence(1041);emit(f,1043);correction(f,1043)
  for(let n=2001;n<=2055;n++)emit(f,n)
  correction(f,2001);correction(f,9999)
  const d=f.runtime.snapshot().movementCalibration
  assert.equal(d.pairs.length,0);assert.equal(d.frameCount,48)
  for(const reason of ['force_changed','cross_life','cross_scope','late_or_future','duplicate_tick','unmatched_or_evicted'])assert.ok(d.skipped[reason]>0,reason)
})
