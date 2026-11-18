/* Mode switch (露天掘り｜プレイヤー) and the player-mode view of the control panel. */
(() => {
  'use strict'
  const control = window.botControl, panel = document.getElementById('control')
  if (!control || !panel) return
  const $ = id => document.getElementById('control-' + id)
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el }
  const labels = { quarry: '⛏ 露天掘り', player: '🧭 プレイヤー' }
  const quarryText = { stepArea: $('step-area').textContent, target: $('target-heading').textContent, start: $('start').innerHTML }
  let live = null

  const switcher = element('span', 'mode-switch')
  switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'モード')
  const buttons = Object.fromEntries(Object.entries(labels).map(([mode, label]) => {
    const button = element('button', '', label)
    button.type = 'button'; button.disabled = true; button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (live?.mode?.current === mode) return
      control.act('action', 'mode', { command: 'setMode', session: control.session(), mode })
    })
    switcher.append(button)
    return [mode, button]
  }))
  panel.querySelector('summary').append(switcher)

  // The road to the Ender Dragon, shown in place of the mining area.
  const stages = element('ol', 'mode-stages')
  stages.hidden = true
  $('target-heading').after(stages)
  function renderStages (player) {
    const signature = JSON.stringify([player.current, player.known, player.stages])
    if (stages.dataset.signature === signature) return
    stages.dataset.signature = signature
    stages.replaceChildren(...player.stages.map(stage => {
      const item = element('li', '', stage.label)
      item.dataset.state = stage.reached ? 'done' : stage.id === player.current ? 'current' : stage.implemented ? 'next' : 'later'
      if (stage.id === player.current) item.setAttribute('aria-current', 'step')
      return item
    }))
  }

  function render () {
    const mode = live?.mode ?? null, current = mode?.current ?? 'quarry', player = current === 'player', idle = control.idle()
    const q = live?.quarry, quarryRunning = !!q && !['IDLE', 'PAUSED', 'FINISHED'].includes(q.state), playing = mode?.player.running === true
    const working = quarryRunning || playing || live?.loadout?.busy === true || live?.storage?.busy === true || live?.chunkMove?.busy === true
    for (const [name, button] of Object.entries(buttons)) {
      button.setAttribute('aria-pressed', String(!!mode && name === current))
      button.disabled = !mode || !idle || working && name !== current
    }
    panel.dataset.mode = current
    stages.hidden = !player
    $('step-area').textContent = player ? '02 目標' : quarryText.stepArea
    $('target-heading').textContent = player ? '02 目標' : quarryText.target
    if (!player) { if ($('start').dataset.mode) { $('start').innerHTML = quarryText.start; delete $('start').dataset.mode } return }
    renderStages(mode.player)
    if (!$('start').dataset.mode) { $('start').textContent = '▶ プレイ開始'; $('start').dataset.mode = 'player' }
    const ready = live?.ready === true
    const completed = mode.player.phase === 'completed'
    $('start').disabled = !idle || !ready || playing || completed
    $('pause').disabled = !idle || !playing
    for (const id of ['plan', 'resume', 'cancel']) $(id).disabled = true
    $('live').textContent = completed ? '遠征完了' : playing ? 'プレイ中' : '停止中'
    $('live').title = mode.player.reason || ''
    $('live').className = 'badge run-state' + (playing ? ' live' : '')
    $('step-area').className = !playing && !completed ? 'active' : ''
    $('step-run').className = playing ? 'active' : ''
  }
  window.addEventListener('dashboard-control-live', event => { live = event.detail && typeof event.detail === 'object' ? event.detail : null; render() })

  // In player mode the run buttons start and stop the player instead of a quarry job.
  window.botMode = {
    run (button) {
      if (live?.mode?.current !== 'player') return false
      const command = { start: 'playerStart', pause: 'playerStop' }[button]
      if (command) control.act('action', 'mode', { command, session: control.session() })
      return true
    }
  }
})()
