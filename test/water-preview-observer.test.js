'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{createWaterPreviewObserver}=require('../src/water-preview-observer')
test('Records the actual existing state read only after preview returns, preserving object identity and arguments',()=>{
 let observer,reads=0,returned=false,published,originalCalls=0
 const state={profile:'synthetic_test',realm:{id:'fixture'},connectionId:'fixture',startedAt:'2026-01-01T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',phase:'spawned',health:12,positionSource:'client_prediction',position:{x:1,y:64.62,z:1},predicted:{position:{x:1,y:64.62,z:1},physicsState:{position:{x:1,y:63,z:1},velocity:{x:0,y:0,z:0},onGround:false,isInWater:true}}},target={x:2,y:63,z:1},options={allowWater:true,directSurface:true},result={ready:true,directSurface:false,origin:{x:1,y:63,z:1},waypoints:[{position:target,medium:'water',action:'swim'}]}
 observer=createWaterPreviewObserver({preview:(a,b)=>{originalCalls++;assert.equal(a,target);assert.equal(b,options);reads++;observer.captureState(state);returned=true;return result},publish:o=>{assert(returned);published=o},getLife:()=>28,getGeneration:()=>31})
 assert.equal(observer.preview(target,options),result);assert.equal(reads,1);assert.equal(originalCalls,1);assert.equal(published.result.directSurface,false);assert.equal(published.request.flags.directSurface,true);assert.equal(published.stateRead.isInWater,true);assert.equal(published.stateRead.seedMatchesPosition,true);assert.equal(published.stateRead.feetMatchPosition,true);assert.equal(published.scope.life,28)
})
test('Non-water previews do not publish; observation failures do not replace return or original errors',()=>{
 const originalError=Error('synthetic_original_failure');let count=0
 const plain=createWaterPreviewObserver({preview:()=>17,publish:()=>{count++;throw Error('sink')}})
 assert.equal(plain.preview({},{}),17);assert.equal(count,0);assert.equal(plain.preview({},{allowWater:true}),17);assert.equal(count,1)
 const failed=createWaterPreviewObserver({preview:()=>{throw originalError},publish:()=>{throw Error('sink')}})
 assert.throws(()=>failed.preview({},{allowWater:true}),e=>e===originalError)
})
test('Observed route/avoidance summaries are bounded and do not mutate source arrays',()=>{
 const rows=Array.from({length:1000},()=>({id:'x'.repeat(1000),position:{x:1,y:2,z:3},minDistance:10})),route={ready:true,waypoints:rows.map(()=>({position:{x:1,y:2,z:3},action:'swim',medium:'water'}))};let received
 const p=createWaterPreviewObserver({preview:()=>route,publish:o=>{received=o}})
 assert.equal(p.preview(null,{allowWater:true,avoidance:rows}),route);assert.equal(rows.length,1000);assert.equal(route.waypoints.length,1000);assert.equal(received.truncated,true);assert(Buffer.byteLength(JSON.stringify(received),'utf8')<=24576);assert.equal(received.request.avoidanceCount,1000);assert.equal(received.result.waypointCount,1000)
})
