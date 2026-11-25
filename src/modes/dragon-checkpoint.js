'use strict'

const { createCheckpointParts } = require('../common/checkpoint-parts')

function createDragonCheckpoint (options) {
  const parts = createCheckpointParts({ ...options, paths: [['early', 'mine', 'branch', 'plan'], ['early', 'mine', 'sites']], freezeInputs: true })
  return {
    copy: parts.copy,
    signature: parts.signature,
    restore: doc => doc.version === 1 ? parts.copy(doc.value) : parts.restoreSync(doc.value),
    save: (value, scope) => parts.save(value, core => ({ version: 2, scope, savedAt: new Date().toISOString(), value: core }))
  }
}

module.exports = { createDragonCheckpoint }
