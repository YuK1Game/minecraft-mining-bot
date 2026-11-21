'use strict'

const {normalizeMode}=require('./bot-mode')
const MINERALS=new Set(['coal','iron','raw_iron','gold','raw_gold','diamond','redstone'])
const WORK=new Set(['mine_ore','tunnel','move_to','explore','prospect'])
const mineral=decision=>MINERALS.has(decision?.resource)

// The old autonomy still builds the first wood/stone tools and the house. Its ore decisions must not slip
// through a later target substitution while the expedition owns planned mining and delivery.
function withPlannedMine({mode,playing,decision}){
  if(normalizeMode(mode)!=='player' || playing!==true || !decision)return decision
  const proposed=decision.type==='capability_required'?decision.proposedAction:decision
  if(!mineral(proposed) || !WORK.has(proposed.type))return decision
  return {type:'wait',stage:'mine',resource:proposed.resource,code:'PLANNED_MINE_REQUIRED',reason:'資源は計画した2層の採掘場で集めます。拠点と初期道具の準備を確認しています。'}
}

module.exports={withPlannedMine,mineral}
