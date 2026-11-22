'use strict'

const { key, cell, FILL_BLOCKS } = require('./mine-observed')
const PURPOSES = new Set(['shaft_landing', 'shaft_work_floor'])

// A placement can create a future dig permission only for the exact saved
// temporary-floor intent. Reusing an existing cobblestone is not ownership.
function supportIntent (branch, request) {
  const intent = branch?.intent, shaft = branch?.plan?.shaft, p = request?.position
  if (!PURPOSES.has(request?.supportPurpose) || !FILL_BLOCKS.includes(request.name) || !cell(p) || !shaft ||
      intent?.kind !== 'fill' || intent.purpose !== request.supportPurpose || !cell(intent.target) || key(intent.target) !== key(p) ||
      p.y < shaft.bottomY - 1 || p.y >= shaft.topY || !shaft.columns.some(c => c.x === p.x && c.z === p.z)) return null
  return { planId: branch.plan.id, purpose: request.supportPurpose }
}

function recordSupportReceipt (branch, pending, block, after) {
  const proof = pending?.supportFill, p = pending?.position
  if (!proof || proof.planId !== branch?.plan?.id || !PURPOSES.has(proof.purpose) || pending.kind !== 'place' || !cell(p) ||
      !FILL_BLOCKS.includes(pending.name) || !pending.fromAir || !Number.isSafeInteger(pending.before) || !Number.isSafeInteger(after) || after !== pending.before - 1 ||
      block?.known !== true || block.name !== pending.name || block.extra?.length) return false
  const receipt = { planId: proof.planId, purpose: proof.purpose, scope: pending.scope, consumed: 1, before: pending.before, after,
    block: { name: block.name, ...(Number.isSafeInteger(block.runtimeId) ? { runtimeId: block.runtimeId } : {}) } }
  branch.supportFills ??= []
  branch.supportFills = branch.supportFills.filter(old => key(old) !== key(p))
  branch.supportFills.push({ ...p, name: pending.name, receipt })
  return true
}

module.exports = { supportIntent, recordSupportReceipt }
