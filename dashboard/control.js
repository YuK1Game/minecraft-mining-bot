/* Browser-only control UI. Inventory rendering remains independent. */
(() => {
  'use strict'
  const $ = id => document.getElementById('control-' + id)
  const phases = { offline: '未接続', starting: '起動中', authenticating: '認証待ち', selecting_realm: '選択待ち', connecting: '接続中', joined: '読込中', spawned: '接続済み', stopping: '切断中', disconnected: '未接続' }
  const jobs = { IDLE: '計画待ち', PREFLIGHT: '開始確認', SURVEY: '調査中', PLAN: '計画中', MOVE: '移動中', MINE: '採掘中', COLLECT: '回収中', RETURN: '搬入移動', DEPOSIT: '収納中', PORTABLE_STORAGE: '収納中', RESTOCK: '補給中', COMBAT: '戦闘中', SUSPEND_FOR_COMBAT: '戦闘へ切替', COMBAT_SETTLE: '安全確認', RECOVER_AFTER_COMBAT: '復帰確認', RECOVER: '回復中', RECONCILE: '照合中', HAZARD: '危険対処', FINAL_CHECK: '最終確認', EGRESS_PREPARE: '帰還準備', EGRESS: '地上へ帰還中', PAUSED: '一時停止', STOPPING: '停止確認中', FINISHED: 'ジョブ終了', DISCONNECTED: '未接続' }
  let token = null, current = null, plan = null, busy = 0, polling = false, version = 0, viewEpoch = 0, lastPhase = null, gridOrigin = null, preset = 1, resetPreview = null
  const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  function message (kind, text, error = false) { const el = $(kind + '-message'); el.textContent = text; el.hidden = !text; el.classList.toggle('error', error) }
  async function request (route, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), body === undefined ? 5000 : 35000)
    try {
      const response = await fetch('/api/control/' + route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(token ? { 'X-Bot-Control': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '操作に失敗しました。')
      return data
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('応答がありません。操作を繰り返さず現在の状態を確認してください。')
      throw error
    } finally { clearTimeout(timer) }
  }
  const MIN = -1875000, MAX = 1874999
  const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el }
  function area () {
    const value = id => { const input = $(id); return input.value.trim() && input.validity.valid && Number.isSafeInteger(Number(input.value)) ? Number(input.value) : null }
    const x1 = value('x1'), z1 = value('z1'), x2 = $('x2').value.trim() ? value('x2') : x1, z2 = $('z2').value.trim() ? value('z2') : z1
    if ([x1, z1, x2, z2].some(n => n === null || n < MIN || n > MAX)) return { valid: false, message: 'チャンク座標を入力' }
    const width = Math.abs(x2 - x1) + 1, depth = Math.abs(z2 - z1) + 1, count = width * depth
    return { x1, z1, x2, z2, width, depth, count, valid: count <= 4, message: count > 4 ? '最大4チャンク' : '' }
  }
  function renderArea () {
    const a = area(), live = current?.live
    $('area-count').textContent = a.count ?? '—'
    $('area-size').textContent = a.count ? `${a.width * 16} × ${a.depth * 16} BLOCKS` : '範囲未設定'
    $('range-message').textContent = a.count && !a.valid ? a.message : ''
    $('range-message').hidden = !(a.count && !a.valid)
    $('size-one').setAttribute('aria-pressed', String(a.valid && a.width === 1 && a.depth === 1))
    $('size-four').setAttribute('aria-pressed', String(a.valid && a.width === 2 && a.depth === 2))
    const centre = gridOrigin ?? { x: a.x1 ?? live?.chunk?.x ?? 0, z: a.z1 ?? live?.chunk?.z ?? 0 }
    const left = Math.min(MAX - 4, Math.max(MIN, centre.x - 2)), top = Math.min(MAX - 4, Math.max(MIN, centre.z - 2))
    const grid = $('grid'), signature = JSON.stringify([left, top, a, live?.chunk ?? null, busy])
    grid.dataset.invalid = String(!!a.count && !a.valid)
    $('grid-origin').textContent = `X ${left}…${left + 4} / Z ${top}…${top + 4}`
    if (grid.dataset.signature === signature) return a
    const focus = grid.contains(document.activeElement) ? document.activeElement.dataset.key : null
    grid.dataset.signature = signature
    const fragment = document.createDocumentFragment()
    for (let z = top; z < top + 5; z++) for (let x = left; x < left + 5; x++) {
      const selected = a.count && x >= Math.min(a.x1, a.x2) && x <= Math.max(a.x1, a.x2) && z >= Math.min(a.z1, a.z2) && z <= Math.max(a.z1, a.z2)
      const here = live?.ready === true && live.chunk?.x === x && live.chunk?.z === z
      const cell = element('button', 'chunk-cell' + (here ? ' bot' : ''), `${x}, ${z}`)
      cell.type = 'button'; cell.dataset.x = x; cell.dataset.z = z; cell.dataset.key = `${x}:${z}`
      cell.setAttribute('aria-label', `チャンク X ${x}, Z ${z}${here ? '・現在地' : ''}`)
      cell.setAttribute('aria-pressed', String(!!selected)); cell.title = cell.getAttribute('aria-label'); cell.disabled = busy > 0
      cell.tabIndex = focus ? cell.dataset.key === focus ? 0 : -1 : x === Math.min(MAX, Math.max(MIN, centre.x)) && z === Math.min(MAX, Math.max(MIN, centre.z)) ? 0 : -1
      fragment.append(cell)
    }
    grid.replaceChildren(fragment)
    if (!grid.querySelector('[tabindex="0"]')) grid.firstElementChild.tabIndex = 0
    if (focus) [...grid.children].find(c => c.dataset.key === focus)?.focus({ preventScroll: true })
    return a
  }
  const diagnosticLabels = { NO_CARGO_SHULKER: '収納用シュルカーなし', SHULKER_ONLY_STORAGE: 'シュルカー専用', Y_TOP_PROVISIONAL: '上限Y 未確定', Y_TOP_UNKNOWN: '上限Y 未受信', NO_PICKAXE: 'ツルハシなし', NO_FOOD: '食料なし', NO_SEAL_MATERIAL: '土・止水材なし', LARGE_FLUID_IN_TARGET: '水・溶岩あり', PROTECTED_BLOCKS_IN_TARGET: '保護ブロックあり', INVENTORY_UNKNOWN: '所持品 未受信', NOT_SURVIVAL: 'サバイバルで接続', NOT_SPAWNED: '参加位置 未確定', WRONG_DIMENSION: '次元が不一致', WORLD_IDENTITY_UNKNOWN: 'ワールド 未確認' }
  function showPlan (result) {
    const p = result.plan, host = $('plan-summary')
    const fact = (label, value) => { const row = element('div', 'plan-fact'); row.append(element('span', '', label), element('b', '', clean(value))); host.append(row) }
    host.replaceChildren()
    fact('ワールド', result.state.realm?.name ?? '未確認')
    fact('チャンク', (p.chunks ?? []).map(c => `(${c.x}, ${c.z})`).join(' / '))
    fact('高さ', `Y ${p.yTop ?? '未確認'} → ${p.yBottom ?? '未確認'}`)
    for (const [codes, kind, label] of [[p.issues, 'blocked', '停止理由'], [p.warnings, 'warning', '注意']]) {
      if (!codes?.length) continue
      const group = element('div', 'plan-diagnostics ' + kind); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label)
      for (const code of codes) { const chip = element('span', 'plan-diagnostic', (kind === 'blocked' ? '× ' : '△ ') + (diagnosticLabels[code] || clean(code))); chip.title = clean(code); group.append(chip) }
      host.append(group)
    }
    $('plan-title').textContent = p.ready ? '計画確認済み' : '開始不可'
    $('plan-results').classList.toggle('blocked', !p.ready)
    $('plan-results').querySelector('.plan-check').textContent = p.ready ? '✓' : '!'
    $('plan-results').hidden = false
  }
  function render () {
    const s = current, live = s?.live, q = live?.quarry, ready = live?.ready === true, connected = !!s?.managed || !!live, idle = !busy && !!token && live?.loadout?.busy !== true
    $('size-one').disabled = busy > 0; $('size-four').disabled = busy > 0
    const a = renderArea()
    document.getElementById('control').dataset.online = String(ready)
    if (!plan) $('plan-results').hidden = true
    const running = ready && q && !['IDLE', 'PAUSED', 'STOPPING', 'FINISHED'].includes(q.state)
    document.getElementById('control').dataset.running = String(!!running)
    $('phase').textContent = phases[s?.phase] ?? '確認中'
    $('phase').className = 'badge' + (ready ? ' live' : s?.phase === 'authenticating' ? ' warn' : '')
    $('step-connect').className = ready ? 'done' : 'active'
    $('step-area').className = ready && !running ? 'active' : ''
    $('step-run').className = running ? 'active' : ''
    $('profile').disabled = connected || busy > 0
    $('realms').disabled = !idle || !!live?.realm || s?.phase === 'connecting' || s?.phase === 'stopping' || s?.incompatible === true
    const old = $('world').value, options = s?.realms ?? []
    const signature = JSON.stringify(options)
    if ($('world').dataset.signature !== signature) {
      $('world').dataset.signature = signature
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = options.length ? 'ワールドを選択' : (live?.realm?.name || '未取得')
      $('world').replaceChildren(placeholder)
      for (const realm of options) { const option = document.createElement('option'); option.value = realm.id; option.textContent = clean(realm.name) + (realm.available ? '' : '（閉鎖・期限切れ・参加不可）'); option.disabled = !realm.available; $('world').append(option) }
      const selected = live?.realm?.id ?? old
      if (options.some(r => r.id === selected && (live?.realm?.id === selected || r.available))) $('world').value = selected
    }
    if (live?.realm?.id && options.some(r => r.id === live.realm.id)) $('world').value = live.realm.id
    $('world').disabled = !idle || s?.phase !== 'selecting_realm'
    $('connect').disabled = !idle || s?.phase !== 'selecting_realm' || !$('world').value
    $('disconnect').disabled = !token || !connected || s?.phase === 'stopping'
    $('here').disabled = !idle || !ready || !live?.chunk
    $('plan').disabled = !idle || !ready || !a.valid || !!q && !['IDLE', 'FINISHED'].includes(q.state)
    $('start').disabled = !idle || !ready || !plan?.planToken || plan.expiresAt <= Date.now() || plan.state.session !== live?.session || plan.plan.jobId !== q?.jobId || q?.state !== 'IDLE'
    $('pause').disabled = !idle || !q || ['IDLE', 'FINISHED', 'PAUSED', 'STOPPING'].includes(q.state)
    $('resume').disabled = !idle || !ready || q?.state !== 'PAUSED'
    $('emergency').disabled = !token || !q || q.state === 'FINISHED'
    $('cancel').disabled = !idle || !q || q.state === 'FINISHED'
    const auth = s?.auth
    $('auth').hidden = !auth || auth.expiresAt <= Date.now()
    if (auth) { $('auth-code').textContent = auth.code; $('auth-expiry').textContent = '期限 ' + new Date(auth.expiresAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' }
    const realm = live?.realm ?? options.find(r => r.id === $('world').value)
    $('world-heading').textContent = realm?.name ? clean(realm.name) : 'ワールド未選択'
    $('world-heading').title = realm?.name ? clean(realm.name) : ''
    $('world-state').textContent = ready ? 'CONNECTED' : s?.phase === 'authenticating' ? 'AUTHENTICATION' : s?.phase === 'connecting' || s?.phase === 'joined' ? 'CONNECTING' : 'OFFLINE'
    $('dimension').textContent = live?.dimension ? clean(live.dimension).toUpperCase() : 'REALMS'
    $('live').textContent = q ? jobs[q.state] ?? clean(q.state) : 'ジョブ未設定'
    $('live').title = q?.jobId ? clean(q.jobId) : ''
    $('job-reason').textContent = q?.pauseReason ? clean(q.pauseReason) : ''
    $('job-reason').hidden = !q?.pauseReason
    if (plan?.planToken && (plan.state.session !== live?.session || plan.plan.jobId !== q?.jobId || q?.state !== 'IDLE')) {
      plan = null; $('plan-results').hidden = true
      message('action', '状態変更：計画を再確認', true)
    }
    if (plan?.planToken) {
      const seconds = Math.max(0, Math.ceil((plan.expiresAt - Date.now()) / 1000))
      $('plan-time').textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '期限切れ'
      if (!seconds) { $('plan-title').textContent = '計画を再確認'; $('plan-results').classList.add('blocked'); $('plan-results').querySelector('.plan-check').textContent = '!' }
    } else $('plan-time').textContent = ''
    if (s?.message) message('connection', s.message, s.incompatible === true)
    else if (s?.phase !== lastPhase) message('connection', '')
    lastPhase = s?.phase
    renderReset()
  }
  async function poll () {
    if (!token || polling || document.hidden) return
    const epoch = viewEpoch; polling = true
    try { const state = await request('state'); if (epoch === viewEpoch) { current = state; render() } }
    catch (error) { if (epoch === viewEpoch) { current = null; plan = null; message('connection', error.message, true); render() } }
    finally { polling = false }
  }
  async function act (kind, route, body, success) {
    busy++; viewEpoch++; render(); message(kind, '')
    try { const result = await request(route, body); if (result.state) current = { ...current, live: result.state, phase: result.state.phase }; await success?.(result); }
    catch (error) { message(kind, error.message, true) }
    finally { busy--; viewEpoch++; render(); await poll() }
  }
  function number (id, optional = false) {
    const el = $(id)
    if (optional && el.value.trim() === '') return null
    if (!el.value.trim() || !el.checkValidity() || !Number.isSafeInteger(Number(el.value))) { el.setAttribute('aria-invalid', 'true'); el.focus(); throw new Error('整数の座標を入力してください。') }
    return Number(el.value)
  }
  function config () {
    return { x1: number('x1'), z1: number('z1'), x2: number('x2', true), z2: number('z2', true), top: number('top', true), bottom: number('bottom', true) }
  }
  const fields = ['x1', 'z1', 'x2', 'z2', 'top', 'bottom']
  function invalidate (keepGrid = false) { plan = null; version++; if (!keepGrid) gridOrigin = null; $('plan-results').hidden = true; message('action', ''); render() }
  for (const field of fields) $(field).addEventListener('input', () => { $(field).removeAttribute('aria-invalid'); invalidate() })
  function selectArea (x, z, size = preset, keepGrid = false) {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) return
    x = Math.min(MAX - size + 1, Math.max(MIN, x)); z = Math.min(MAX - size + 1, Math.max(MIN, z))
    if (keepGrid && !gridOrigin) gridOrigin = { x: area().x1 ?? current?.live?.chunk?.x ?? 0, z: area().z1 ?? current?.live?.chunk?.z ?? 0 }
    $('x1').value = x; $('z1').value = z; $('x2').value = size > 1 ? x + size - 1 : ''; $('z2').value = size > 1 ? z + size - 1 : ''
    invalidate(keepGrid)
  }
  $('grid').addEventListener('click', event => {
    const cell = event.target.closest('button[data-x]')
    if (!cell || cell.disabled) return
    selectArea(Number(cell.dataset.x), Number(cell.dataset.z), preset, true)
  })
  $('grid').addEventListener('keydown', event => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[event.key]
    if (!delta) return
    const cells = [...$('grid').children], index = cells.indexOf(event.target), next = index + delta
    if (index < 0) return
    event.preventDefault()
    if (next < 0 || next >= cells.length || Math.abs(delta) === 1 && Math.floor(index / 5) !== Math.floor(next / 5)) return
    cells.forEach(c => { c.tabIndex = -1 }); cells[next].tabIndex = 0; cells[next].focus()
  })
  for (const [id, size] of [['size-one', 1], ['size-four', 2]]) $(id).addEventListener('click', () => {
    preset = size
    selectArea(area().x1 ?? current?.live?.chunk?.x ?? 0, area().z1 ?? current?.live?.chunk?.z ?? 0, size)
  })
  $('world').addEventListener('change', render)
  $('realms').addEventListener('click', () => act('connection', 'realms', { profile: $('profile').value.trim() }, result => { current = result; message('connection', '') }))
  $('connect').addEventListener('click', () => act('connection', 'connect', { processId: current.processId, realmId: $('world').value }, result => { current = result; plan = null; message('connection', '') }))
  $('disconnect').addEventListener('click', () => {
    if (!confirm('Botを切断します。採掘中なら停止と保存を行います。よろしいですか？')) return
    const live = current?.live
    act('connection', 'disconnect', { processId: current?.processId, session: live?.session, jobId: live?.quarry?.jobId ?? null }, () => { current = null; plan = null; message('connection', '') })
  })
  $('here').addEventListener('click', () => { selectArea(current.live.chunk.x, current.live.chunk.z) })
  $('plan').addEventListener('click', () => {
    let value
    try { value = config() } catch (error) { message('action', error.message, true); return }
    const revision = version; plan = null
    act('action', 'quarry', { command: 'plan', session: current.live.session, config: value }, result => {
      if (revision !== version) { message('action', '入力が変わりました。もう一度計画を確認してください。'); return }
      plan = result; showPlan(result); message('action', '')
    })
  })
  $('start').addEventListener('click', () => {
    if (!plan) return
    const p = plan
    if (!confirm(`${clean(p.state.realm?.name)} の ${(p.plan.chunks ?? []).map(c => `(${c.x}, ${c.z})`).join(' / ')} を Y=${p.plan.yTop}〜${p.plan.yBottom} まで露天掘りします。開始しますか？`)) return
    plan = null; $('plan-results').hidden = true
    act('action', 'quarry', { command: 'start', session: p.state.session, planToken: p.planToken }, () => message('action', ''))
  })
  for (const [button, command, label] of [['pause', 'pause', '一時停止'], ['resume', 'resume', '再開'], ['emergency', 'emergencyStop', '緊急停止'], ['cancel', 'cancel', 'キャンセル']]) {
    $(button).addEventListener('click', () => {
      if (['resume', 'cancel'].includes(button) && !confirm(`現在のジョブを${label}しますか？`)) return
      plan = null; $('plan-results').hidden = true
      act('action', 'quarry', { command, session: current?.live?.session, jobId: current?.live?.quarry?.jobId ?? null }, () => message('action', ''))
    })
  }

  const itemNames = { diamond_helmet: 'ダイヤのヘルメット', diamond_chestplate: 'ダイヤのチェストプレート', diamond_leggings: 'ダイヤのレギンス', diamond_boots: 'ダイヤのブーツ', diamond_sword: 'ダイヤの剣', diamond_pickaxe: 'ダイヤのツルハシ', diamond_shovel: 'ダイヤのシャベル', bow: '無限の弓' }
  const enchantNames = { protection: 'ダメージ軽減', unbreaking: '耐久力', mending: '修繕', thorns: '棘の鎧', respiration: '水中呼吸', aqua_affinity: '水中採掘', swift_sneak: 'スニーク速度', feather_falling: '落下耐性', depth_strider: '水中歩行', soul_speed: 'ソウルスピード', efficiency: '効率', fortune: '幸運', silk_touch: 'シルクタッチ', sharpness: '鋭さ', looting: 'ドロップ増加', fire_aspect: '火属性', knockback: 'ノックバック', power: 'パワー', infinity: '無限', flame: 'フレイム', punch: 'パンチ' }
  const kitTextures = Object.fromEntries(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_sword', 'diamond_pickaxe', 'diamond_shovel', 'bread', 'arrow', 'totem_of_undying'].map(n => [n, 'items/' + n]))
  Object.assign(kitTextures, { bow: 'items/bow_standby', dirt: 'blocks/dirt', ...Object.fromEntries(['purple', 'blue', 'light_blue', 'yellow', 'brown'].map(c => [c + '_shulker_box', 'blocks/shulker_top_' + c])) })
  function kitIcon (name) {
    const key = String(name ?? '').replace(/^minecraft:/, ''), src = kitTextures[key]
    const host = element('span', 'loadout-item-icon', src ? '' : '?'); host.setAttribute('aria-hidden', 'true')
    if (src) { const image = document.createElement('img'); image.alt = ''; image.draggable = false; image.src = '/assets/minecraft/textures/' + src + '.png'; image.addEventListener('error', () => { host.textContent = '?' }, { once: true }); host.append(image) }
    return host
  }
  function showLoadoutKit (m) {
    const short = { diamond_helmet: 'ヘルメット', diamond_chestplate: 'チェスト', diamond_leggings: 'レギンス', diamond_boots: 'ブーツ', diamond_sword: '剣', diamond_pickaxe: 'ツルハシ', diamond_shovel: 'シャベル', bow: '無限の弓' }
    $('reset-gear').replaceChildren(...[...m.armor, ...m.tools].map(item => {
      const key = item.name.replace('minecraft:', ''), name = itemNames[key] || clean(item.name)
      const tile = element('div', 'loadout-gear-tile'); tile.tabIndex = 0; tile.title = name + ' / ' + Object.entries(item.enchants).map(([n, l]) => `${enchantNames[n] || n} ${l}`).join(' / ')
      tile.setAttribute('aria-label', tile.title); tile.append(kitIcon(item.name), element('span', '', short[key] || name)); return tile
    }))
    const cargoCount = Number.isSafeInteger(m.cargoBoxes) && m.cargoBoxes >= 0 && m.cargoBoxes <= 36 ? m.cargoBoxes : 0
    $('reset-cargo-count').textContent = cargoCount
    $('reset-cargo-grid').replaceChildren(...Array.from({ length: cargoCount }, () => kitIcon('purple_shulker_box')))
    $('reset-cargo-grid').setAttribute('aria-label', `空の収納用シュルカー ${cargoCount}箱`)
    $('reset-supply-count').textContent = m.supplies.length
    const roles = { pickaxe: 'ツルハシ', shovel: 'シャベル', food: 'パン', dirt: '土', totem: '不死のトーテム' }
    $('reset-supply-grid').replaceChildren(...m.supplies.map(box => {
      const card = element('div', 'loadout-supply-card'); card.dataset.role = ['pickaxe', 'shovel', 'food', 'dirt', 'totem'].includes(box.role) ? box.role : ''
      const icons = element('div', 'loadout-supply-icons'); icons.append(kitIcon(box.name), kitIcon(box.item.name))
      const caption = element('div', 'loadout-supply-caption'); caption.append(element('span', '', roles[box.role] || clean(box.role)), element('b', '', Number(box.total).toLocaleString('ja-JP')))
      card.append(icons, caption); return card
    }))
    $('reset-hand').replaceChildren(...[['bread', 'パン', m.hand.bread], ['dirt', '土', m.hand.dirt], ['arrow', '矢', m.hand.arrows]].map(([name, label, count]) => {
      const card = element('div', 'loadout-hand-item'); card.append(kitIcon(name), element('span', '', label), element('b', '', Number(count).toLocaleString('ja-JP'))); return card
    }))
  }
  function closeReset () { resetPreview = null; $('reset-dialog').close() }
  function renderReset () {
    const live = current?.live, r = live?.loadout
    const idleJob = !live?.quarry || ['IDLE', 'PAUSED', 'FINISHED'].includes(live.quarry.state)
    $('reset').disabled = !!busy || !token || !live?.ready || !r || r.busy || !idleJob
    $('reset').textContent = r?.busy ? 'デバッグチェスト設置中' : 'デバッグチェスト設置'
    $('reset-confirm').disabled = !!busy || !resetPreview || resetPreview.expiresAt <= Date.now() || resetPreview.session !== live?.session
    if (resetPreview && (resetPreview.session !== live?.session || resetPreview.expiresAt <= Date.now())) { closeReset(); message('reset', '確認が失効しました。デバッグチェストの設置を確認し直してください。', true) }
    $('reset-progress').hidden = !r || r.phase === 'idle'
    $('reset-progress').classList.toggle('failed', r?.phase === 'failed')
    $('reset-progress').classList.toggle('running', r?.busy === true)
    $('reset-stop').hidden = r?.busy !== true
    $('reset-icon').textContent = r?.busy ? '↻' : r?.serverConfirmed ? '✓' : '!'
    $('reset-state').textContent = r?.busy ? r.step || '開始確認中' : r?.serverConfirmed ? 'デバッグチェスト設置済み' : r?.phase === 'failed' ? 'チェスト設置未完了' : ''
    $('reset-detail').textContent = r?.error ? clean(r.error.message) + (r.stage ? ` / 一時箱 ${r.stage.x}, ${r.stage.y}, ${r.stage.z}` : '') : r?.supplyProgress ? `${r.supplyProgress.role}  ${r.supplyProgress.filled} / 27  ·  補給箱 ${r.suppliesCompleted} / 4` : ''
  }
  $('reset').addEventListener('click', () => {
    resetPreview = null
    act('reset', 'loadout', { command: 'resetPreview', session: current?.live?.session }, result => {
      const p = result.resetPreview
      resetPreview = { ...p, session: result.state.session }
      $('reset-world').textContent = clean(p.target.realm)
      $('reset-player').textContent = clean(p.target.player)
      showLoadoutKit(p.manifest)
      $('reset-stage').textContent = `X ${p.stage.x} / Y ${p.stage.y} / Z ${p.stage.z}`
      const rows = [...p.manifest.armor, ...p.manifest.tools].map(item => {
        const row = element('div', 'loadout-equipment-row')
        row.append(element('b', '', itemNames[item.name.replace('minecraft:', '')] || item.name), element('span', '', Object.entries(item.enchants).map(([n, l]) => `${enchantNames[n] || n} ${l}`).join(' / ')))
        return row
      })
      $('reset-equipment').replaceChildren(...rows)
      $('reset-dialog').showModal()
    })
  })
  for (const id of ['reset-close', 'reset-back']) $(id).addEventListener('click', closeReset)
  $('reset-dialog').addEventListener('cancel', () => { resetPreview = null })
  $('reset-dialog').addEventListener('close', () => { resetPreview = null })
  $('reset-confirm').addEventListener('click', () => {
    const p = resetPreview
    if (!p || busy || p.expiresAt <= Date.now() || p.session !== current?.live?.session) return
    closeReset(); plan = null; $('plan-results').hidden = true
    act('reset', 'loadout', { command: 'resetStart', session: p.session, resetToken: p.token, confirm: 'REPLACE_SURFACE_CHEST' }, () => message('reset', ''))
  })
  $('reset-stop').addEventListener('click', () => act('reset', 'loadout', { command: 'resetCancel', session: current?.live?.session }, () => message('reset', '中断を要求しました。途中結果を確認してください。')))

  request('session').then(data => { if (!data.enabled) throw new Error('管理操作は無効です。管理画面サーバーを更新してください。'); token = data.token; $('profile').value = data.profile; render(); return poll() }).catch(error => message('connection', error.message, true))
  render()
  setInterval(poll, 2000)
  setInterval(() => { if ((plan?.planToken || resetPreview) && !document.hidden) render() }, 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll() })
})()
