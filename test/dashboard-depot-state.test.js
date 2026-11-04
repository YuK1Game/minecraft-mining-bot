'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {sanitizeStatus,sanitizeCachedStatus}=require('../scripts/lib/dashboard-state')
const at='2026-11-01T15:01:57.000Z'
const live=()=>({phase:'spawned',health:20,playerName:'HouchiChan',realm:{name:'YuK1Game'},position:{x:1,y:43.62,z:2},positionSource:'client_prediction',inventory:{known:true,items:[{name:'minecraft:diamond',count:1}]},depotMission:{enabled:true,busy:true,phase:'return_surface',policy:{phase:'return_surface',deposited:0,depositConfirmedForCurrentLife:false,base:null,chest:null}}})
const mission={version:1,work:{title:'古いダイヤ目標完了',state:'complete'},milestones:[{id:'diamond',label:'旧目標',status:'done'}]}
test('actual mission phases override old goal-complete prose with seven compact return/base/chest/deposit/continuous steps',()=>{
 for(const [phase,title,id] of [['return_surface','地上','return'],['establish_base','拠点','base'],['ensure_chest','チェスト','chest'],['deposit_diamond','保管','deposit']]){
  const raw=live();raw.depotMission.phase=phase;const d=sanitizeStatus(raw,{observedAt:at,mission})
  assert.match(d.work.title,new RegExp(title));assert.notEqual(d.work.state,'complete');assert.equal(d.work.state,'running')
  assert.equal(d.milestones.length,7);assert.equal(d.milestones.find(s=>s.id===id).status,'active')
  assert.equal(d.position.y,42);assert.equal(d.position.confirmed,false)
 }
})
test('actual current-life secured deposit displays continued work without inventing a carried diamond or base usability',()=>{
 const raw=live();raw.inventory.items=[];raw.depotMission={enabled:true,busy:false,phase:'work',lastIntent:{resource:'logs'},policy:{phase:'continuous',deposited:1,depositConfirmedForCurrentLife:true,base:{id:'known'},chest:{position:{x:3,y:67,z:0}}}}
 const d=sanitizeStatus(raw,{observedAt:at,mission})
 assert.equal(d.online,true);assert.equal(d.work.state,'running');assert.match(d.work.title,/継続/)
 assert.deepEqual(d.inventory,[]);assert.equal(d.depotMission.deposited,1);assert.equal(d.depotMission.secured,true)
 assert.equal(d.milestones.find(s=>s.id==='deposit').status,'done');assert.equal(d.milestones.find(s=>s.id==='continuous').status,'active')
 assert.equal(d.milestones.find(s=>s.id==='base').status,'history');assert.equal(d.hut.known,false)
})
test('offline/dead/unknown inventory preserves historical labeling and never makes an online or current storage-complete claim',()=>{
 const raw=live();raw.inventory.items=[];raw.depotMission.phase='work';raw.depotMission.policy.deposited=1;raw.depotMission.policy.depositConfirmedForCurrentLife=true
 const d=sanitizeStatus(raw,{observedAt:at}),cached=sanitizeCachedStatus(d,{checkedAt:'2026-11-01T15:05:00Z'})
 assert.equal(cached.online,false);assert.equal(cached.stale,true);assert.notEqual(cached.work.state,'complete')
 assert.equal(cached.milestones.find(s=>s.id==='deposit').status,'history')
 raw.inventory.known=false;const unknown=sanitizeStatus(raw,{observedAt:at});assert.notEqual(unknown.milestones.find(s=>s.id==='deposit').status,'done')
 raw.health=0;const dead=sanitizeStatus(raw,{observedAt:at});assert.equal(dead.online,false);assert.equal(dead.depotMission.secured,false);assert.match(dead.work.title,/復帰/)
})
test('mapping whitelists public mission fields, disabled stays stopped, and minimal inline UI script remains valid',()=>{
 const raw=live();raw.depotMission.enabled=false;raw.depotMission.auth='do-not-publish';raw.depotMission.policy.base={secret:'private-base-extra'}
 const d=sanitizeStatus(raw,{observedAt:at,mission});assert.equal(d.work.state,'stopped')
 assert.doesNotMatch(JSON.stringify(d),/do-not-publish|private-base-extra/)
 const file=process.env.DEPOT_DASHBOARD_HTML??path.resolve(__dirname,'../dashboard/index.html'),html=fs.readFileSync(file,'utf8')
 for(const [i,match]of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries())new vm.Script(match[1],{filename:'dashboard-inline-'+i})
 assert.match(html,/id="goal-caption"/);assert.match(html,/stored \? '保管確認' : '実所持'/)
 assert.match(html,/100dvh/);assert.doesNotMatch(html,/\/action|\/respawn|\/agent\/start/)
})
