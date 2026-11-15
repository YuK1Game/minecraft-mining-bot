'use strict'

// Player mode on the dashboard: the sanitized mode status and the one line it
// puts in the activity band ("今していること").
const text = (value, max = 160) => typeof value === 'string' && value ? value.replace(/[\p{C}§]/gu, ' ').slice(0, max) : null

function modeState (input) {
  if (!input || typeof input !== 'object' || !['quarry', 'player'].includes(input.mode)) return null
  const player = input.player && typeof input.player === 'object' ? input.player : {}
  const stages = (Array.isArray(player.stages) ? player.stages : []).slice(0, 12).map(stage => ({ id: text(stage?.id, 40), label: text(stage?.label, 40), implemented: stage?.implemented === true, reached: stage?.reached === true }))
  return { mode: input.mode, player: { running: player.running === true, phase: text(player.phase, 40), reason: text(player.reason), current: text(player.current, 40), stages } }
}

// null unless player mode is selected; the quarry lines apply otherwise.
function playerActivity (mode) {
  if (mode?.mode !== 'player') return null
  const player = mode.player, stage = player.stages.find(item => item.id === player.current)
  const goal = stage ? `目標: ${stage.label}` : null
  if (player.running) return { kind: 'busy', label: player.phase === 'waiting' ? 'プレイヤーモード: 待機中' : 'プレイヤーモード: 行動中', detail: player.reason ?? goal, code: null }
  if (player.phase === 'failed') return { kind: 'error', label: 'プレイヤーモード: 停止', detail: player.reason, code: null }
  return { kind: 'idle', label: '待機中: プレイヤーモードの開始待ち', detail: goal, code: null }
}

module.exports = { modeState, playerActivity }
