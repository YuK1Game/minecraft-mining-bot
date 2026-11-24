'use strict'

const { playerStageView } = require('../../src/modes/player-stage-view')

// Player mode on the dashboard: the sanitized mode status and the one line it
// puts in the activity band ("今していること").
const text = (value, max = 160) => typeof value === 'string' && value ? value.replace(/[\p{C}§]/gu, ' ').slice(0, max) : null

function modeState (input) {
  if (!input || typeof input !== 'object' || !['quarry', 'player'].includes(input.mode)) return null
  const player = input.player && typeof input.player === 'object' ? input.player : {}
  const decision = text(player.decision)
  return { mode: input.mode, player: { running: player.running === true, phase: text(player.phase, 40), reason: text(player.reason), ...(decision ? { decision } : {}), current: text(player.current, 40), stages: playerStageView(player.stages) } }
}

// null unless player mode is selected; the quarry lines apply otherwise.
function playerActivity (mode) {
  if (mode?.mode !== 'player') return null
  const player = mode.player, stage = player.stages.find(item => item.id === player.current)
  const goal = stage ? `目標: ${stage.label}` : null
  if (player.running) return { kind: 'busy', label: player.phase === 'waiting' ? 'プレイヤーモード: 待機中' : player.phase === 'recovering' ? 'プレイヤーモード: 立て直し中' : player.phase === 'sheltering' ? 'プレイヤーモード: 避難中' : player.phase === 'fleeing' ? 'プレイヤーモード: 退避中' : 'プレイヤーモード: 行動中', detail: player.reason ?? player.decision ?? goal, code: null }
  if (player.phase === 'completed') return { kind: 'idle', label: 'プレイヤーモード: 帰還完了', detail: player.reason, code: null }
  if (player.phase === 'failed' || player.phase === 'blocked') return { kind: 'error', label: 'プレイヤーモード: 停止', detail: player.reason, code: null }
  return { kind: 'idle', label: '待機中: プレイヤーモードの開始待ち', detail: goal, code: null }
}

module.exports = { modeState, playerActivity }
