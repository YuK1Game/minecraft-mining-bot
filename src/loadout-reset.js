'use strict'

const { randomUUID, createHash } = require('node:crypto')
const { observedScope } = require('./server-position-verifier')
const { manifest, summary } = require('./loadout-manifest')
const fail = (code, message = code) => Object.assign(new Error(message), { code, status: 409 })
const copy = value => structuredClone(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) < 30000000)
const at = p => `${p.x} ${p.y} ${p.z}`
const air = b => b?.known === true && /^minecraft:(?:air|cave_air|void_air)$/.test(b.name) && !b.extra?.length && !b.protected && !b.protectionSource
const floor = b => b?.known === true && b.boundingBox === 'block' && !b.extra?.length && !/water|lava|magma|cactus|fire|powder_snow|campfire|portal/.test(b.name ?? '')
const samePoint = (a, b) => !!a && !!b && ['x', 'y', 'z'].every(k => a[k] === b[k])
function enchantMap (item) { return Object.fromEntries((item.enchantments ?? []).map(e => [e.name, e.level])) }
function matches (item, expected, { freshEmpty = false } = {}) {
  if (!expected) return item?.known === true && item.empty === true && item.count === 0
  if (!item?.known || item.empty || item.name !== expected.name || item.count !== expected.count || item.metadata !== 0) return false
  if (expected.enchants) {
    if (!item.enchantmentsKnown || JSON.stringify(Object.entries(enchantMap(item)).sort()) !== JSON.stringify(Object.entries(expected.enchants).sort())) return false
    if (item.durabilityApplicable && (!item.durabilityKnown || item.durabilityUsed !== 0)) return false
  }
  if (expected.contents) {
    const c = item.container
    if (!expected.contents.length) return c?.known === true && c.slots?.length === 27 && c.slots.every(x => x == null || x.empty) || freshEmpty && item.resetPlainEmptyBox === true
    if (!c?.known || c.slots?.length !== 27) return false
    if (!c.slots.every((entry, i) => matches(entry, expected.contents[i]))) return false
  }
  return true
}
function inventoryFingerprint (view) {
  // Observation timestamps aren't identity. Actual slots, stack IDs, NBT-derived
  // contents and enchantments are: a new pickup invalidates the confirmation.
  const strip = value => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([k]) => !['observedAt', 'selectedSlotSource', 'openContainer'].includes(k)).map(([k, v]) => [k, strip(v)])) : value
  return digest(strip({ slots: view.slots, armor: view.armor, offhand: view.offhand }))
}
function knownInventory (v) {
  return v?.known === true && !v.uncertain && v.slots?.length === 36 && v.slots.every(s => s?.known) && v.armor?.known === true && v.armor.slots.length === 4 && v.armor.slots.every(s => s?.known) && v.offhand?.known === true && v.offhand.slots?.[0]?.known
}
function emptyInventory (v) { return knownInventory(v) && [...v.slots, ...v.armor.slots, ...v.offhand.slots].every(s => s.empty === true) }

function createLoadoutReset ({ adapter, commands, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), uuid = randomUUID, observationTimeoutMs = 6000 } = {}) {
  const required = ['getState', 'getView', 'getBlock', 'assertIdle', 'acquire', 'release', 'cancelJob', 'save', 'load', 'select', 'equipArmor', 'open', 'close', 'deposit', 'container', 'cancelTransfers']
  if (required.some(k => typeof adapter?.[k] !== 'function') || typeof commands?.send !== 'function') throw new TypeError('Loadout reset requires authoritative inventory and isolated operations')
  let preview = null, task = null, abort = null, result = null, active = null, lastError = null
  const m = manifest()
  const publicError = e => ({ code: String(e?.code ?? 'RESET_FAILED').slice(0, 80), message: String(e?.message ?? e).slice(0, 400) })
  function scene () {
    const s = adapter.getState(), scope = observedScope(s)
    if (!scope || s.loadingScreenEnded !== true || s.dimension !== 'overworld' || !['survival', 0].includes(s.gameMode) || !s.position || !['x', 'y', 'z'].every(k => Number.isFinite(s.position[k]))) throw fail('RESET_NOT_READY', '生存・地形・所持品を受信したオーバーワールドで実行してください。')
    // This explicitly confirmed debug operation replaces the old inventory.
    // Missing initial equipment snapshots must not prevent its own receipt
    // bootstrap. Unresolved ordinary transfers are still a different condition.
    if (s.inventory?.uncertain || adapter.getView()?.uncertain) throw fail('RESET_INVENTORY_UNCERTAIN', '送信済みの持ち物操作が未確定です。')
    // Debug reset is permitted around players, hostiles and unknown actors.
    // Nonfatal damage/fire is not a cancellation; actual life/scope and inventory
    // receipts still determine whether the operation can continue.
    const feet = { x: Math.floor(s.position.x), y: Math.floor(s.position.y - 1.62 + 0.001), z: Math.floor(s.position.z) }
    if (!point(feet) || !floor(adapter.getBlock(feet.x, feet.y - 1, feet.z)) || !air(adapter.getBlock(feet.x, feet.y, feet.z)) || !air(adapter.getBlock(feet.x, feet.y + 1, feet.z))) throw fail('RESET_UNSAFE_STANCE', '乾いた足場の上で静止してください。')
    return { s, scope, feet }
  }
  function staging (feet) {
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const p = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
      if (!point(p) || p.y < -63 || p.y > 317 || adapter.protectedAt?.(p)) continue
      if (air(adapter.getBlock(p.x, p.y, p.z)) && air(adapter.getBlock(p.x, p.y + 1, p.z)) && floor(adapter.getBlock(p.x, p.y - 1, p.z)) && air(adapter.getBlock(feet.x + dx / 2, p.y + 1, feet.z + dz / 2))) return p
    }
    throw fail('RESET_STAGING_UNAVAILABLE', '近くに初期セットを組み立てる空き1マスがありません。平らで開けた場所へ移動してください。')
  }
  async function prepare () {
    if (task) throw fail('RESET_BUSY', 'リセット処理中です。')
    adapter.assertIdle()
    const { s, scope, feet } = scene(), prior = await adapter.load()
    // Never automatically delete a leftover box, even if a process was killed.
    if (prior && prior.phase !== 'completed' && prior.stage && prior.world === digest([s.profile, String(s.realm.id), s.dimension]) && !air(adapter.getBlock(prior.stage.x, prior.stage.y, prior.stage.z))) throw fail('RESET_STAGING_RECOVERY_REQUIRED', `前回の一時箱を確認してください: ${at(prior.stage)}。箱を回収し、空気の受信後に再確認できます。`)
    adapter.assertIdle()
    const after = scene()
    if (after.scope !== scope || !samePoint(after.feet, feet)) throw fail('RESET_SCOPE_CHANGED')
    const view = adapter.getView(), stage = staging(feet)
    preview = { token: uuid(), expiresAt: now() + 120000, scope, feet, stage, health: after.s.health, fingerprint: inventoryFingerprint(view), generation: adapter.generation?.() ?? 0, job: adapter.jobIdentity?.() ?? null }
    return { token: preview.token, expiresAt: preview.expiresAt, target: { player: s.playerName ?? s.profile, realm: s.realm.name, realmId: String(s.realm.id), dimension: s.dimension }, stage: copy(stage), manifest: summary(), replaces: { main: view.known ? view.slots.filter(s => !s.empty).length : null, armor: view.armor?.known ? view.armor.slots.filter(s => !s.empty).length : null, shulkers: view.known ? view.slots.filter(s => s.container).length : null } }
  }
  function guard () {
    abort?.signal.throwIfAborted()
    const { s, scope, feet } = scene()
    if (!active || scope !== active.scope || !samePoint(feet, active.feet) || (adapter.generation?.() ?? 0) !== active.generation) throw fail('RESET_CONTEXT_CHANGED', '接続・位置・コード世代が変わったため停止しました。')
    if (now() - active.beganAt > 600000) throw fail('RESET_DURATION_LIMIT', 'リセットの実行期限を超えました。途中結果を確認してください。')
    return s
  }
  async function checkpoint (stageLabel, extra = {}) {
    Object.assign(active, extra, { step: stageLabel, savedAt: now() })
    await adapter.save(copy(active))
  }
  async function waitFor (predicate, label) {
    const until = now() + observationTimeoutMs
    do { guard(); if (predicate()) return; await sleep(40) } while (now() < until)
    throw fail('RESET_OBSERVATION_UNCONFIRMED', `サーバーの更新を確認できません: ${label}`)
  }
  async function command (text, label) {
    guard(); await checkpoint(label, { pending: { type: 'command', command: text } }); guard()
    const receipt = await commands.send(text, { signal: abort.signal })
    guard()
    if (receipt?.serverConfirmed !== true || receipt.scope !== active.scope) throw fail('RESET_COMMAND_UNCONFIRMED')
    active.steps++; await checkpoint(label, { pending: null, lastCommand: { requestId: receipt.requestId, receivedAt: receipt.receivedAt } })
  }
  async function initializeReceipts () {
    const view = adapter.getView()
    if (knownInventory(view)) return
    await checkpoint('所持品を同期')
    // Only AFTER explicit confirmation and a successful operator probe, write
    // temporary known stacks into unobserved slots. A non-empty write forces a
    // real slot change even when clearing an already-empty slot sends nothing.
    // These stacks are removed by the ordinary reset below; no unknown value is
    // declared empty and no command acknowledgment substitutes for a slot packet.
    for (let slot = 0; slot < 36; slot++) {
      if (view.known === true && view.slots?.[slot]?.known === true) continue
      const where = slot < 9 ? `hotbar ${slot}` : `inventory ${slot - 9}`
      await command(`/replaceitem entity @s slot.${where} minecraft:bread 1`, '所持品を同期')
    }
    for (const [slot, piece] of ['head', 'chest', 'legs', 'feet'].entries()) {
      if (view.armor?.known === true && view.armor.slots?.[slot]?.known === true) continue
      await command(`/replaceitem entity @s slot.armor.${piece} 0 ${m.armor[slot].name} 1`, '防具を同期')
    }
    if (view.offhand?.known !== true || view.offhand.slots?.[0]?.known !== true) {
      await command('/replaceitem entity @s slot.weapon.offhand 0 minecraft:arrow 1', 'オフハンドを同期')
    }
    const until = now() + observationTimeoutMs
    do { guard(); if (knownInventory(adapter.getView())) return; await sleep(40) } while (now() < until)
    const after = adapter.getView(), missing = []
    if (after?.known !== true || after.slots?.length !== 36 || !after.slots.every(s => s?.known)) missing.push('所持品')
    if (after?.armor?.known !== true || after.armor.slots?.length !== 4 || !after.armor.slots.every(s => s?.known)) missing.push('防具')
    if (after?.offhand?.known !== true || !after.offhand.slots?.[0]?.known) missing.push('オフハンド')
    throw fail('RESET_OBSERVATION_UNCONFIRMED', `受信確認がタイムアウトしました: ${missing.join('・')}`)
  }
  async function selectConfirmedHand (slot, item) {
    const probe = `/testfor @s[hasitem={item=${item.name},location=slot.weapon.mainhand,quantity=1}]`
    for (let attempt = 0; attempt < 3; attempt++) {
      guard()
      const observed = adapter.getView().slots[slot]
      if (!observed?.known || observed.empty || observed.name !== item.name || observed.count !== 1) throw fail('RESET_HAND_CHANGED', '手持ちにする道具が変わりました。')
      await checkpoint('道具を選択', { pending: { type: 'selection', slot, name: item.name } })
      await adapter.select(slot, { signal: abort.signal }); guard()
      try {
        // Own mob_equipment is not necessarily echoed. Query the actual server
        // main hand instead of treating our cached selection/send as a receipt.
        await command(probe, '手持ちを確認')
        return
      } catch (error) {
        // Only an explicit negative answer to this read-only probe may retry.
        // No timeout, permission failure, mutation or enchant is auto-repeated.
        if (error.code !== 'RESET_COMMAND_REJECTED' || error.serverRejected !== true || !['commands.generic.noTargetMatch', 'commands.testfor.failure'].includes(error.messageId)) throw error
        if (attempt === 2) throw fail('RESET_HAND_UNCONFIRMED', 'サーバー側の手持ちを確認できません。道具の選択で停止しました。')
        await sleep(100)
      }
    }
  }
  async function heldItem (item) {
    await command(`/replaceitem entity @s slot.hotbar 0 ${item.name} ${item.count}`, '道具を準備')
    await waitFor(() => adapter.getView().slots[0]?.name === item.name && adapter.getView().slots[0]?.count === item.count, '手持ち道具')
    await selectConfirmedHand(0, item)
    for (const [name, level] of Object.entries(item.enchants)) await command(`/enchant @s ${name} ${level}`, 'エンチャント')
    await waitFor(() => matches(adapter.getView().slots[0], item), 'エンチャント付きアイテム')
  }
  async function openStage (name) {
    guard()
    const p = active.stage, b = adapter.getBlock(p.x, p.y, p.z)
    if (b?.known !== true || b.name !== name) throw fail('RESET_STAGE_CHANGED')
    await adapter.open(p); guard()
    const c = adapter.container()
    if (!c?.known || c.slots?.length !== 27 || !samePoint(c.position, p)) throw fail('RESET_CONTAINER_UNCONFIRMED')
    return c
  }
  async function run (acquisition) {
    try {
      await acquisition
      guard()
      if (inventoryFingerprint(adapter.getView()) !== active.confirmedFingerprint) throw fail('RESET_PREVIEW_STALE', '操作の終了中に所持品が変わりました。初期セットを確認し直してください。')
      await checkpoint('事前確認')
      // Read-only privilege probe first. A denial cannot erase inventory.
      await command('/testfor @s', '権限確認')
      await adapter.cancelJob(); guard()
      await checkpoint('初期化', { phase: 'running' })
      await initializeReceipts()
      if (adapter.getView().slots.some(s => !s.empty)) {
        await command('/clear @s', '所持品を初期化')
        await waitFor(() => adapter.getView().slots.every(s => s.empty), '空の所持品')
      }
      // Explicit equipment slots also cover servers where /clear does not
      // remove worn/offhand items. Never clear another player or ender chest.
      for (const [i, slot] of ['head', 'chest', 'legs', 'feet'].entries()) {
        if (!adapter.getView().armor.slots[i].empty) {
          await command(`/replaceitem entity @s slot.armor.${slot} 0 minecraft:air 1`, '防具を初期化')
          await waitFor(() => adapter.getView().armor.slots[i].empty, '空の防具枠')
        }
      }
      if (!adapter.getView().offhand.slots[0].empty) {
        await command('/replaceitem entity @s slot.weapon.offhand 0 minecraft:air 1', 'オフハンドを初期化')
        await waitFor(() => adapter.getView().offhand.slots[0].empty, '空のオフハンド')
      }
      if (!emptyInventory(adapter.getView())) throw fail('RESET_CLEAR_UNCONFIRMED')
      for (const box of m.supplies) {
        const p = active.stage
        if (!air(adapter.getBlock(p.x, p.y, p.z))) throw fail('RESET_STAGE_NOT_EMPTY')
        await command(`/setblock ${at(p)} ${box.name} keep`, '補給箱を準備')
        await waitFor(() => adapter.getBlock(p.x, p.y, p.z)?.name === box.name, '補給箱の設置')
        let contents = await openStage(box.name)
        if (!contents.slots.every(s => s.empty === true)) throw fail('RESET_STAGE_NOT_EMPTY')
        for (let i = 0; i < 27; i++) {
          const item = box.contents[i]
          if (Object.keys(item.enchants).length) {
            // Enchanted items use real player inventory + an acknowledged normal
            // transfer. /replaceitem's JSON cannot encode arbitrary item NBT.
            await heldItem(item)
            guard(); await checkpoint('補給工具を格納', { pending: { type: 'deposit', role: box.role, slot: i } })
            const transfer = await adapter.deposit({ sourceSlot: 0, chestSlot: i, count: 1, expectedName: item.name }); guard()
            if (transfer?.serverConfirmed !== true) throw fail('RESET_TRANSFER_UNCONFIRMED')
            await waitFor(() => matches(adapter.container()?.slots?.[i], item) && adapter.getView().slots[0]?.empty === true, '補給工具の格納')
            await checkpoint('補給工具を格納', { pending: null })
          } else await command(`/replaceitem block ${at(p)} slot.container ${i} ${item.name} ${item.count}`, '補給資材を格納')
          active.supplyProgress = { role: box.role, filled: i + 1, total: 27 }
        }
        await adapter.close(); contents = await openStage(box.name)
        if (!contents.slots.every((s, i) => matches(s, box.contents[i]))) throw fail('RESET_SUPPLY_CONTENTS_UNCONFIRMED')
        await adapter.close(); guard()
        await command(`/loot replace entity @s slot.inventory ${box.slot - 9} 1 mine ${at(p)} minecraft:diamond_pickaxe`, '補給箱を受け取る')
        await waitFor(() => matches(adapter.getView().slots[box.slot], box), '補給箱27枠の内容')
        // Re-open before deleting our temporary source. A changed template is
        // left in place for explicit recovery, never removed blindly.
        contents = await openStage(box.name)
        if (!contents.slots.every((s, i) => matches(s, box.contents[i]))) throw fail('RESET_STAGE_CONTENTS_CHANGED')
        // Empty the template before removal so container destruction cannot
        // spill a second copy of its contents into the world.
        for (let i = 0; i < 27; i++) await command(`/replaceitem block ${at(p)} slot.container ${i} minecraft:air 1`, '一時箱の中身を片付ける')
        await adapter.close(); contents = await openStage(box.name)
        if (!contents.slots.every(s => s.empty === true)) throw fail('RESET_STAGE_CLEAR_UNCONFIRMED')
        await adapter.close(); guard()
        await command(`/execute if block ${at(p)} ${box.name} run setblock ${at(p)} minecraft:air replace`, '一時箱を片付ける')
        await waitFor(() => air(adapter.getBlock(p.x, p.y, p.z)), '一時箱の片付け')
        active.suppliesCompleted++
      }
      active.supplyProgress = null
      for (const piece of m.armor) {
        await heldItem(piece)
        guard(); await checkpoint('防具を装備', { pending: { type: 'armor', name: piece.name } })
        const moved = await adapter.equipArmor(); guard()
        if (!Array.isArray(moved) || moved.length !== 1 || moved[0].serverConfirmed !== true) throw fail('RESET_ARMOR_UNCONFIRMED')
        await waitFor(() => adapter.getView().armor.slots.some(s => matches(s, piece)), '装着した防具')
        await checkpoint('防具を装備', { pending: null })
      }
      for (const box of m.cargo) {
        await command(`/replaceitem entity @s slot.inventory ${box.slot - 9} ${box.name} 1`, '空シュルカーを準備')
        await waitFor(() => matches(adapter.getView().slots[box.slot], box, { freshEmpty: true }), '空シュルカー')
      }
      for (let slot = 0; slot < m.hotbar.length; slot++) {
        const item = m.hotbar[slot]
        await command(`/replaceitem entity @s slot.hotbar ${slot} ${item.name} ${item.count}`, 'ホットバーを準備')
        await waitFor(() => adapter.getView().slots[slot]?.name === item.name && adapter.getView().slots[slot]?.count === item.count, 'ホットバー')
        if (Object.keys(item.enchants).length) {
          await selectConfirmedHand(slot, item)
          for (const [name, level] of Object.entries(item.enchants)) await command(`/enchant @s ${name} ${level}`, 'エンチャント')
        }
        await waitFor(() => matches(adapter.getView().slots[slot], item), 'ホットバーの初期装備')
      }
      await selectConfirmedHand(1, m.hotbar[1]); guard()
      const view = adapter.getView()
      if (!knownInventory(view) || !m.hotbar.every((item, i) => matches(view.slots[i], item)) || !m.armor.every((item, i) => matches(view.armor.slots[i], item)) || !m.supplies.every(item => matches(view.slots[item.slot], item)) || !m.cargo.every(item => matches(view.slots[item.slot], item, { freshEmpty: true })) || !m.emptySlots.every(i => matches(view.slots[i], null)) || !matches(view.offhand.slots[0], null) || !air(adapter.getBlock(active.stage.x, active.stage.y, active.stage.z))) throw fail('RESET_FINAL_MISMATCH', '初期セットの最終照合が一致しません。途中結果を確認してください。')
      // Save the successful inventory evidence before exposing completion.
      await checkpoint('最終保存', { phase: 'verified', completedAt: now(), verifiedInventory: view, serverConfirmed: false, pending: null })
      guard()
      // Completion is published only after all evidence has been persisted.
      await adapter.save({ ...copy(active), phase: 'completed', serverConfirmed: true })
      active.phase = 'completed'; active.serverConfirmed = true; active.step = '完了'
      result = { operationId: active.operationId, phase: 'completed', serverConfirmed: true, manifestVersion: m.version }
    } catch (error) {
      lastError = publicError(error)
      if (active) {
        active.phase = 'failed'; active.serverConfirmed = false; active.error = lastError
        try { await adapter.save(copy(active)) } catch (saveError) { lastError.persistenceError = String(saveError.message).slice(0, 180) }
      }
      result = { operationId: active?.operationId, phase: 'failed', serverConfirmed: false, error: lastError }
    } finally {
      try { await adapter.cancelTransfers(active?.operationId) } catch { /* Never treat this as rollback. */ }
      try { await adapter.close() } catch {}
      adapter.release(active?.operationId)
    }
  }
  function start ({ token, confirm } = {}) {
    const p = preview; preview = null // one shot, even a stale confirmation
    if (task) throw fail('RESET_BUSY')
    if (confirm !== 'REPLACE_INITIAL_INVENTORY' || !p || token !== p.token || p.expiresAt <= now()) throw fail('RESET_CONFIRMATION_REQUIRED', 'リセット内容を確認し直してください。')
    adapter.assertIdle(); const { s, scope, feet } = scene()
    if (scope !== p.scope || !samePoint(feet, p.feet) || (adapter.generation?.() ?? 0) !== p.generation || (adapter.jobIdentity?.() ?? null) !== p.job || inventoryFingerprint(adapter.getView()) !== p.fingerprint || !air(adapter.getBlock(p.stage.x, p.stage.y, p.stage.z))) throw fail('RESET_PREVIEW_STALE', '確認後に所持品・位置・接続・ジョブが変わりました。確認し直してください。')
    abort = new AbortController(); lastError = null; result = null
    active = { operationId: uuid(), version: 1, manifestVersion: m.version, phase: 'preparing', scope, confirmedFingerprint: p.fingerprint, generation: p.generation, feet, stage: p.stage, health: s.health,
      world: digest([s.profile, String(s.realm.id), s.dimension]), beganAt: now(), steps: 0, suppliesCompleted: 0, pending: null, serverConfirmed: false, inventoryBefore: adapter.getView() }
    // start() holds task synchronously; API callers never wait for hundreds of
    // commands, and an HTTP timeout cannot trigger an automatic second clear.
    let acquisition
    try { acquisition = adapter.acquire(active.operationId) } catch (error) {
      active = null; abort = null; lastError = publicError(error)
      throw error // No lease: never close/cancel someone else's inventory screen.
    }
    const work = Promise.resolve().then(() => run(acquisition))
    task = work.finally(() => { if (task === tracked) task = null })
    const tracked = task
    return status()
  }
  function cancel () { preview = null; abort?.abort(fail('RESET_CANCELLED', 'リセットを中断しました。部分的に置き換わった持ち物を確認してください。')); commands.cancel?.(); if (task && active) { try { Promise.resolve(adapter.cancelTransfers(active.operationId)).catch(() => {}) } catch {} } return status() }
  function status () { return { busy: !!task, operationId: active?.operationId ?? null, phase: active?.phase ?? 'idle', step: active?.step ?? null, steps: active?.steps ?? 0, suppliesCompleted: active?.suppliesCompleted ?? 0, supplyProgress: active?.supplyProgress ?? null, stage: active?.phase === 'failed' ? copy(active.stage) : null, serverConfirmed: !task && result?.serverConfirmed === true, error: lastError, result: copy(result) } }
  return { prepare, start, cancel, status, drain: () => task ?? Promise.resolve(), applyPacket: (...args) => commands.applyPacket(...args) }
}
module.exports = { createLoadoutReset, matches, knownInventory, emptyInventory, inventoryFingerprint }
