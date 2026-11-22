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

  const roadmap = element('div', 'mode-roadmap')
  const summary = element('div', 'mode-roadmap-summary')
  const goal = element('strong', 'mode-goal')
  const total = element('span', 'mode-roadmap-total')
  const stages = element('ol', 'mode-stages')
  summary.append(goal, total)
  roadmap.append(summary, stages)
  roadmap.hidden = true
  $('target-heading').after(roadmap)

  const detail = element('dialog', 'mode-stage-detail')
  detail.setAttribute('aria-labelledby', 'mode-stage-title')
  const heading = element('div', 'mode-stage-heading')
  const title = element('h3', '')
  title.id = 'mode-stage-title'
  const close = element('button', 'mode-stage-close', '閉じる')
  close.type = 'button'
  close.addEventListener('click', () => detail.close())
  const status = element('p', 'mode-stage-status')
  const checks = element('ul', 'mode-stage-checks')
  const reason = element('p', 'mode-stage-reason')
  heading.append(title, close)
  detail.append(heading, status, checks, reason)
  detail.addEventListener('click', event => {
    if (event.target !== detail) return
    const bounds = detail.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) detail.close()
  })
  detail.addEventListener('close', () => { if (!detail.open) selected = null })
  document.body.append(detail)

  const stageState = (stage, player) => stage.reached ? 'done' : stage.id === player.current ? 'current' : 'next'
  const labelsForStatus = { done: '達成', current: '現在の目標', next: '未達成' }
  const labelsForCheck = { done: '確認済み', skipped: '対象外', pending: '未確認' }
  let selected = null, signature = null
  const stageButtons = new Map()

  function renderDetail (player) {
    const stage = player.stages.find(stage => stage.id === selected)
    if (!stage) { if (detail.open) detail.close(); return }
    title.textContent = stage.label
    status.dataset.state = stageState(stage, player)
    status.textContent = labelsForStatus[status.dataset.state]
    const rows = stage.checks ?? []
    checks.hidden = !rows.length
    checks.replaceChildren(...rows.map(check => {
      const row = element('li', '')
      const state = labelsForCheck[check.status] ? check.status : 'pending'
      row.dataset.state = state
      row.append(element('span', 'mode-check-label', check.label))
      const receipt = element('span', 'mode-check-state', check.value || labelsForCheck[state])
      if (check.value) receipt.setAttribute('aria-label', check.value + '、' + labelsForCheck[state])
      row.append(receipt)
      return row
    }))
    const activity = stage.id === player.current ? player.reason : null
    reason.hidden = !activity
    reason.textContent = activity || ''
  }

  function renderStages (player) {
    const nextSignature = JSON.stringify([player.current, player.phase, player.reason, player.stages])
    if (signature === nextSignature) return
    signature = nextSignature
    const active = player.stages.find(stage => stage.id === player.current)
    const reached = player.stages.filter(stage => stage.reached).length
    const completed = player.stages.length && reached === player.stages.length
    goal.textContent = active?.label ?? (completed ? 'すべて達成' : player.phase === 'completed' ? '遠征完了' : '進捗の受信待ち')
    total.textContent = player.stages.length ? `${reached} / ${player.stages.length} 達成` : ''
    const nextIds = player.stages.map(stage => stage.id)
    // Keep the buttons mounted while polling to preserve keyboard focus.
    if (nextIds.join(' ') !== [...stageButtons.keys()].join(' ')) {
      stageButtons.clear()
      stages.replaceChildren(...player.stages.map(stage => {
        const item = element('li', '')
        const button = element('button', 'mode-stage-button')
        button.type = 'button'
        button.setAttribute('aria-haspopup', 'dialog')
        button.addEventListener('click', () => {
          selected = stage.id
          renderDetail(live.mode.player)
          detail.showModal()
        })
        item.append(button)
        stageButtons.set(stage.id, button)
        return item
      }))
    }
    for (const stage of player.stages) {
      const button = stageButtons.get(stage.id)
      const state = stageState(stage, player)
      button.dataset.state = state
      button.textContent = stage.shortLabel ?? stage.label
      button.title = stage.label
      button.setAttribute('aria-label', `${stage.label}、${labelsForStatus[state]}`)
      if (state === 'current') button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
    }
    if (selected && detail.open) renderDetail(player)
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
    if (roadmap.hidden === player) {
      roadmap.hidden = !player
      signature = null
    }
    if (!player && detail.open) detail.close()
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
