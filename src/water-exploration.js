'use strict'
const {isDeepStrictEqual:same}=require('node:util')
const {continuationScope}=require('./base-continuation')
const {evaluateThreats}=require('./threats')
const finite=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k])),key=p=>`${p.x},${p.y},${p.z}`
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const OPEN=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air','minecraft:short_grass','minecraft:fern','minecraft:leaf_litter','minecraft:deadbush','minecraft:torch'])
const GROUND=/^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite)$/
const open=b=>b?.known===true&&OPEN.has(b.name)&&b.boundingBox==='empty'&&!b.extra?.length
const floor=b=>b?.known===true&&GROUND.test(b.name)&&b.boundingBox==='block'&&!b.extra?.length&&!b.protected&&!b.protectionSource&&b.natural!==false&&(b.shapes==null||Array.isArray(b.shapes)&&b.shapes.some(s=>Array.isArray(s)&&s.length===6&&s.every((v,i)=>v===(i<3?0:1))))
const water=b=>b?.known===true&&/^minecraft:(?:flowing_)?water$/.test(b.name)&&!b.extra?.length&&!(Number.isInteger(b.properties?.liquid_depth)&&b.properties.liquid_depth>=8)
function waterExplorationAdmission(state,scope=null){
 const current=continuationScope(state)
 if(!current||scope&&!same(scope,current)||!['survival',0].includes(state.gameMode)||state.health<14||!(state.food?.hunger>=10)||!(state.breath?.current>=state.breath?.maximum)||!(state.breath.maximum>0)||state.inventory?.known!==true||state.inventory.uncertain||state.entityStats?.unknownPositions!==0||!Array.isArray(state.entities))return null
 const e=evaluateThreats(state,state.entities,{observationRadius:32})
 if(e.requiresObservation||e.threats.length)return null
 const actors=[...e.outsideDanger,...e.suppressedByTerrain]
 if(actors.some(a=>!state.entities.some(v=>String(v.runtimeId)===a.runtimeId&&v.uniqueId!=null&&v.entityType===a.name&&v.dimension===state.dimension&&v.positionKnown===true&&finite(v.position))))return null
 return{scope:current,avoidance:actors.map(a=>({id:a.runtimeId,position:{...a.position},minDistance:a.dangerRadius,padding:0}))}
}
// Endpoints only; every actual move still uses the existing ordinary Native
// preview/executor. Dry exploration and its history are not rewritten.
function waterExplorationCandidates({state,observations,history=[],goal=null}={}){
 const admission=waterExplorationAdmission(state),physical=state?.predicted?.physicsState??state?.physicsState,feet=finite(state?.position)?{...state.position,y:state.position.y-1.62}:null
 if(!admission||!feet||physical?.onGround!==true||physical.isInWater||physical.isInLava||Math.abs(feet.y-Math.round(feet.y))>1e-4||!same(continuationScope(observations?.state),admission.scope)||distance(observations.state.position,state.position)>.4||!Array.isArray(observations.blocks))return null
 const y=Math.round(feet.y),map=new Map(observations.blocks.map(b=>[key(b.position),b])),at=(x,y,z)=>map.get(`${x},${y},${z}`)
 const body=(x,z)=>open(at(x,y,z))&&open(at(x,y+1,z))
 const supported=p=>{for(const dx of[-.2999,.2999])for(const dz of[-.2999,.2999]){const x=Math.floor(p.x+dx),z=Math.floor(p.z+dz);if(!floor(at(x,y-1,z))||!body(x,z))return false}return true}
 const adjacent=p=>[[1,0],[-1,0],[0,1],[0,-1]].some(([x,z])=>water(at(Math.floor(p.x)+x,y-1,Math.floor(p.z)+z))&&body(Math.floor(p.x)+x,Math.floor(p.z)+z))
 if(!supported(feet)||!adjacent(feet))return null
 const straight=p=>{let touchedWater=false;const steps=Math.ceil(distance(feet,p)/.2);for(let n=0;n<=steps;n++){const t=n/steps,point={x:feet.x+(p.x-feet.x)*t,z:feet.z+(p.z-feet.z)*t};for(const dx of[-.2999,.2999])for(const dz of[-.2999,.2999]){const x=Math.floor(point.x+dx),z=Math.floor(point.z+dz),b=at(x,y-1,z);if(!body(x,z)||!floor(b)&&!water(b))return false;if(water(b))touchedWater=true}}return touchedWater}
 const near=(a,b,r)=>Math.abs(a.y-b.y)<.75&&Math.hypot(a.x-b.x,a.z-b.z)<r
 const candidates=observations.blocks.filter(b=>floor(b)&&b.position.y===y-1).map(b=>({x:b.position.x+.5,y,z:b.position.z+.5})).filter(p=>distance(p,feet)>=1.5&&distance(p,feet)<=12&&supported(p)&&adjacent(p)&&straight(p))
  .filter(p=>!state.entities.some(a=>a.alive!==false&&a.kind!=='item'&&String(a.runtimeId)!==admission.scope.runtimeEntityId&&(a.positionKnown!==true||!finite(a.position)||Math.hypot(a.position.x-p.x,a.position.z-p.z)<1&&Math.abs(a.position.y-p.y)<3)))
  .filter(p=>!(Array.isArray(history)?history:[]).some(h=>finite(h?.position)&&(['visited','origin'].includes(h.kind)&&near(h.position,p,.75)||String(h.outcome??'').startsWith('water_')&&near(h.position,p,1.5))))
  .sort((a,b)=>(finite(goal)?distance(a,goal)-distance(b,goal):0)||distance(a,feet)-distance(b,feet)||a.x-b.x||a.z-b.z)
 const unique=[];for(const p of candidates)if(!unique.some(q=>distance(p,q)<1.5))unique.push(p)
 return{...admission,seaLevel:y,candidates:unique.slice(0,2)}
}
function validateWaterExplorationRoute(route,state,target){
 const admitted=waterExplorationAdmission(state)
 if(!admitted||route?.ready!==true||!Array.isArray(route.waypoints)||route.waypoints.length<1||route.waypoints.length>16||!route.waypoints.some(w=>w.medium==='water'))return false
 const points=[{...state.position,y:state.position.y-1.62},...route.waypoints.map(w=>w.position)]
 const origin=points[0],physical=state.predicted?.physicsState??state.physicsState,originAtSurface=Math.abs(origin.y-target.y)<=1e-4||physical?.isInWater===true&&origin.y>=target.y-1.6&&origin.y<=target.y+.5&&state.position.y>=target.y+.02
 if(!originAtSurface||points.some(p=>!finite(p))||points.slice(1).some(p=>Math.abs(p.y-target.y)>1e-4)||distance(points.at(-1),target)>.4||points.slice(1).reduce((n,p,i)=>n+distance(points[i],p),0)>12)return false
 for(let i=1;i<points.length;i++)for(const a of admitted.avoidance){const from={...points[i-1],y:points[i-1].y+1.62},to={...points[i],y:points[i].y+1.62},d={x:to.x-from.x,y:to.y-from.y,z:to.z-from.z},l=d.x*d.x+d.y*d.y+d.z*d.z,t=l?Math.max(0,Math.min(1,((a.position.x-from.x)*d.x+(a.position.y-from.y)*d.y+(a.position.z-from.z)*d.z)/l)):0;if(Math.hypot(a.position.x-from.x-d.x*t,a.position.y-from.y-d.y*t,a.position.z-from.z-d.z*t)<a.minDistance-1e-4)return false}
 return true
}
module.exports={waterExplorationAdmission,waterExplorationCandidates,validateWaterExplorationRoute}
