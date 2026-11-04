'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { createDepotMission } = require('../src/depot-mission')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture (dispatch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-depot-mission-'))
  const state = {phase:'spawned',profile:'bot',realm:{id:'21225335'},dimension:'overworld',connectionId:'current',startedAt:'2026-11-01T13:50:28.443Z',runtimeEntityId:'13639',lifecycle:{deathId:0,phase:'alive'},health:20,gameMode:'survival',position:{x:.5,y:68.62,z:.5},inventory:{known:true,items:[{slot:21,name:'minecraft:diamond',count:1}]},entities:[],entityStats:{unknownPositions:0}}
  const make = () => createDepotMission({getState:()=>structuredClone(state),world:{getBlock:()=>({known:false})},getRawItem:()=>null,workspaceRoot:root,dispatch,intervalMs:10})
  return {root,state,make}
}
test('journal keeps enabled online mission across scheduler recreation without old goal completion', async () => {
  let calls = 0
  const f = await fixture(async intent => { calls++; assert.equal(intent.kind,'return_surface'); return {phase:'observing',surfaceReached:false} })
  const first=f.make(); await first.start(); await first.tick(); await first.close()
  const n=calls, second=f.make(); await second.resume(); await second.tick(); await second.close()
  assert.ok(calls>n); assert.equal(second.snapshot().enabled,true); assert.equal(second.snapshot().policy.deposited,0)
})
test('one scoped task at a time and closing drains an aborted child without claiming completion', async () => {
  let resolve, calls=0
  const f=await fixture(async (_intent,{signal})=>{calls++; await new Promise(r=>{resolve=r;signal.addEventListener('abort',r,{once:true})});return {phase:'observing'}})
  const m=f.make(); await m.start(); const a=m.tick(),b=m.tick(); assert.equal(a,b)
  while(!resolve) await sleep(1)
  await m.close(); assert.equal(calls,1); assert.equal(m.snapshot().actions,0); assert.equal(m.snapshot().busy,false)
})
test('a connection/life change during dispatch cannot become an accepted action', async () => {
  const f=await fixture(async()=>{f.state.lifecycle.deathId++;return {phase:'completed'}})
  const m=f.make(); await m.start(); await m.tick(); await m.close()
  assert.match(m.snapshot().lastError,/boundary/); assert.equal(m.snapshot().actions,0); assert.equal(m.snapshot().policy.deposited,0)
})
test('observation results cannot recursively retain earlier status snapshots or large block scans', async () => {
  let m
  const f=await fixture(async()=>({phase:'completed',serverConfirmed:false,observations:{state:{depotMission:m.snapshot()},blocks:Array.from({length:10000},(_,x)=>({position:{x,y:65,z:0},name:'minecraft:air'}))}}))
  m=f.make();await m.start();await m.tick();await m.tick();await m.tick();await m.close()
  assert.deepEqual(m.snapshot().lastResult,{phase:'completed',serverConfirmed:false})
  assert.ok(Buffer.byteLength(JSON.stringify(m.snapshot()))<5000)
})
