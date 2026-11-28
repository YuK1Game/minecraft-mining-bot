'use strict'

// Counts how many seconds the Bot stays at the same spot while actively playing,
// and once standstill reaches 20s (then 30s, 60s, +60s...), inspects live
// subsystems to log the exact cause of why it is not moving.
const THRESHOLD_SEC = 20
const MOVE_RADIUS_M = 0.25
const MILESTONES = [20, 30, 60]

function nextReportSec (lastSec) {
  for (const m of MILESTONES) if (m > lastSec) return m
  return Math.floor(lastSec / 60) * 60 + 60
}

function classifyStandstill (snap = {}) {
  const ops = []
  const reason = String(snap.playerReason ?? '')
  const decision = String(snap.playerDecision ?? '')
  if (snap.combatActive) ops.push('combat')
  if (snap.fleeActive) ops.push('flee')
  if (snap.coverActive) ops.push('cover')
  if (snap.miningPhase === 'mining') ops.push(`mining(${snap.miningTarget ?? '?'})`)
  if (snap.motionPhase === 'moving') ops.push('moving')
  if (snap.travelBusy) ops.push(`travel(${snap.travelPhase ?? '?'})`)
  if (snap.foodActive) ops.push('eating')
  if (snap.craftActive) ops.push('crafting')
  if (snap.chestActive) ops.push('chest')
  if (snap.furnaceActive) ops.push('furnace')

  let cause = '原因不明（操作なし・アイドル待機）'
  if (snap.combatActive) cause = '戦闘中'
  else if (snap.fleeActive || snap.coverActive) cause = '敵の回避・射線退避中'
  else if (snap.foodActive) cause = '食事中'
  else if (snap.miningPhase === 'mining') cause = `ブロック採掘中（${snap.miningTarget ?? '対象不明'}）`
  else if (snap.craftActive) cause = 'クラフト中'
  else if (snap.furnaceActive) cause = 'かまど精錬中'
  else if (snap.chestActive) cause = 'チェスト操作中'
  else if (snap.motionPhase === 'moving') cause = '歩行入力中だが位置が進まない（段差・引っかかり・サーバー押し戻しの可能性）'
  else if (snap.inventoryUncertain || /持ち物の受信を待ちます/.test(reason)) cause = 'サーバーからの持ち物同期待ち'
  else if (/MINE_TERRAIN_REQUESTED|MINE_TERRAIN_WAITING|MINE_TERRAIN_UNREQUESTABLE/.test(reason)) cause = `採掘場の地下チャンク受信待ち（${/MINE_TERRAIN_[A-Z_]+/.exec(reason)?.[0] ?? 'terrain'}）`
  else if (/MINE_OBSERVATION_|次の採掘層を計画|採掘範囲を観測|受信を確認できない候補/.test(reason)) cause = '採掘候補の地形観測・計画計算中'
  else if (snap.travelBusy) cause = `長距離移動の待機・再計画中（${snap.travelPhase ?? 'busy'}）`
  else if (snap.nearDanger) cause = `付近の敵を警戒して待機中（${snap.nearDanger}）`
  else if (reason) cause = `作業待機中（${reason.slice(0, 60)}）`

  return {
    cause,
    ops: ops.length ? ops.join(',') : 'なし',
    reason: reason.slice(0, 80) || 'なし',
    decision: decision.slice(0, 80) || 'なし'
  }
}

function createStandstillWatch ({ active = () => false, getFeet = () => null, inspect = () => ({}), log = () => {}, now = Date.now, thresholdSec = THRESHOLD_SEC, radiusM = MOVE_RADIUS_M } = {}) {
  let anchor = null
  let since = null
  let lastReportedSec = 0
  let lastCause = null

  function reset () {
    anchor = null
    since = null
    lastReportedSec = 0
    lastCause = null
  }

  function tick () {
    if (!active()) { reset(); return null }
    const feet = getFeet()
    if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) { reset(); return null }
    const t = now()
    if (!anchor) {
      anchor = { x: feet.x, y: feet.y, z: feet.z }
      since = t
      lastReportedSec = 0
      return null
    }
    const moved = Math.hypot(feet.x - anchor.x, feet.y - anchor.y, feet.z - anchor.z)
    if (moved > radiusM) {
      anchor = { x: feet.x, y: feet.y, z: feet.z }
      since = t
      lastReportedSec = 0
      lastCause = null
      return null
    }
    const elapsedSec = Math.floor((t - since) / 1000)
    const targetSec = lastReportedSec === 0 ? thresholdSec : nextReportSec(lastReportedSec)
    if (elapsedSec < targetSec) return null

    lastReportedSec = elapsedSec
    const snap = (() => { try { return inspect() ?? {} } catch { return {} } })()
    const diag = classifyStandstill(snap)
    lastCause = diag.cause
    const posStr = `(${feet.x.toFixed(1)}, ${feet.y.toFixed(1)}, ${feet.z.toFixed(1)})`
    log(`立ち止まり検知: ${elapsedSec}秒 座標=${posStr} 原因=${diag.cause}｜操作=${diag.ops}｜状態=${diag.reason}`)
    return { elapsedSec, position: { ...feet }, ...diag }
  }

  function state () {
    const t = now()
    return {
      seconds: since != null ? Math.max(0, Math.floor((t - since) / 1000)) : 0,
      since,
      anchor: anchor ? { ...anchor } : null,
      lastReportedSec,
      lastCause
    }
  }

  return { tick, reset, state }
}

module.exports = { createStandstillWatch, classifyStandstill, THRESHOLD_SEC, MOVE_RADIUS_M }
