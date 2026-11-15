'use strict'
const { continuationScope } = require('./base-continuation')
const { inventoryCounts } = require('./planner')
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
// Optional transport only: no base, inventory, arrival or storage credit.
function createOwnedCampBootstrap({getState,isHeld,isIdle,prepare,takeover,execute,clock=Date.now,memo=null}) {
  const retained=memo&&typeof memo.scope==='string'&&Number.isSafeInteger(memo.prefixes)&&memo.prefixes>=0&&memo.prefixes<=8
  let done=retained&&memo.done===true,attempts=retained&&Number.isSafeInteger(memo.attempts)&&memo.attempts>=0&&memo.attempts<=8?memo.attempts:0
  let scopeKey=retained?memo.scope:null,prefixes=retained?memo.prefixes:0,retryAt=retained&&Number.isFinite(memo.retryAt)?Math.min(memo.retryAt,clock()+30000):0,busy=false,lastReason=null
  const snapshot=()=>({scope:scopeKey,prefixes,attempts,done,routingOnly:true,retryAt,busy,lastReason,maxPrefixes:8,maxAttempts:8})
  async function step(context) {
    const state=getState(),scope=continuationScope(state),key=JSON.stringify(scope)
    if(key!==scopeKey){scopeKey=key;prefixes=0;attempts=0;done=false;retryAt=0;lastReason=null}
    const memory=context.policy.memo(),camp=context.extra?.campBuilder
    if(!scope||context.signal.aborted||isHeld()||!same(scope,context.scope)||state.inventory?.known!==true||state.inventory.uncertain||state.inventoryConfidence?.known===false||!memory.base||!memory.chest||memory.deposited!==0||camp?.kind!=='worksite_camp'||memory.base.id!==camp.id||!camp.tableCell||!state.position)return {handled:false}
    const materials=inventoryCounts(state.inventory.items??[]),iron=(state.inventory.items??[]).reduce((n,i)=>n+(i.name==='minecraft:iron_ingot'&&Number.isSafeInteger(i.count)&&i.count>0?i.count:0),0)
    // Route home only with stock for an existing table recipe (or one log's boards/sticks).
    if(!(materials.logs>=1||materials.planks>=4||materials.planks>=2&&materials.sticks>=1||materials.stone>=2&&(materials.sticks>=1||materials.planks>=2)||materials.stone>=8||iron>=3&&(materials.sticks>=2||materials.planks>=2)))return {handled:false}
    const distance=Math.hypot(state.position.x-camp.tableCell.x-.5,state.position.y-1.62-camp.tableCell.y,state.position.z-camp.tableCell.z-.5)
    if(done||distance>48||prefixes>=8||attempts>=8||clock()<retryAt||busy||!isIdle())return {handled:false}
    const before={scope,health:state.health,position:{...state.position}}
    busy=true
    try{
      attempts++
      if(attempts>=8)done=true
      const prepared=await prepare(context)
      if(prepared?.nearbyValidated===true){done=true;lastReason='near_camp_routing_complete';return {handled:false}}
      if(!prepared?.ready){lastReason=prepared?.reason??prepared?.code??'camp_route_unproven';retryAt=clock()+30000;return {handled:false,reason:lastReason}}
      const current=getState()
      if(context.signal.aborted||isHeld()||!same(continuationScope(current),before.scope)||current.health<before.health||Math.hypot(current.position.x-before.position.x,current.position.y-before.position.y,current.position.z-before.position.z)>.1||!isIdle())return {handled:false}
      // Stop/drain logical Legacy only after a current ordinary route exists.
      if(!await takeover(context,before))return {handled:false}
      prefixes++
      const result=await execute(prepared,context)
      if(!same(continuationScope(getState()),scope)||getState().health<before.health)throw Error('Camp bootstrap scope or health changed')
      lastReason=null
      return {handled:true,result:{...result,phase:'bootstrap_at_owned_camp',serverConfirmed:false,inventoryConfirmed:false,reachedCamp:false,requiresObservation:true}}
    }catch(error){
      lastReason=String(error.message??error).slice(0,200);retryAt=clock()+30000
      if(context.signal.aborted)throw error
      return {handled:false,reason:lastReason}
    }finally{busy=false}
  }
  return {step,snapshot}
}
module.exports={createOwnedCampBootstrap}
