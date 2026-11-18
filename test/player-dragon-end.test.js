'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { runDragonEndStep } = require('../src/modes/dragon-end')
const { permittedTarget } = require('../src/combat/expedition-target')
const { observeSpikes, neighborhoods } = require('../src/modes/dragon-end-spikes')
const { interiorStairs } = require('../src/modes/dragon-end-stairs')
const { portalEntry } = require('../src/movement/end-portal-entry')
const block = name => ({ known: true, name: 'minecraft:' + name, extra: [] })

const mob = (type, dimension = 'end', id = type) => ({
  kind: type === 'ender_crystal' ? 'entity' : 'mob', alive: true, entityType: 'minecraft:' + type,
  dimension, runtimeId: id, uniqueId: id, positionKnown: true, position: { x: .5, y: 69, z: .5 }
})

function fixture () {
  let actors = [], opened = false, entries = 0, strikes = 0
  const raw = { dimension: 'end', connectionId: 'one', health: 20, position: { x: 3.5, y: 66.62, z: .5 } }
  const memory = { lastTransition: { sequence: 1 } }
  const ctx = { memory, runtime: { raw: () => raw, host: () => ({ getLife: () => ({ deathId: 0 }), entities: { snapshot: () => actors } }),
    enterEndPortal: () => { entries++ }, expeditionStrike: () => { strikes++; return { shotsRequested: 1 } } },
  getFeet: () => ({ ...raw.position, y: 65 }), hands: { walk: () => true },
  getBlock: (x,y,z) => y === 64 && Math.abs(z) === 0 && [0,3,-3].includes(x) ? block('bedrock') :
    y === 64 && Math.abs(x) === 2 && z === 0 && opened ? block('end_portal') : block(y < 64 ? 'end_stone' : 'air') }
  return { ctx, raw, memory, setActors: list => { actors = list }, opened: () => { opened = true }, entries: () => entries, strikes: () => strikes }
}

test('newly received open exit commits fight before a separate return attempt and requires a newer live dimension receipt', async () => {
  const f = fixture(), record = {}
  f.setActors([mob('ender_dragon')]); await runDragonEndStep(f.ctx, record)
  assert.equal(f.strikes(), 0, 'unreceived spike caps never unlock the fight')
  f.opened(); f.setActors([])
  await runDragonEndStep(f.ctx,record)
  assert.ok(record.victory); assert.equal(f.entries(), 0)
  await runDragonEndStep(f.ctx,record)
  assert.ok(record.returnAttempt); assert.equal(f.entries(), 0)
  await runDragonEndStep(f.ctx,record)
  assert.equal(f.entries(), 1)
  f.raw.dimension = 'overworld'
  assert.notEqual((await runDragonEndStep(f.ctx,record)).phase, 'complete')
  f.memory.lastTransition = { from:'end', to:'overworld', connectionId:'one', deathId:0, respawn:true, sequence:2 }
  assert.notEqual((await runDragonEndStep(f.ctx,record)).phase, 'complete')
  f.memory.lastTransition.respawn = false
  assert.equal((await runDragonEndStep(f.ctx,record)).phase, 'complete')
})

test('already open world never claims a boss kill', async () => {
  const f = fixture(), record = {}; f.opened()
  await runDragonEndStep(f.ctx,record)
  assert.equal(record.preexisting,true); assert.equal(record.victory, undefined)
})

test('expedition grants bow only to a living observed crystal in the End; neutral pearl hunt is melee-only', () => {
  const a = mob('ender_crystal')
  assert.ok(permittedTarget(a, 'end', 'bow')); assert.equal(permittedTarget(a, 'end', 'melee'), false)
  assert.equal(permittedTarget({ ...a, kind:'player' },'end','bow'), false)
  assert.equal(permittedTarget(mob('enderman','overworld'), 'overworld', 'bow'), false)
  assert.equal(permittedTarget(mob('enderman','overworld'), 'overworld', 'melee'), true)
})

test('ten actual spike caps and nearby air required; distant missing entities and unknown terrain prove nothing', () => {
  const f = fixture(), record = {}, get = f.ctx.getBlock
  const p = neighborhoods[0], key = (x,z) => x === p.x && z === p.z
  f.ctx.getBlock = (x,y,z) => key(x,z) && [70,79,80].includes(y) ? block(y === 80 ? 'bedrock' : 'obsidian') : get(x,y,z)
  const seen = () => record.spikes[0]
  observeSpikes(f.ctx,record,[],0); assert.ok(seen().cap); assert.equal(seen().cleared,undefined)
  f.raw.position = { x:p.x+2,y:70,z:p.z }
  observeSpikes(f.ctx,record,[],0)
  assert.equal(observeSpikes(f.ctx,record,[],1500).cleared,0)
  assert.equal(observeSpikes(f.ctx,record,[],1800).cleared,1)
  const a = { ...mob('ender_crystal'), position: { x:p.x+.5,y:81,z:p.z+.5 } }
  assert.equal(observeSpikes(f.ctx,record,[a],2000).cleared,0)
})

test('daylight route advances on a supported interior floor only', async () => {
  const f = fixture(), at = {x:2,y:65,z:0}, top={x:0,y:78,z:0}
  const column = { top, dx:1,dz:0, path:[{...at}], entry:{...at} }, record={climb:column}
  let mined = null
  f.ctx.getFeet=()=>({x:at.x+.5,y:at.y,z:at.z+.5})
  f.ctx.getBlock=()=>block('obsidian')
  const dig = async (ctx,pos,name) => { mined={pos,name}; return true }
  await interiorStairs(f.ctx,record,column,dig,async()=>false)
  assert.deepEqual(mined,{pos:{x:1,y:66,z:0},name:'minecraft:obsidian'})
  mined = null
  f.ctx.getBlock=(x,y,z)=>y===64?{known:false}:block('obsidian')
  assert.equal((await interiorStairs(f.ctx,record,column,dig,async()=>false)).phase,'waiting')
  assert.equal(mined,null)
})

test('ordinary physics enters both observed portal rims, and refuses removed portal or a gap', () => {
  for (const dim of ['end','overworld']) {
    let open=true
    const world={getBlock(x,y,z){
      const name=y<63?'stone':y===63?(x===1&&dim==='overworld'?'lava':'stone'):y===64&&x<=0?(dim==='end'?'bedrock':'end_portal_frame'):y===64&&x===1&&open?'end_portal':'air'
      const properties=name==='bedrock'?{infiniburn_bit:0}:name==='end_portal_frame'?{end_portal_eye_bit:1, 'minecraft:cardinal_direction':'south'}:name==='lava'?{liquid_depth:0}:{}
      return {...block(name),properties,position:{x,y,z},boundingBox:['air','end_portal'].includes(name)?'empty':'block'}
    }}
    const state={phase:'spawned',health:20,gameMode:'survival',dimension:dim,position:{x:.5,y:66.62,z:.5},positionSource:'server_post_move',rotation:{yaw:0,pitch:0}}
    const start=()=>portalEntry(world,state,{x:1,y:64,z:0},'1.26.60')
    let step=start().stepper, frame
    do { frame=step.next() } while(!frame.settled)
    assert.equal(frame.phase,'awaiting_server_confirmation')
    step=start().stepper; open=false
    assert.throws(()=>step.next())
    open=true; state.position.x=-2.5
    assert.throws(start)
  }
})

test('End mining preview accepts only the exact received expedition material and an adequate pickaxe', () => {
  const { createMining } = require('../src/actions/mining')
  const state = { phase: 'spawned', dimension: 'end', gameMode:'survival', health:20, position: {x:.5,y:66.62,z:.5}, inventory:{known:true,items:[]}, selectedSlot:0,heldItem:{name:'minecraft:diamond_pickaxe'} }
  const p={x:1,y:65,z:0}; let material='obsidian'
  const world={getBlock:(x,y,z)=>({...block(x===p.x&&y===p.y&&z===p.z?material:y===64?'end_stone':'air'), runtimeId:2})}
  const mining=createMining({getState:()=>state,world,getInput:()=>({})})
  const can=()=>mining.preview([{...p,accessPreparation:'end_expedition',expectedName:'minecraft:'+material}]).ready
  for(material of ['obsidian','iron_bars','end_stone']) assert.ok(can(),material)
  material='obsidian'; state.heldItem.name='minecraft:iron_pickaxe'
  assert.equal(can(),false)
  state.heldItem.name='minecraft:diamond_pickaxe'; state.dimension='overworld'
  assert.equal(can(),false)
  material='chest'; assert.throws(can)
})

test('steep trajectory for an elevated crystal is available without changing ordinary bow range', () => {
  const {solveBowAim}=require('../src/combat/bow-ballistics')
  const normal={eye:{x:0,y:60,z:0},point:{x:44,y:109,z:0}}
  assert.equal(solveBowAim(normal), null)
  assert.ok(solveBowAim({...normal,elevatedTarget:true}).pitch < -45)
})
