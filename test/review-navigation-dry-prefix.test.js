'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createNavigator } = require('../src/navigation')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const capturedState = {"position":{"x":2041.378173828125,"y":64.62,"z":2019.3363037109375},"positionSource":"client_prediction","predicted":{"position":{"x":2041.378173828125,"y":64.62,"z":2019.3363037109375},"feetPosition":{"x":2041.378173828125,"y":63,"z":2019.3363037109375},"velocity":{"x":0,"y":-0.0784000015258789,"z":0},"onGround":true,"physicsState":{"position":{"x":2041.378173828125,"y":63,"z":2019.3363037109375},"velocity":{"x":0,"y":-0.0784000015258789,"z":0},"velocitySource":"client_prediction","yaw":-144.01719508520569,"pitch":4.027868131189962,"gameMode":"survival","onGround":true,"isInWater":false,"isInLava":false,"isInWeb":false,"isCollidedHorizontally":false,"isCollidedVertically":true,"jumpTicks":0,"jumpQueued":false,"controls":{"forward":false,"back":false,"left":false,"right":false,"jump":false,"sprint":false,"sneak":false},"effects":{},"attributes":{},"contactAdjustment":null,"horizontalContactAdjustment":null},"source":"client_prediction","serverConfirmed":false,"updatedAt":"2026-11-12T07:34:21.326Z"},"rotation":{"pitch":19.375640869140625,"yaw":-114.76792907714844},"gameMode":"survival"}
const target = {"x":2040.5,"y":63,"z":2016.5}
const observedBlocks = [
{"known":true,"position":{"x":2039,"y":61,"z":2016},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2039,"y":61,"z":2019},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2039,"y":62,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":62,"z":2018},"name":"minecraft:water","runtimeId":1273336625,"properties":{"liquid_depth":3},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":62,"z":2019},"name":"minecraft:water","runtimeId":965962510,"properties":{"liquid_depth":4},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":63,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":63,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":63,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":64,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":64,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":64,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":65,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2039,"y":65,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":61,"z":2016},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":61,"z":2017},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":61,"z":2018},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":61,"z":2019},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":61,"z":2020},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":62,"z":2016},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2040,"y":62,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":62,"z":2018},"name":"minecraft:water","runtimeId":1334811448,"properties":{"liquid_depth":2},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":62,"z":2019},"name":"minecraft:water","runtimeId":1273336625,"properties":{"liquid_depth":3},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":62,"z":2020},"name":"minecraft:water","runtimeId":1334811448,"properties":{"liquid_depth":2},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":63,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":63,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":63,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":63,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":63,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":64,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":64,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":64,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":64,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":64,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":65,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":65,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":65,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":65,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2040,"y":65,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":60,"z":2017},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":60,"z":2018},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2016},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2017},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2018},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2019},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2020},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":61,"z":2021},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2015},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2016},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2017},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2018},"name":"minecraft:water","runtimeId":1150386979,"properties":{"liquid_depth":1},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2019},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2020},"name":"minecraft:water","runtimeId":1150386979,"properties":{"liquid_depth":1},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":62,"z":2021},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2015},"name":"minecraft:chest","runtimeId":3162850062,"properties":{"minecraft:cardinal_direction":"north"},"boundingBox":"block","hardness":2.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":63,"z":2021},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2015},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":64,"z":2021},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2015},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2041,"y":65,"z":2021},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":61,"z":2016},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":61,"z":2017},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":61,"z":2018},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":61,"z":2020},"name":"minecraft:dirt","runtimeId":2186211206,"properties":{},"boundingBox":"block","hardness":0.5,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":62,"z":2016},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":62,"z":2017},"name":"minecraft:grass_block","runtimeId":3727763636,"properties":{},"boundingBox":"block","hardness":0.6,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":62,"z":2018},"name":"minecraft:water","runtimeId":1211861802,"properties":{"liquid_depth":0},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":62,"z":2019},"name":"minecraft:water","runtimeId":1211861802,"properties":{"liquid_depth":0},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":62,"z":2020},"name":"minecraft:water","runtimeId":1211861802,"properties":{"liquid_depth":0},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":63,"z":2016},"name":"minecraft:wildflowers","runtimeId":1048776783,"properties":{"growth":1,"minecraft:cardinal_direction":"east"},"boundingBox":"empty","hardness":0,"diggable":true,"extra":[]},
{"known":true,"position":{"x":2042,"y":63,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":63,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":63,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":63,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":64,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":64,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":64,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":64,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":64,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":65,"z":2016},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":65,"z":2017},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":65,"z":2018},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":65,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2042,"y":65,"z":2020},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2043,"y":61,"z":2019},"name":"minecraft:water","runtimeId":1211861802,"properties":{"liquid_depth":0},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2043,"y":62,"z":2019},"name":"minecraft:water","runtimeId":1211861802,"properties":{"liquid_depth":0},"boundingBox":"empty","hardness":100,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2043,"y":63,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2043,"y":64,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]},
{"known":true,"position":{"x":2043,"y":65,"z":2019},"name":"minecraft:air","runtimeId":3690217760,"properties":{},"boundingBox":"empty","hardness":-1,"diggable":false,"extra":[]}
]

function historicalNavigator () {
  const file = path.resolve(__dirname, '../src/navigation.js'), source = fs.readFileSync(file, 'utf8')
  const binding = /^([ \t]*const nearDryPulse = )(?:!allowWater && )?/gm
  assert.equal([...source.matchAll(binding)].length, 1, 'the counterfactual changes only the water-capability gate')
  const loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  loaded._compile(source.replace(binding, '$1!allowWater && '), file)
  return loaded.exports.createNavigator
}
function fixture (factory = createNavigator) {
  const blocks = new Map(observedBlocks.map(block => [key(block.position), block])), changes = new Map()
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? blocks.get(`${x},${y},${z}`) ?? { known: false } }
  const navigator = factory({ world, allowWater: true }), initial = navigator.physics.fromServer(copy(capturedState))
  const route = navigator.plan(initial, target, { maxDistance: 6, maxExpanded: 1500 })
  assert.equal(route.ready, true, route.reason)
  assert.deepEqual(route.waypoints.map(row => [row.action, row.medium, row.position.x, row.position.y, row.position.z]), [
    ['walk', 'land', 2041.5, 63, 2019.5], ['swim', 'water', 2041.5, 63, 2018.5],
    ['swim', 'land', 2041.5, 63, 2017.5], ['walk', 'land', 2041.5, 63, 2016.5], ['walk', 'land', 2040.5, 63, 2016.5]
  ])
  return { navigator, initial, route, changes, stepper: navigator.createStepper(route, initial, { maxTicks: 120, sprint: false }) }
}
function run (stepper) {
  const frames = []
  for (let tick = 0; tick < 120; tick++) { const frame = stepper.next(); frames.push(frame); if (frame.phase !== 'moving') break }
  return frames
}

test('the actual mixed-route origin reproduces 52 neutral frames with the historical global dry-only gate', () => {
  const f = fixture(historicalNavigator()), before = copy(f.initial), frames = run(f.stepper)
  assert.equal(frames.length, 52); assert.equal(frames.at(-1).phase, 'failed'); assert.match(frames.at(-1).reason, /no progress/i)
  assert.ok(frames.every(frame => !frame.controls.forward && !frame.controls.back && !frame.controls.sprint))
  assert.ok(frames.every(frame => frame.predictedState.position.x === before.position.x && frame.predictedState.position.z === before.position.z && Math.abs(frame.predictedState.position.y - before.position.y) < 1e-6))
  assert.deepEqual(f.initial, before)
})

test('actual Native dry first-waypoint pulse progresses into the unchanged ordinary water route without claiming arrival', () => {
  const f = fixture(), before = copy(f.initial), frames = run(f.stepper)
  assert.equal(frames[0].controls.forward, true)
  assert.equal(frames[0].controls.jump, false); assert.notEqual(frames[0].controls.sprint, true)
  assert.notDeepEqual(frames[0].predictedState.position, before.position)
  assert.equal(frames[0].predictedState.onGround, true); assert.equal(frames[0].predictedState.isInWater, false)
  assert.ok(frames.some(frame => frame.predictedState.isInWater === true))
  assert.equal(frames.at(-1).phase, 'awaiting_server_confirmation', frames.at(-1).reason)
  assert.ok(Math.hypot(frames.at(-1).predictedState.position.x - target.x, frames.at(-1).predictedState.position.z - target.z) <= 0.35)
  assert.ok(frames.every(frame => frame.serverConfirmed === false)); assert.deepEqual(f.initial, before)
})

for (const mode of ['unknownWater', 'lavaWater', 'unknownHead']) test(`${mode} at the next water waypoint still stops Native before entering it`, () => {
  const f = fixture(); let frame
  do { frame = f.stepper.next() } while (frame.phase === 'moving' && frame.waypointIndex === 0)
  assert.equal(frame.phase, 'moving'); assert.equal(frame.waypointIndex, 1)
  if (mode === 'unknownHead') f.changes.set('2041,64,2018', { known: false })
  else f.changes.set('2041,62,2018', mode === 'unknownWater' ? { known: false } : { known: true, name: 'minecraft:lava', properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] })
  const prior = copy(frame.predictedState.position), stopped = f.stepper.next()
  assert.equal(stopped.phase, 'failed'); assert.equal(stopped.serverConfirmed, false)
  assert.deepEqual(stopped.predictedState.position, prior)
  assert.notEqual(stopped.controls.forward, true)
})
