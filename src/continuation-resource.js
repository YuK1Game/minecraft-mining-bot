'use strict'

const { isDeepStrictEqual } = require('node:util')
const { nextBootstrapAction, inventoryCounts } = require('./planner')
const { nextDiamondAction } = require('./diamond-planner')
const { isSupportedFood } = require('./food')
const { evaluateThreats } = require('./threats')
const { continuationScope } = require('./base-continuation')
const name = value => String(value ?? '').replace(/^minecraft:/,'')
const amount = n => Number.isSafeInteger(n) && n > 0 ? n : 0
const RAW_IRON = new Set(['raw_iron','iron_ingot','iron_ore','deepslate_iron_ore'])
const LIMITS = Object.freeze({food:8,logs:16,stone:64,iron:16})
const TOOLS = /^(?:wooden|stone|iron|golden|diamond|netherite)_pickaxe$/
const SHORTCUTS = n => TOOLS.test(n) || /_planks$/.test(n) || ['stick','crafting_table'].includes(n)

// Planning only. Classification views never leave this function: the actual
// state, blocks, progress and exclusions remain untouched, and every emitted
// executor action still revalidates current equipment, terrain and inventory.
function planContinuationResource ({state,observations={},intent,options={}}) {
  const items=Array.isArray(state?.inventory?.items)?state.inventory.items:[]
  const sum=predicate=>items.reduce((n,i)=>n+(predicate(name(i.name),i)?amount(i.count):0),0)
  const counts={...inventoryCounts(items),food:sum((n,i)=>isSupportedFood(i.name,state)),iron:sum(n=>RAW_IRON.has(n)),ironIngots:sum(n=>n==='iron_ingot'),rawIron:sum(n=>RAW_IRON.has(n)&&n!=='iron_ingot'),coal:sum(n=>n==='coal'),charcoal:sum(n=>n==='charcoal'),diamond:sum(n=>n==='diamond')}
  const resource=intent?.resource,scope=continuationScope(state),requested=intent?.targetCount
  const result=(type,code,reason,extra={})=>({type,stage:'continuation',code,reason,counts:{...counts},continuous:true,scope,...extra})
  if (!Object.hasOwn(LIMITS,resource) || intent?.kind!=null&&intent.kind!=='work' || !Number.isSafeInteger(requested) || requested<1 || requested>4096) return result('wait','invalid_continuation_resource','A supported resource and bounded actual-inventory target are required')
  if (!scope || intent.scope!=null&&!isDeepStrictEqual(scope,intent.scope)) return result('wait','continuation_scope_changed','The current full living session must match the work intent')
  if (state.inventory?.known!==true || state.inventory.uncertain || state.inventory.source==='client_prediction') return result('wait','inventory_unknown','Wait for actual current inventory')
  if (![0,'survival'].includes(state.gameMode)) return result('wait','unsupported_game_mode','Continuation uses ordinary survival resource actions')
  const occupied=new Set(items.filter(i=>i.count>0&&Number.isInteger(i.slot)).map(i=>i.slot)).size
  if(state.inventory.full||occupied>=36)return result('wait','inventory_full','Unload through the verified depot before gathering')
  if(state.world?.initialized===false||state.world?.loadedSections===0||observations.worldLoaded===false)return result('wait','world_not_loaded','Read current received terrain before resource work')
  const busy=[state.task,state.mining,state.crafting,state.interactions,state.food,state.foraging,state.walking,state.movement,observations.task].some(t=>t?.busy===true||t?.running===true||t?.pendingRequestId!=null||t?.pendingOperation!=null)
  if(busy)return result('wait','task_in_progress','Let the current ordinary controller finish first')
  const actors=[observations.entities,state.entities,state.hostiles,state.nearbyHostiles].find(Array.isArray),threats=evaluateThreats(state,actors,{observationRadius:32})
  if(threats.requiresObservation||threats.threats.length||state.entityStats?.unknownPositions>threats.unknownPositions.length)return result('wait','continuation_safety','Existing safety and actor observation precede resource work')
  const current=counts[resource],target=Math.min(requested,current+LIMITS[resource]),remaining=Math.max(0,target-current)
  const continuation={resource,currentCount:current,targetCount:target,requestedTargetCount:requested,remaining,maxGain:LIMITS[resource],requiresActualInventory:true}
  const decorate=action=>{
    if(!action||typeof action.type!=='string')return result('wait','resource_plan_unavailable','The existing resource planner returned no action',{continuation})
    if(action.type==='complete')return result('wait','continuation_resource_recheck','Reobserve actual resource inventory before choosing the next bounded work goal',{continuation,goal:{[resource]:target}})
    return {...action,counts:{...counts},goal:{[resource]:target},scope,continuous:true,continuation,requiresLivePreview:true,...(action.proposedAction?{proposedAction:decorate(action.proposedAction)}:{})}
  }
  if(!remaining)return result('wait','continuation_resource_satisfied','This resource target is present in actual inventory; choose the next continuation priority',{continuation,goal:{[resource]:target},resourceGoalMet:true})
  if(resource==='food'){
    // Existing Foraging intentionally stops once ANY supported food is held.
    // A larger stockpile is advisory; never hide real food to force a hunt.
    if(current>0)return result('wait','continuation_food_reserve_deferred','Owned food blocks the existing zero-food foraging routine; skip this advisory reserve until ordinary eating makes it eligible',{continuation,continuationDeferred:true,skipAdvisoryReserve:true})
    const preview=observations.foragingPreview??observations.foraging?.preview
    if(!preview||preview.ready!==true)return result('wait',preview?.code??'foraging_preview_required','Use the existing live foraging preview and nutrition admission before dispatch',{continuation,requiresForagingPreview:true,continuationDeferred:true,skipAdvisoryReserve:true})
    return decorate({type:'forage',stage:'food',purpose:'food',resource:'food',reason:'Obtain actual food through the existing bounded foraging controller',count:remaining,requiresNutritionAdmission:true,foragingOptions:{maxSteps:3,maxHits:3,timeoutMs:30000}})
  }
  if(resource==='iron')return decorate(nextDiamondAction(state,observations,{...options,reserveResource:'iron',reserveCount:target}))
  if(resource==='stone')return decorate(nextBootstrapAction(state,observations,{...options,stoneCount:target}))

  // Bootstrap's normal purpose is tool acquisition, so its owned pickaxe,
  // boards/sticks/table and historical logsCollected shortcuts would bypass
  // a raw-log reserve. Hide ONLY those classifications in private copies.
  // Actual logs and every original exclusion remain. stoneCount=current+1 is
  // only the Bootstrap completion sentinel, never an emitted resource goal.
  const privateState={...state,inventory:{...state.inventory,items:items.filter(i=>!SHORTCUTS(name(i.name)))},heldItem:state.heldItem&&SHORTCUTS(name(state.heldItem.name))?null:state.heldItem}
  const blocks=Array.isArray(observations.blocks)?observations.blocks:observations.world?.blocks
  const privateObservations={...observations,craftingTable:null,progress:{...observations.progress,logsCollected:0},...(blocks?{blocks:blocks.map(b=>name(b.name)==='crafting_table'?{...b,name:'minecraft:barrier'}:b)}:{})}
  return decorate(nextBootstrapAction(privateState,privateObservations,{...options,logCount:target,stoneCount:counts.stone+1,starterGearPickup:false}))
}
module.exports={planContinuationResource}
