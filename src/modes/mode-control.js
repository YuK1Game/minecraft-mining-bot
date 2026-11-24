'use strict'

// Holds the selected mode for the running Bot and applies a switch: check the
// rule, record it in the shared host state, save it. It starts no work.
const { LABELS, normalizeMode, switchRefusal } = require('./bot-mode')
const { ensureSharedScopes, resetModeScope } = require('../common/shared-scopes')

function createModeControl ({ shared, save, getQuarryStatus = () => null, getAgentStatus = () => null, isBusy = () => false, log = () => {} }) {
  shared.botMode = normalizeMode(shared.botMode)
  ensureSharedScopes(shared).meta.mode ??= shared.botMode
  let saving = Promise.resolve()
  const get = () => shared.botMode
  function set (to) {
    const from = get()
    const refused = switchRefusal({ from, to, quarry: getQuarryStatus(), agent: getAgentStatus(), busy: isBusy() })
    if (refused) throw Object.assign(new Error(refused.message), { code: refused.code })
    if (from === to) return { mode: from, changed: false }
    shared.botMode = to
    resetModeScope(shared, to)
    // Player mode never restores or resumes a saved quarry job on its own.
    if (to === 'player') { shared.quarryRestoreDisabled = true; shared.quarryAutoResume = false }
    log(`モード: ${LABELS[from]} → ${LABELS[to]}`)
    saving = saving.then(() => save(to)).catch(error => log(`モード: 保存に失敗 ${String(error?.message).slice(0, 160)}（再起動後は前のモードに戻ります）`))
    return { mode: to, changed: true }
  }
  return { get, set, settled: () => saving }
}

module.exports = { createModeControl }
