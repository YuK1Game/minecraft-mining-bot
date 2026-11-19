'use strict'

// Debug tools of the dashboard (2026-11-19 user request): set the spawn point
// to where the Bot stands, clear its items, and run one operator command typed
// by the user. Only a press on the page sends anything; the Bot never calls
// these itself. The command is sent as the Bot player through the runtime's
// diagnostics.command, and the result is the server's own command_output.
// Without operator rights (the production Realm) the server refuses, or does
// not answer; either is reported as a failure, never as done.
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status })
const COMMANDS = { debugSpawn: '/spawnpoint @s ~ ~ ~', debugClear: '/clear @s' }
const LABELS = { debugSpawn: 'リスポーン地点を現在地に設定', debugClear: '所持品をリセット', debugCommand: 'コマンド' }
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').trim()

// A typed command: one line, starting with "/", at most 512 characters.
function commandText (value) {
  const line = typeof value === 'string' ? value.trim() : ''
  const full = line.startsWith('/') ? line : '/' + line
  if (line === '' || full.length > 512 || /[\r\n\u0000-\u001f\u007f]/.test(full) || !/^\/\S/.test(full)) throw fail('INVALID_COMMAND_TEXT', 'コマンドは1行（512文字以内）で入力してください。', 400)
  return full
}

// One readable line from command_output: its message key and parameters.
function outputLine (output) {
  const rows = Array.isArray(output?.output) ? output.output : []
  return rows.map(row => {
    const params = (row?.parameters ?? []).map(text).filter(Boolean)
    return text(row?.message_id).replace(/^%/, '') + (params.length ? ` [${params.join(', ')}]` : '')
  }).filter(Boolean).join(' / ').slice(0, 200)
}

function createDashboardDebug ({ getDiagnostics, log = () => {}, timeoutMs = 4000, pollMs = 100, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  let running = null
  async function run (input) {
    const label = LABELS[input.command]
    if (!label) throw fail('INVALID_COMMAND', 'この操作は管理画面に公開されていません。', 400)
    const command = input.command === 'debugCommand' ? commandText(input.text) : COMMANDS[input.command]
    if (running) throw fail('DEBUG_BUSY', `前のコマンド（${running}）の応答を待っています。`)
    const diagnostics = getDiagnostics()
    if (typeof diagnostics?.command !== 'function' || typeof diagnostics.commandOutput !== 'function') throw fail('DEBUG_UNAVAILABLE', 'Bot本体がコマンド送信に未対応です。Botを再起動してください。')
    running = command
    try {
      const sent = diagnostics.command(command)
      if (!sent?.uuid) throw fail('DEBUG_NOT_SENT', 'コマンドを送信できませんでした。')
      log(`管理画面: ${label}: ${command} を送信しました`)
      const until = now() + timeoutMs
      let output = null
      while (!output && now() < until) {
        await wait(pollMs)
        output = diagnostics.commandOutput(sent.uuid)?.output ?? null
      }
      if (!output) {
        log(`管理画面: ${command} の応答がありません（${Math.round(timeoutMs / 1000)}秒）`)
        throw fail('DEBUG_NO_ANSWER', `${label}: 応答がありません（権限がない、または結果を返さないコマンドです）。`, 504)
      }
      const ok = Number.isInteger(output.success_count) && output.success_count > 0
      const detail = outputLine(output) || (ok ? 'ok' : 'unknown')
      log(`管理画面: ${command} → ${ok ? '成功' : '失敗'}: ${detail}`)
      if (!ok) throw fail('DEBUG_REFUSED', `${label}: サーバーが拒否しました（${detail}）。`)
      return { command, ok: true, detail, message: `${label}: 成功（${detail}）` }
    } finally { running = null }
  }
  return { run, busy: () => running !== null }
}
module.exports = { createDashboardDebug, commandText, outputLine, DEBUG_COMMANDS: Object.keys(LABELS) }
