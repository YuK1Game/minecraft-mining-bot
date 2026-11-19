/* Debug tools in the run column: spawn point here, clear items, one operator command. */
(() => {
  'use strict'
  const control = window.botControl, column = document.querySelector('#control .control-run')
  if (!control || !column) return
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el }
  let live = null, armed = 0, armTimer = null

  const tools = element('div', 'debug-tools')
  tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'デバッグ')
  const spawn = element('button', '', '⌂ リスポーン地点'), clear = element('button', 'debug-clear', '⌫ 所持品リセット')
  spawn.type = clear.type = 'button'; spawn.id = 'control-debug-spawn'; clear.id = 'control-debug-clear'
  spawn.title = '現在地をリスポーン地点にする（/spawnpoint @s ~ ~ ~）'; clear.title = '所持品・防具をすべて消す（/clear @s）'
  const form = element('form', 'debug-command'), input = element('input'), run = element('button', '', '▶')
  input.id = 'control-debug-text'; input.placeholder = '/ 管理者コマンド'; input.maxLength = 512; input.autocomplete = 'off'; input.spellcheck = false
  input.setAttribute('aria-label', '管理者コマンド'); run.type = 'submit'; run.title = 'Botとして実行'; run.setAttribute('aria-label', 'コマンドを実行')
  form.append(input, run)
  tools.append(element('span', 'debug-tag', 'DEBUG'), spawn, clear, form)
  column.append(tools)

  const ready = () => control.idle() && live?.phase === 'spawned' && !!live?.session
  function render () {
    const ok = ready()
    spawn.disabled = !ok
    clear.disabled = !ok || live?.loadout?.busy === true || live?.storage?.busy === true
    input.disabled = !ok
    run.disabled = !ok || !input.value.trim()
    if (clear.disabled) disarm()
  }
  function disarm () { armed = 0; clearTimeout(armTimer); clear.textContent = '⌫ 所持品リセット'; clear.removeAttribute('aria-pressed') }
  const send = (body, done) => control.act('action', 'debug', { ...body, session: control.session() }, result => { control.note('action', result.debug?.message ?? ''); done?.() })

  spawn.addEventListener('click', () => send({ command: 'debugSpawn' }))
  // Clearing loses everything, so it takes a second press within 4 seconds.
  clear.addEventListener('click', () => {
    if (!armed) { armed = Date.now(); clear.textContent = '⌫ もう一度押して確定'; clear.setAttribute('aria-pressed', 'true'); armTimer = setTimeout(disarm, 4000); return }
    disarm()
    send({ command: 'debugClear' })
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || run.disabled) return
    send({ command: 'debugCommand', text }, () => { input.value = ''; render() })
  })
  input.addEventListener('input', render)
  window.addEventListener('dashboard-control-live', event => { live = event.detail && typeof event.detail === 'object' ? event.detail : null; render() })
  render()
})()
