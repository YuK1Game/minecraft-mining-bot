'use strict'

// The goal "go back to the base and bank the cargo", kept apart from the
// operation that happens to run for it. The goal is plain data: it lives in
// shared.playerReturn across a hot reload and in .local/player-return.json
// across a restart. It holds no coordinates of a walk in progress, no promise,
// no timer and no owner token: after an interruption, a reload or a death the
// rest is planned again from what is received then.
//
// Stages, each with its own end condition:
//   observe    the position and the inventory are received
//   surface    under the open sky, out of the water (the place a trip starts from)
//   travel     within 20 m of the base (the long travel's "arrived")
//   approach   within reach of the chest (not the same as "arrived")
//   container  a chest is open-able and its received slots show room
//   store      the cargo is in the chest, by the received inventory
//   verify     nothing is left to bank; the kit is restocked
//   replan     the controls are released and the work is planned again
//
// Budgets (finite, so a goal that cannot be met does not hold the Bot):
// - STAGE_ATTEMPTS 3: the same failure in the same state is tried three times,
//   like the other retries of this Bot, then another way or a hold.
// - GOAL_ATTEMPTS 12: failures of one goal, whatever they are (about four
//   different problems, three tries each).
// - ACTIVE_MS 30 min: the longest trip allowed is 20 min (player-base.js
//   TRAVEL_MAX_MS) plus the climb and the chest; time spent interrupted by a
//   fight, a meal or the night does not count.
// - DETOURS 2: a trip that gets nowhere twice from the same place goes round,
//   48 m to one side and then to the other, before the goal is held.
// - RETRY_MS 2 s: between two tries of a step that failed, so that three tries
//   are not one instant (live 2026-11-18 03:28 JST: three within 20 ms).
// - SIDES 2: arrived (within 20 m) with no way to the chest from this side (a
//   cliff over the house), the Bot goes round to another side, 30 m beyond the
//   chest, and comes in from there: the door's side first, then the far side.
// - HOSTILE_WAIT_MS 1 min: a hostile nearby that starts no fight delays the
//   start of a goal this long, then the trip starts anyway.
// - A held goal wakes when what its failure depends on changes (the supplies,
//   the life; the place, 32 m away, only for a failure of getting somewhere,
//   and 8 blocks up or down only for the way out of a tunnel) or, at the
//   latest, after HOLD_MS 10 min (hostiles and danger
//   zones move by themselves). Each wake allows WAKE_ATTEMPTS 4 more tries;
//   after MAX_WAKES 6 the goal is given up and a new one waits GIVE_UP_MS.
//   The failure memory (return-failures.js) outlives the goal either way.
const fs = require('node:fs')
const path = require('node:path')

const STAGES = Object.freeze(['observe', 'surface', 'travel', 'approach', 'container', 'store', 'verify', 'replan'])
const LABEL = Object.freeze({ observe: '状態の確認', surface: '出発位置の確保', travel: '拠点へ移動', approach: 'チェストへ接近', container: 'チェストの確認', store: '収納', verify: '収納の確認', replan: '作業の再開' })
const BUDGET = Object.freeze({ STAGE_ATTEMPTS: 3, GOAL_ATTEMPTS: 12, WAKE_ATTEMPTS: 4, MAX_WAKES: 6, ACTIVE_MS: 1800000, WAKE_ACTIVE_MS: 600000, HOLD_MS: 600000, GIVE_UP_MS: 600000, MAX_INTERRUPTS: 10, OWNER_WAIT_MS: 300000, STOP_WAIT_MS: 8000, HOSTILE_WAIT_MS: 60000, WAIT_MS: 30000, RETRY_MS: 2000, MOVED_M: 32, MOVED_UP: 8, DETOURS: 2, DETOUR_M: 48, SIDES: 2, SIDE_M: 30 })

const cell = point => point && [point.x, point.y, point.z].every(Number.isFinite) ? { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) } : null
const chestCell = value => value && [value.x, value.y, value.z].every(Number.isSafeInteger) ? { x: value.x, y: value.y, z: value.z } : null
const chestList = value => Array.isArray(value) ? value.map(chestCell).filter(Boolean).slice(0, 16) : []
// Required observations are all-or-nothing: dropping an invalid cell would
// silently weaken the condition that originally blocked the step.
const terrainCells = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(entry => chestCell(entry)) ? value.map(chestCell) : null

function newGoal ({ id, reason, base = null, scope = null, origin = null, now = Date.now() }) {
  return {
    version: 1, id, purpose: 'bank', reason, state: 'active', stage: 'observe', scope, base: chestCell(base), target: null,
    // The work to plan again afterwards, by its objective only.
    origin: origin ? { objective: origin.objective ?? null } : null,
    createdAt: now, stageAt: now,
    progress: { banked: 0, taken: 0, lastAt: null, last: null },
    remaining: null,
    full: [], unopened: [], unreached: [], visited: [], built: 0, detour: null, detours: 0, sides: 0,
    budget: { attempts: 0, activeMs: 0, wakes: 0, interrupts: 0 },
    wait: null, hold: null, interrupt: null, last: null, saved: true
  }
}

// A goal read back from shared or the file: the stage is observed again, and
// nothing that belonged to a running operation is kept.
function restoreGoal (value) {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || value.purpose !== 'bank' || !['active', 'held'].includes(value.state)) return null
  const number = (candidate, fallback = 0) => Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback
  return {
    version: 1, id: value.id, purpose: 'bank', reason: typeof value.reason === 'string' ? value.reason : null, state: value.state, stage: 'observe',
    scope: typeof value.scope === 'string' ? value.scope : null, base: chestCell(value.base), target: null,
    origin: value.origin && typeof value.origin === 'object' ? { objective: value.origin.objective ?? null } : null,
    createdAt: number(value.createdAt, Date.now()), stageAt: Date.now(),
    progress: { banked: number(value.progress?.banked), taken: number(value.progress?.taken), lastAt: Number.isFinite(value.progress?.lastAt) ? value.progress.lastAt : null, last: typeof value.progress?.last === 'string' ? value.progress.last : null },
    remaining: null,
    full: chestList(value.full), unopened: [], unreached: [], visited: [], built: number(value.built), detour: null, detours: number(value.detours), sides: 0,
    budget: { attempts: number(value.budget?.attempts), activeMs: number(value.budget?.activeMs), wakes: number(value.budget?.wakes), interrupts: 0 },
    wait: null, hold: value.state === 'held' && value.hold && typeof value.hold === 'object' ? { code: String(value.hold.code ?? 'UNKNOWN'), at: number(value.hold.at), until: number(value.hold.until), position: cell(value.hold.position), supplies: typeof value.hold.supplies === 'string' ? value.hold.supplies : null, kinds: Array.isArray(value.hold.kinds) ? value.hold.kinds.filter(kind => typeof kind === 'string') : [], vertical: value.hold.vertical === true, terrainCells: terrainCells(value.hold.terrainCells) } : null,
    interrupt: null, last: null, saved: true, resumed: true
  }
}

const attemptLimit = goal => BUDGET.GOAL_ATTEMPTS + BUDGET.WAKE_ATTEMPTS * goal.budget.wakes
const activeLimit = goal => BUDGET.ACTIVE_MS + BUDGET.WAKE_ACTIVE_MS * goal.budget.wakes
const exhausted = goal => goal.budget.attempts >= attemptLimit(goal) ? 'RETURN_ATTEMPTS_EXHAUSTED' : goal.budget.activeMs >= activeLimit(goal) ? 'RETURN_TIME_EXHAUSTED' : null

// Why a held goal wakes now, or null. `seen`: { position, supplies, inventoryKnown, settled, scope, now }.
function wakeReason (goal, seen) {
  const hold = goal?.hold
  if (!hold) return 'NOT_HELD'
  if (seen.scope !== goal.scope) return 'SCOPE_CHANGED'
  const kinds = hold.kinds ?? []
  if (kinds.includes('position_changed') && hold.position && seen.position && (Math.hypot(seen.position.x - hold.position.x, seen.position.z - hold.position.z) >= BUDGET.MOVED_M || (hold.vertical === true && Math.abs(seen.position.y - hold.position.y) >= BUDGET.MOVED_UP))) return 'POSITION_CHANGED'
  if (kinds.includes('supplies_changed') && hold.supplies !== null && seen.supplies !== hold.supplies) return 'SUPPLIES_CHANGED'
  if (kinds.includes('inventory_update') && seen.inventoryKnown === true) return 'INVENTORY_RECEIVED'
  if (kinds.includes('terrain_received') && seen.terrain === true) return 'TERRAIN_RECEIVED'
  if (kinds.includes('owner_released') && seen.settled === true) return 'OWNER_RELEASED'
  if (kinds.includes('owner_free') && seen.owner === null) return 'OWNER_FREE'
  if (seen.now >= hold.until) return 'HOLD_TIME'
  return null
}

const returnFile = root => path.resolve(root, '.local', 'player-return.json')
function loadReturnSync (file, { io = fs } = {}) {
  try {
    const value = JSON.parse(String(io.readFileSync(file, 'utf8')).replace(/^﻿/, ''))
    return { goal: restoreGoal(value?.goal), failures: value?.failures && typeof value.failures === 'object' ? value.failures : null }
  } catch { return { goal: null, failures: null } }
}

module.exports = { STAGES, LABEL, BUDGET, newGoal, restoreGoal, exhausted, attemptLimit, activeLimit, wakeReason, returnFile, loadReturnSync, cell, terrainCells }
