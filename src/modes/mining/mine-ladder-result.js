'use strict'

const { result: makeResult } = require('../return/return-result')
const { scopeOf } = require('./mine-observed')
const PHASES = { preparing: '開始前', mount: '乗り込み', climb: '昇降', dismount: '着地確認' }
const point = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) ? { x: p.x, y: p.y, z: p.z } : null
const codeOf = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null
const text = value => typeof value === 'string' ? value.replace(/[\p{C}§]/gu, ' ').slice(0, 160) : null

function cause (code) {
  if (/BUSY|INPUT_CHANGED|PREEMPTED|SCOPE_CHANGED|NOT_ALIVE|DAMAGED|CANCELLED|INTERRUPTED|UNAVAILABLE/.test(code)) return { retry: 'owner_released', detail: 'はしごの操作権と現在の状態を確認してから再開します。' }
  if (/INPUT_RECEIPT|INPUT_TIMEOUT/.test(code)) return { retry: 'time', detail: 'はしごの移動入力の送信確認を待っています。' }
  if (/POSITION_UNCONFIRMED|ORIGIN_UNCONFIRMED/.test(code)) return { retry: 'time', detail: 'はしごの位置をサーバーの受信で確認しています。' }
  if (/UNSUPPORTED|CONTINUITY|BODY|LANDING_CHANGED|NO_SAFE_FRAME/.test(code)) return { retry: 'terrain_received', detail: 'はしごと乗降する足場の状態を再確認しています。' }
  if (/CORRECTION|ORIGIN_CHANGED|LEFT_ROUTE|LOST_CONTACT|NOT_CENTRED|NOT_ADJACENT/.test(code)) return { retry: 'position_changed', detail: '受信した現在位置から、はしごへの乗り方を確認し直します。' }
  return { retry: 'position_changed', detail: 'はしごの移動が進まないため、現在位置と経路を再確認します。' }
}

// Ladder owns movement and its receipts. This boundary only translates its
// result into the common mining contract; it never promotes a prediction to
// completion or retries an input. Keep a bounded diagnostic across run contexts.
function mineLadderResult (ctx, request, raw) {
  const confirmed = raw?.status === 'completed' && raw.serverConfirmed === true
  const status = confirmed ? 'completed' : ['blocked', 'failed', 'interrupted', 'cancelled'].includes(raw?.status) ? raw.status : 'blocked'
  const fallback = status === 'interrupted' ? 'LADDER_INTERRUPTED' : status === 'cancelled' ? 'LADDER_CANCELLED' : raw ? 'LADDER_RESULT_UNCONFIRMED' : 'MINE_LADDER_UNAVAILABLE'
  const code = confirmed ? 'MINE_LADDER_ARRIVED' : raw?.status === 'completed' ? 'LADDER_POSITION_UNCONFIRMED' : codeOf(raw?.code) ?? codeOf(raw?.reason) ?? fallback
  let observed = null
  try { observed = ctx.runtime.mineLadderDiagnostics?.() } catch {}
  const branch = ctx.memory?.early?.mine?.branch, phase = Object.hasOwn(PHASES, raw?.phase) ? raw.phase : null
  const position = observed?.position
  const evidence = {
    planId: text(branch?.plan?.id), layer: text(branch?.request?.layer), depth: Number.isFinite(branch?.shaft?.depth) ? branch.shaft.depth : null,
    operationId: text(request?.operationId), from: point(request?.from), to: point(request?.to), phase,
    queuedFrames: Number.isSafeInteger(raw?.queuedFrames) ? raw.queuedFrames : null,
    ladderOwnsInput: typeof observed?.ladderOwnsInput === 'boolean' ? observed.ladderOwnsInput : null,
    activeBehavior: text(observed?.activeBehavior),
    position: position ? { pending: position.pending === true, reason: codeOf(position.lastResult?.reason), serverConfirmed: position.lastResult?.serverConfirmed === true, feet: point(position.feet ?? position.lastResult?.feet) } : null
  }
  const why = cause(code), context = [PHASES[phase], evidence.to && `行先Y${evidence.to.y}`].filter(Boolean).join('・')
  const detail = confirmed ? null : why.detail + (context ? `（${context}）` : '')
  const normalized = { ...raw, ...makeResult(status, code, {
    evidence: { ...(raw?.evidence ?? {}), ladder: evidence, serverConfirmed: confirmed },
    retry: confirmed ? null : { kind: why.retry }, detail
  }), serverConfirmed: confirmed }
  const identity = JSON.stringify([scopeOf(ctx), status, code, evidence.planId, evidence.depth, evidence.operationId, evidence.to, phase, evidence.activeBehavior, evidence.position?.reason])
  const previous = ctx.shared.mineLadderDiagnostic
  ctx.shared.mineLadderDiagnostic = { key: confirmed ? null : identity, status, code, ...evidence }
  if (!confirmed && previous?.key !== identity) ctx.log?.('採掘場: はしご ' + JSON.stringify({ status, code, ...evidence }))
  return normalized
}

function ladderDetail (result) {
  return result?.evidence?.ladder && result.status !== 'completed' ? result.detail : null
}

module.exports = { mineLadderResult, ladderDetail }
