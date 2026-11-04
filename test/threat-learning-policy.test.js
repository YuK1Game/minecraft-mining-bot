'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { evaluateThreats } = require('../src/threats')

const state = (health, policy = 'online_learning') => ({ health, threatPolicy: policy, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld' })
const actor = (name, x, extra = {}) => ({ runtimeId: '9', uniqueId: '90', entityType: `minecraft:${name}`, positionKnown: true, position: { x, y: 64, z: 0 }, dimension: 'overworld', ...extra })
const entry = (s, entity, options) => {
  const result = evaluateThreats(s, [entity], options)
  return [...result.threats, ...result.outsideDanger, ...result.unknownPositions][0]
}

test('explicit living online learning uses 5m melee/10m other ranged and strengthened18m archer decision thresholds, never actual attack-range claims', () => {
  for (const health of [0.5, 6, 13, 20]) {
    const drowned = entry(state(health), actor('drowned', 20))
    assert.equal(drowned.dangerRadius, 10)
    assert.equal(drowned.legacyRadius, 14)
    assert.equal(drowned.riskAccepted, true)
    assert.equal(drowned.dangerous, false)
    assert.match(drowned.evidenceUrl, /Mojang\/bedrock-samples/)
    assert.equal(entry(state(health), actor('witch', 17)).dangerRadius, 10)
    for (const name of ['pillager']) {
      const skeleton = entry(state(health), actor(name, 17))
      assert.equal(skeleton.dangerRadius, 10)
      assert.equal(skeleton.dangerous, false)
      assert.equal(skeleton.riskAccepted, true)
      assert.equal(skeleton.legacyRadius, name === 'pillager' ? 24 : 18)
      assert.match(skeleton.policyBasis, /実際の攻撃・索敵範囲ではなく/)
      assert.match(skeleton.policyBasis, /10ブロックを超えても矢・投射物/)
    }
    for (const name of ['skeleton','stray','bogged']) {
      const archer=entry(state(health),actor(name,17));assert.equal(archer.dangerRadius,18);assert.equal(archer.dangerous,true);assert.equal(archer.riskAccepted,undefined);assert.equal(archer.legacyRadius,undefined)
    }
    for (const name of ['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider']) {
      const melee = entry(state(health), actor(name, 7))
      assert.equal(melee.dangerRadius, 5); assert.equal(melee.legacyRadius, 12); assert.equal(melee.riskAccepted, true); assert.equal(melee.dangerous, false)
    }
  }
})

test('legacy policy and uncertain or dead health do not silently opt into learning', () => {
  for (const s of [state(6, 'balanced_mining'), { ...state(6), threatPolicy: undefined }, state(null), state(NaN), state(0), { ...state(6), dead: true }, { ...state(6), isDead: true }, { ...state(6), lifecycle: { dead: true } }]) {
    assert.equal(entry(s, actor('drowned', 20)).dangerRadius, 24)
    assert.equal(entry(s, actor('skeleton', 20)).dangerRadius, 24)
    assert.equal(entry(s, actor('skeleton', 20)).riskAccepted, undefined)
  }
  assert.equal(entry(state(20, 'balanced_mining'), actor('drowned', 20)).dangerRadius, 14)
  assert.equal(entry(state(6, 'balanced_mining'), actor('witch', 17)).dangerRadius, 20)
})

test('learning keeps extra margin, explosive/boss policy and unknown observations intact', () => {
  const padded = entry(state(6), actor('drowned', 15), { extraMargin: 2 })
  assert.equal(padded.dangerRadius, 12)
  assert.equal(padded.legacyRadius, 16)
  assert.equal(entry(state(6), actor('creeper', 5, { primed: true })).dangerRadius, 12)
  assert.equal(entry(state(6), actor('creeper', 5, { charged: true })).dangerRadius, 16)
  assert.equal(entry(state(6), actor('warden', 20)).dangerRadius, 32)
  const unknown = evaluateThreats(state(6), [actor('drowned', 20, { positionKnown: false })])
  assert.equal(unknown.requiresObservation, true)
  assert.equal(unknown.unknownPositions.length, 1)
  assert.equal(unknown.unknownPositions[0].distance, null)
  assert.equal(unknown.unknownPositions[0].dangerous, null)
})

test('species outside the explicit lists, explosive state, flying and boss policies stay unchanged', () => {
  for (const [name, radius] of [['wither_skeleton',12],['cave_spider',12],['ravager',12],['creeper',8],['phantom',32],['vex',12],['blaze',56],['ghast',72],['warden',32],['wither',32],['ender_dragon',32]]) {
    const value=entry(state(7),actor(name,30));assert.equal(value.dangerRadius,radius,name);assert.equal(value.riskAccepted,undefined);assert.equal(value.legacyRadius,undefined)
  }
})

test('a raw Skeleton at twelve metres is now a canonical threat while preserving its received hostile identity', () => {
  const entity=actor('skeleton',12), original=structuredClone(entity), value=evaluateThreats(state(7),[entity])
  assert.equal(value.threats.length,1);assert.equal(value.outsideDanger.length,0);assert.equal(value.threats[0].hostile,true)
  assert.equal(value.threats[0].distance,12);assert.equal(value.threats[0].category,'ranged');assert.equal(value.threats[0].name,'minecraft:skeleton')
  assert.equal(value.threats[0].runtimeId,entity.runtimeId);assert.deepEqual(entity,original)
})

test('known twelve-metre Skeleton blocks wood work and an unknown position still requires observation', async t => {
  const { createAutonomy } = require('../src/autonomy')
  for (const unknown of [false, true]) {
    const s = { ...state(7), phase:'spawned', profile:'bot', realm:{id:'21225335'}, connectionId:'fixture', startedAt:'fixture', runtimeEntityId:'1', inventory:{known:true,items:[]}, entities:[actor('skeleton',12,unknown?{positionKnown:false,position:null}:{})], idleProtection:{running:true,wanted:true,busy:false,phase:'observing'} }
    let woodActions = 0
    const agent = createAutonomy({getState:()=>structuredClone(s),observe:()=>({blocks:[]}),planAction:()=>({type:'break_block',stage:'logs',reason:'known wood fixture'}),actions:{break_block:()=>{woodActions++;return{phase:'completed'}}},intervalMs:60000})
    t.after(()=>agent.stop());agent.start({objective:'diamond'});await agent.tick();assert.equal(woodActions,0)
    agent.stop()
  }
})
