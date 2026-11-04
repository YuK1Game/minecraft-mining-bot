'use strict'
const {isDeepStrictEqual:same}=require('node:util')
const {knownStandpoints}=require('./exploration')
const {continuationScope}=require('./base-continuation')
const {evaluateThreats}=require('./threats')
const finite=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]))
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const near=(a,b,r)=>Math.abs(a.y-b.y)<.75&&Math.hypot(a.x-b.x,a.z-b.z)<r

// Camp discovery endpoints only. Bounds apply BEFORE scoring/truncation, unlike
// global exploration's 8..11m outer ring. The actual runner must still perform
// its ordinary current-scope Native preview and execution; no blocks are changed.
function rankCampResourceTargets({state,observations={},surface,history=[],limit=20}={}){
 const scope=continuationScope(state),feet=finite(state?.position)?{...state.position,y:state.position.y-1.62}:null
 if(!scope||!feet||!same(surface?.scope,scope)||!finite(surface.position)||distance(feet,surface.position)>8||state.inventory?.known!==true||state.inventory.uncertain||state.entityStats?.unknownPositions!==0||!Array.isArray(state.entities))return[]
 if(observations.state&&(!same(continuationScope(observations.state),scope)||distance(observations.state.position,state.position)>.4))return[]
 const evaluated=evaluateThreats(state,state.entities,{observationRadius:32})
 if(evaluated.requiresObservation||evaluated.threats.length)return[]
 const blocks=Array.isArray(observations.blocks)?observations.blocks:observations.world?.blocks
 if(!Array.isArray(blocks))return[]
 const knownLogs=blocks.filter(b=>b.known===true&&finite(b.position)&&/^minecraft:[a-z_]+_log$/.test(b.name??'')&&!b.protected&&!b.protectionSource&&b.natural!==false&&!b.extra?.length).map(b=>({x:b.position.x+.5,y:b.position.y+.5,z:b.position.z+.5}))
 const targets=knownLogs.filter(p=>distance(p,feet)<=8&&distance(p,surface.position)<=8)
 const minimum=(p)=>targets.length?Math.min(...targets.map(t=>distance(p,t))):null
 const initial=minimum(state.position),recent=(Array.isArray(history)?history:[]).filter(h=>finite(h?.position))
 return knownStandpoints(state,observations,{minDistance:1,maxDistance:8,maxHeightDelta:3,limit:2000})
  .filter(c=>distance(c.position,feet)<=8&&distance(c.position,surface.position)<=8)
  .filter(c=>!recent.some(h=>['blocked','attempt'].includes(h.kind)&&near(h.position,c.position,1.5))&&!recent.some(h=>['visited','origin'].includes(h.kind)&&near(h.position,c.position,.75)))
  .map(c=>{const eye={...c.position,y:c.position.y+1.62},gain=targets.length?initial-minimum(eye):0;return{...c,resource:'logs',mode:'camp_local',resourceDistanceGain:gain,score:gain*2+Math.max(0,c.heightDelta)*.5+c.frontierUnknown*.1+c.safeNeighbours*.08-c.distance*.03,requiresLivePreview:true,predictionOnly:true,serverConfirmed:false}})
  .sort((a,b)=>b.score-a.score||a.position.x-b.position.x||a.position.z-b.position.z)
  .slice(0,Math.min(20,Number.isInteger(limit)&&limit>0?limit:20))
}
module.exports={rankCampResourceTargets}
