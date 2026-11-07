/* Browser-only control UI. Inventory rendering remains independent. */
(() => {
  'use strict'
  const $ = id => document.getElementById('control-' + id)
  const phases = { offline: '未接続', starting: 'Botを起動中', authenticating: '認証中', selecting_realm: 'ワールド選択待ち', connecting: '接続中', joined: '地形を読込中', spawned: 'ワールドに参加中', stopping: '切断処理中', disconnected: '未接続' }
  let token = null, current = null, plan = null, busy = 0, polling = false, version = 0, viewEpoch = 0, lastPhase = null
  const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  function message (kind, text, error = false) { const el = $(kind + '-message'); el.textContent = text; el.classList.toggle('error', error) }
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
  function render () {
    const s = current, live = s?.live, q = live?.quarry, ready = live?.ready === true, connected = !!s?.managed || !!live, idle = !busy && !!token
    $('phase').textContent = phases[s?.phase] ?? '状態を確認中'
    $('profile').disabled = connected || busy > 0
    $('realms').disabled = !idle || !!live?.realm || s?.phase === 'connecting' || s?.phase === 'stopping' || s?.incompatible === true
    const old = $('world').value, options = s?.realms ?? []
    const signature = JSON.stringify(options)
    if ($('world').dataset.signature !== signature) {
      $('world').dataset.signature = signature
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = options.length ? 'ワールドを選択してください' : (live?.realm?.name || 'ワールド一覧を取得してください')
      $('world').replaceChildren(placeholder)
      for (const realm of options) { const option = document.createElement('option'); option.value = realm.id; option.textContent = clean(realm.name) + (realm.available ? '' : '（閉鎖・期限切れ・参加不可）'); option.disabled = !realm.available; $('world').append(option) }
      if (options.some(r => r.id === old && r.available)) $('world').value = old
    }
    $('world').disabled = !idle || s?.phase !== 'selecting_realm'
    $('connect').disabled = !idle || s?.phase !== 'selecting_realm' || !$('world').value
    $('disconnect').disabled = !token || !connected || s?.phase === 'stopping'
    $('here').disabled = !idle || !ready || !live?.chunk
    $('plan').disabled = !idle || !ready || !!q && !['IDLE', 'FINISHED'].includes(q.state)
    $('start').disabled = !idle || !ready || !plan?.planToken || plan.expiresAt <= Date.now() || plan.state.session !== live?.session || plan.plan.jobId !== q?.jobId || q?.state !== 'IDLE'
    $('pause').disabled = !idle || !q || ['IDLE', 'FINISHED', 'PAUSED', 'STOPPING'].includes(q.state)
    $('resume').disabled = !idle || !ready || q?.state !== 'PAUSED'
    $('emergency').disabled = !token || !q || q.state === 'FINISHED'
    $('cancel').disabled = !idle || !q || q.state === 'FINISHED'
    const auth = s?.auth
    $('auth').hidden = !auth || auth.expiresAt <= Date.now()
    if (auth) { $('auth-code').textContent = auth.code; $('auth-expiry').textContent = '有効期限 ' + new Date(auth.expiresAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' }
    $('live').textContent = live ? `接続先: ${clean(live.realm?.name || '選択待ち')} ／ ${clean(live.profile)} ／ ${clean(live.dimension || '未確認')}　${live.chunk ? `現在のチャンク (${live.chunk.x}, ${live.chunk.z})` : ''}　${q ? `ジョブ: ${q.jobId} ・ ${q.state}${q.pauseReason ? ' / ' + q.pauseReason : ''}` : 'ジョブ未設定'}${s.managed ? '' : ' （別ターミナルで起動中）'}` : '未接続。ワールド一覧を取得してから接続先を選択してください。'
    if (s?.message) message('connection', s.message, s.incompatible === true)
    else if (s?.phase !== lastPhase && ready) message('connection', '接続済み。指定範囲の計画を作成できます。')
    lastPhase = s?.phase
  }
  async function poll () {
    if (!token || polling || document.hidden) return
    const epoch = viewEpoch; polling = true
    try { const state = await request('state'); if (epoch === viewEpoch) { current = state; render() } }
    catch (error) { if (epoch === viewEpoch) { current = null; plan = null; message('connection', error.message, true); render() } }
    finally { polling = false }
  }
  async function act (kind, route, body, success) {
    busy++; viewEpoch++; render(); message(kind, '処理中…')
    try { const result = await request(route, body); if (result.state) current = { ...current, live: result.state, phase: result.state.phase }; await success?.(result); }
    catch (error) { message(kind, error.message, true) }
    finally { busy--; viewEpoch++; render(); await poll() }
  }
  function number (id, optional = false) {
    const el = $(id)
    if (optional && el.value.trim() === '') return null
    if (!el.value.trim() || !el.checkValidity() || !Number.isSafeInteger(Number(el.value))) { el.focus(); throw new Error('整数の座標を入力してください。') }
    return Number(el.value)
  }
  function config () {
    return { x1: number('x1'), z1: number('z1'), x2: number('x2', true), z2: number('z2', true), top: number('top', true), bottom: number('bottom', true), pickupMode: $('pickup').value,
      chest: $('chest-enabled').checked ? { x: number('chest-x'), y: number('chest-y'), z: number('chest-z') } : null }
  }
  const fields = ['x1', 'z1', 'x2', 'z2', 'top', 'bottom', 'pickup', 'chest-enabled', 'chest-x', 'chest-y', 'chest-z']
  function invalidate () { plan = null; version++; $('plan-results').hidden = true; $('chest-fields').hidden = !$('chest-enabled').checked; render() }
  for (const field of fields) $(field).addEventListener('input', invalidate)
  $('world').addEventListener('change', render)
  $('realms').addEventListener('click', () => act('connection', 'realms', { profile: $('profile').value.trim() }, result => { current = result; message('connection', '認証・ワールド一覧の取得を開始しました。') }))
  $('connect').addEventListener('click', () => act('connection', 'connect', { processId: current.processId, realmId: $('world').value }, result => { current = result; plan = null; message('connection', '接続を開始しました。参加位置と所持品を確認するまで開始ボタンは無効です。') }))
  $('disconnect').addEventListener('click', () => {
    if (!confirm('Botを切断します。採掘中なら停止と保存を行います。よろしいですか？')) return
    const live = current?.live
    act('connection', 'disconnect', { processId: current?.processId, session: live?.session, jobId: live?.quarry?.jobId ?? null }, () => { current = null; plan = null; message('connection', '切断処理を受け付けました。') })
  })
  $('here').addEventListener('click', () => { $('x1').value = current.live.chunk.x; $('z1').value = current.live.chunk.z; $('x2').value = ''; $('z2').value = ''; invalidate() })
  $('plan').addEventListener('click', () => {
    let value
    try { value = config() } catch (error) { message('action', error.message, true); return }
    const revision = version; plan = null
    act('action', 'quarry', { command: 'plan', session: current.live.session, config: value }, result => {
      if (revision !== version) { message('action', '入力が変わりました。もう一度計画を確認してください。'); return }
      plan = result; const p = result.plan
      $('plan-title').textContent = p.ready ? '計画の作成が完了しました' : '開始できません：以下を確認してください'
      $('plan-summary').textContent = `ワールド: ${clean(result.state.realm?.name)}\nチャンク: ${(p.chunks ?? []).map(c => `(${c.x}, ${c.z})`).join(' / ')}\n採掘範囲: Y=${p.yTop ?? '未確認'} 〜 ${p.yBottom}\n` + (p.issues.length ? '停止理由: ' + p.issues.join(' / ') + '\n' : '') + (p.warnings.length ? '注意: ' + p.warnings.join(' / ') : '')
      $('plan-results').classList.toggle('blocked', !p.ready)
      $('plan-results').hidden = false
      message('action', p.ready ? '範囲を確認して「露天掘りを開始」を押してください。計画は2分で失効します。' : '安全条件が未確認のため開始できません。', !p.ready)
    })
  })
  $('start').addEventListener('click', () => {
    if (!plan) return
    const p = plan
    if (!confirm(`${clean(p.state.realm?.name)} の ${(p.plan.chunks ?? []).map(c => `(${c.x}, ${c.z})`).join(' / ')} を Y=${p.plan.yTop}〜${p.plan.yBottom} まで露天掘りします。開始しますか？`)) return
    plan = null
    act('action', 'quarry', { command: 'start', session: p.state.session, planToken: p.planToken }, () => message('action', '開始指示を受け付けました。実際の進捗と停止理由は露天掘り欄で確認してください。'))
  })
  for (const [button, command, label] of [['pause', 'pause', '一時停止'], ['resume', 'resume', '再開'], ['emergency', 'emergencyStop', '緊急停止'], ['cancel', 'cancel', 'キャンセル']]) {
    $(button).addEventListener('click', () => {
      if (['resume', 'cancel'].includes(button) && !confirm(`現在のジョブを${label}しますか？`)) return
      plan = null
      act('action', 'quarry', { command, session: current?.live?.session, jobId: current?.live?.quarry?.jobId ?? null }, () => message('action', `${label}の結果を受信しました。現在の状態を確認してください。`))
    })
  }
  request('session').then(data => { if (!data.enabled) throw new Error('管理操作は無効です。管理画面サーバーを更新してください。'); token = data.token; $('profile').value = data.profile; render(); return poll() }).catch(error => message('connection', error.message, true))
  setInterval(poll, 2000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll() })
})()
