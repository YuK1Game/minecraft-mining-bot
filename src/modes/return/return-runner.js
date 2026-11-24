'use strict'

// Drives the goal "back to the base, bank the cargo" (return-goal.js) through
// its stages (return-steps.js) and decides who holds the controls.
// - One entrance: tick(). While a goal exists no second one is made.
// - The goal is kept through a failed step, a fight, a meal, the night, a hot
//   reload and a restart; the work it interrupted is only started again when
//   the goal is met, held, given up or cancelled.
// - Handing over: the autonomy is asked to stop, its end is waited for (the
//   stop alone does not count), and only then a step begins. When the end is
//   not confirmed in time the answer is STOP_UNCONFIRMED and nothing starts.
// - Something with priority (flee, cover, shelter, another job, a fight, a
//   meal) interrupts: the running step ends at its next check, the goal waits
//   without starting anything, and afterwards the rest is planned again from
//   what is received then. Interrupted time is not charged to the budget.
// - A failure is remembered with the state it depends on (return-failures.js).
//   The third same failure, a loop, or a spent budget moves on: another chest,
//   or the goal is held: the controls are released, the work goes on, and the
//   goal wakes when what it waits for changes.
// - A manual stop or a mode change cancels the goal. A step that ends after
//   that belongs to an old generation and changes nothing.
const { normalizeMode } = require('../bot-mode')
const { writeDurableJson } = require('../../common/durable-json')
const { createFailureMemory } = require('./return-failures')
const { createReturnSteps } = require('./return-steps')
const { queueReturnWrite } = require('./return-persistence')
const { newGoal, restoreGoal, exhausted, attemptLimit, wakeReason, LABEL, BUDGET, cell, terrainCells } = require('./return-goal')
const { sidePoint } = require('./return-side')
const { createLaps, isBack } = require('./return-laps')
const { sourceRejected } = require('./transfer-recovery')

const NEXT = Object.freeze({ observe: 'surface', surface: 'travel', travel: 'approach', approach: 'container', container: 'store', store: 'verify', verify: 'replan' })
const DONE_MS = 30000, CLOSE_M = 6
const brief = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 100)

function createReturnRunner ({ getMode, shared, agent, ports, policy, scope = () => null, settled = () => true, interrupter = () => null, hostile = () => false, travelBusy = () => false, file = null, write = writeDurableJson, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), newId = () => `r${now().toString(36)}` }) {
  let goal = restoreGoal(shared.playerReturn), hostileSince = null, running = false, generation = 0, quietUntil = 0, banked = 0, saidUnsaved = false
  const memory = createFailureMemory({ now, saved: shared.playerReturnFailures })
  const laps = createLaps({ now })
  const playing = () => normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const live = () => !disposed() && playing()
  const say = text => log(`プレイヤーモード: 帰還${goal ? `[${goal.id}]` : ''} ${text}`)
  if (goal?.resumed) { delete goal.resumed; say(`を引き継ぎました（収納済み ${goal.progress.banked} 個・${goal.state === 'held' ? '保留中' : '状態の確認からやり直します'}）`) }

  // The goal as plain data, for the next runtime and the next process.
  function commit () {
    if (disposed()) return
    shared.playerReturn = goal ? JSON.parse(JSON.stringify({ ...goal, wait: null, interrupt: null, last: null, detour: null })) : null
    shared.playerReturnFailures = memory.serialize()
    if (!file) return
    const doc = { version: 1, goal: shared.playerReturn, failures: shared.playerReturnFailures, savedAt: new Date(now()).toISOString() }, owner = goal
    void queueReturnWrite(shared, file, doc, write).then(() => { if (owner) owner.saved = true; saidUnsaved = false }, error => {
      // Not saved: the goal goes on from shared; a restart would not know it.
      if (owner) owner.saved = false
      if (!saidUnsaved) { saidUnsaved = true; log(`プレイヤーモード: 帰還の記録を保存できません（再起動すると引き継げません） ${brief(error?.message)}`) }
    })
  }

  const restart = async mine => { const startingScope = scope(); for (let attempt = 0; attempt < 5 && mine === generation && live() && scope() === startingScope; attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const supplies = () => { try { return policy.supplies() } catch { return null } }
  const terrain = required => {
    const feet = ports.getFeet?.(), at = feet && cell({ ...feet, y: feet.y + 0.05 })
    const cells = terrainCells(required) ?? (at ? [-1, 0, 1].map(dy => ({ ...at, y: at.y + dy })) : null)
    return !!cells && cells.every(point => ports.getBlock(point.x, point.y, point.z)?.known === true)
  }
  const buildFree = () => { try { return typeof policy.buildHeld === 'function' && policy.buildHeld() === null } catch { return false } }
  const seenNow = () => ({ position: ports.getPosition(), supplies: supplies(), buildFree: buildFree(), inventoryKnown: !!ports.getInventory(), terrain: terrain(goal?.hold?.terrainCells), settled: settled(), owner: interrupter() ?? null, scope: scope(), now: now() })

  function end (state, code, text) {
    say(`${text}（${code}・収納済み ${goal.progress.banked} 個${goal.progress.taken ? `・取り出し ${goal.progress.taken} 個` : ''}・試行 ${goal.budget.attempts} 回）`)
    banked += goal.progress.banked
    goal = null
    commit()
  }

  // The controls are released and the work is planned again; the goal waits for a change.
  async function hold (mine, code, kinds, text, stage = goal.stage, retry = null) {
    if (goal.budget.wakes >= BUDGET.MAX_WAKES) { end('abandoned', code, `をあきらめます: ${text}`); quietUntil = now() + BUDGET.GIVE_UP_MS; await restart(mine); return false }
    // What the failure depends on decides what wakes the goal. A failure of
    // getting somewhere (out of the tunnel, the trip, the walk to the chest)
    // is looked at again from another place; a chest that is full or will not
    // open is not, wherever the Bot goes (live 2026-11-18 03:17-03:20 JST: held
    // for the chests, woken every 20 s by the mining below the base, given up
    // after 6 wakes in 3 minutes).
    const moving = ['surface', 'travel', 'approach'].includes(stage) || kinds.includes('position_changed')
    const all = [...new Set([...kinds, ...(moving ? ['position_changed'] : [])])]
    goal.state = 'held'; goal.wait = null; goal.interrupt = null
    // Deeper or higher counts as another place only for the way out of a tunnel.
    goal.hold = { code, at: now(), until: now() + BUDGET.HOLD_MS, position: cell(ports.getPosition()), supplies: supplies(), kinds: all, vertical: stage === 'surface', terrainCells: terrainCells(retry?.terrainCells) }
    say(`を保留します: ${text}（${code}・再評価の条件 ${all.join('/')}・遅くとも ${Math.round(BUDGET.HOLD_MS / 60000)} 分後）`)
    commit()
    await restart(mine)
    return false
  }

  // Whoever has the controls does not let go (live 2026-11-18 05:49-06:07 JST: a
  // recovery that never ended; the goal waited for it for eighteen minutes with
  // one line in the log, and by being active kept the other jobs waiting too).
  // The goal is held instead: nothing is started here, the work is left to its
  // owner, and the goal wakes when the controls are free.
  function park (who, waitedMs) {
    const text = `${who}が ${Math.round(waitedMs / 60000)} 分たっても終わりません`
    if (goal.budget.wakes >= BUDGET.MAX_WAKES) { end('abandoned', 'OWNER_NOT_RELEASED', `をあきらめます: ${text}`); quietUntil = now() + BUDGET.GIVE_UP_MS; return null }
    goal.state = 'held'; goal.wait = null; goal.interrupt = null
    goal.hold = { code: 'OWNER_NOT_RELEASED', at: now(), until: now() + BUDGET.HOLD_MS, position: cell(ports.getPosition()), supplies: supplies(), kinds: ['owner_free'], vertical: false }
    say(`を保留します: ${text}（OWNER_NOT_RELEASED・再評価の条件 owner_free・遅くとも ${Math.round(BUDGET.HOLD_MS / 60000)} 分後）。操作は始めていません`)
    commit()
    return null
  }

  // Asks the autonomy to stop and waits until its last operation has ended.
  async function takeControls (ok) {
    if (agent.running?.() === true) agent.stop('拠点へ資材を預けに行きます。')
    const until = now() + BUDGET.STOP_WAIT_MS
    while (ok() && !settled() && now() < until) await sleep(200)
    return settled()
  }

  function failure (out, stage = goal.stage) {
    const seen = memory.note({ scope: goal.scope, stage, target: out.evidence?.chest ?? goal.target ?? goal.base, code: out.code, state: out.evidence?.state ?? null })
    goal.budget.attempts++
    goal.last = { code: out.code, count: seen.count, retry: out.retry?.kind ?? null, at: now(), evidence: out.evidence ?? null }
    say(`${LABEL[stage]}に失敗: ${out.code}${out.detail ? ` ${brief(out.detail)}` : ''}（同じ条件で ${seen.count} 回目・全体 ${goal.budget.attempts}/${attemptLimit(goal)}・再試行の条件 ${out.retry?.kind ?? 'なし'}）`)
    return seen
  }

  // Another chest instead of the one that would not open or could not be reached.
  function alternative (out) {
    // A trip that gets nowhere from here: round to one side, then the other.
    const here = ports.getPosition()
    if (goal.stage === 'travel' && ['TRAVEL_NO_PROGRESS', 'DETOUR_NO_PROGRESS'].includes(out.code) && goal.base && here && goal.detours < BUDGET.DETOURS + goal.budget.wakes) {
      const angle = Math.atan2(goal.base.z - here.z, goal.base.x - here.x) + (goal.detours++ % 2 ? -1 : 1) * Math.PI / 2
      goal.detour = { x: Math.floor(here.x + Math.cos(angle) * BUDGET.DETOUR_M), z: Math.floor(here.z + Math.sin(angle) * BUDGET.DETOUR_M) }
      say(`ここからは拠点へ進めないため、回り道をします（(${goal.detour.x}, ${goal.detour.z}) 経由・${goal.detours} 回目）`)
      return true
    }
    const at = out.evidence?.chest
    if (!at || !['approach', 'container', 'store'].includes(goal.stage)) return false
    // A transfer refusal says nothing about whether the chest can be opened.
    // Keep its real cause and hold within the budget instead of replacing a
    // usable empty chest and eventually reporting a shortage of wood.
    if (!['CHEST_UNREACHED', 'CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE', 'CONTAINER_OPEN_REFUSED', 'CONTAINER_CONTENTS_UNKNOWN'].includes(out.code)) return false
    // Arrived, and no way to the chest from this side (live 2026-11-18 03:41 JST:
    // on the hill 15 blocks over the house, 「拠点の家の前まで歩けません（あと 17m、No
    // safe route found）」): round to another side with the long travel and in from there.
    const away = here ? Math.hypot(at.x + 0.5 - here.x, at.y + 0.5 - here.y, at.z + 0.5 - here.z) : 0
    if (goal.stage === 'approach' && out.code === 'CHEST_UNREACHED' && away > CLOSE_M && goal.sides < BUDGET.SIDES) {
      const porch = ports.chests.porch?.()?.stand ?? null
      goal.sides++
      goal.detour = sidePoint(at, here, goal.sides === 1 && porch && Math.hypot(porch.x - here.x, porch.z - here.z) > CLOSE_M * 2 ? porch : null)
      goal.stage = 'travel'
      say(`ここからはチェストへ近づけないため、別の側から近づきます（(${goal.detour.x}, ${goal.detour.z}) 経由・${goal.sides} 回目）`)
      return true
    }
    const list = ['CHEST_UNREACHED', 'CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE'].includes(out.code) ? goal.unreached : goal.unopened
    if (list.some(entry => entry.x === at.x && entry.y === at.y && entry.z === at.z)) return false
    list.push({ x: at.x, y: at.y, z: at.z })
    goal.target = null; goal.stage = 'container'
    say(`チェスト (${at.x}, ${at.y}, ${at.z}) は使えないため、別のチェストを試します（${out.code}。満杯とは扱いません）`)
    return true
  }

  function waitOver () {
    const wait = goal.wait
    if (!wait) return true
    const met = wait.kind === 'owner_released' ? settled() && !interrupter() : wait.kind === 'inventory_update' ? !!ports.getInventory() : wait.kind === 'terrain_received' ? terrain(wait.terrainCells) : false
    if (!met && now() < wait.until) return false
    goal.wait = null
    return true
  }

  // Another connection, dimension or life: nothing observed before is used.
  function rescope () {
    const current = scope()
    if (goal.scope === current) return false
    say('接続・次元・生存回が変わったため、今の状態から計画し直します')
    Object.assign(goal, { scope: current, stage: 'observe', target: null, detour: null, sides: 0, base: shared.playerBase ?? goal.base, full: [], fullObservations: {}, unopened: [], unreached: [], visited: [], wait: null, interrupt: null, pendingTransfer: null })
    if (goal.state === 'held') { goal.state = 'active'; goal.hold = null; goal.budget.wakes++ }
    memory.prune(current)
    commit()
    return true
  }

  async function drive (mine) {
    const current = () => mine === generation && live()
    if (!goal) {
      if (now() < quietUntil || interrupter() || travelBusy() || !policy.due()) { hostileSince = null; return null }
      // A hostile nearby delays the start, not for good: one that only stands there
      // (a skeleton on a ledge, live 2026-11-18 02:47 JST: 35/36 slots, 17 diamonds, no
      // trip) is left to the combat mode after a minute. A fight, a flee or a walk out
      // of the line of fire interrupts the trip whenever it comes.
      if (hostile()) {
        hostileSince ??= now()
        if (now() - hostileSince < BUDGET.HOSTILE_WAIT_MS) return null
        log(`プレイヤーモード: 近くの敵が ${Math.round((now() - hostileSince) / 1000)} 秒たっても戦闘にならないため、帰還を始めます（戦闘になれば中断します）`)
      }
      hostileSince = null
      goal = newGoal({ id: newId(), reason: policy.reason(), base: shared.playerBase ?? null, scope: scope(), origin: agent.objective, now: now() })
      say(`を始めます（${goal.reason}）`)
      commit()
    }
    rescope()
    if (goal.state === 'held') {
      const why = wakeReason(goal, seenNow())
      if (!why) return null
      goal.state = 'active'; goal.hold = null; goal.stage = 'observe'; goal.full = []; goal.fullObservations = {}; goal.unopened = []; goal.unreached = []; goal.visited = []; goal.kit = null; goal.sides = 0; goal.budget.wakes++
      say(`を再開します（${why}・${goal.budget.wakes} 回目の再評価）`)
      commit()
    }
    for (;;) {
      if (!current()) return null
      rescope()
      // A purpose can survive a new life or connection; an operation cannot.
      // Keep this authority fixed through every await of this step. Creating a
      // new step after rescope is the only way to acquire the new scope.
      const owner = goal, ownerScope = goal.scope
      const ok = () => current() && goal === owner && scope() === ownerScope
      const who = interrupter()
      if (who) {
        if (goal.interrupt?.who !== who) { goal.interrupt = { who, at: now() }; say(`${LABEL[goal.stage]}を中断して待ちます（${who}）。目的は保持します`) }
        else if (now() - goal.interrupt.at >= BUDGET.OWNER_WAIT_MS) return park(who, now() - goal.interrupt.at)
        return null
      }
      if (goal.interrupt) { say(`中断が終わったため、${LABEL[goal.stage]}から計画し直します（${goal.interrupt.who}・${Math.round((now() - goal.interrupt.at) / 1000)} 秒）`); goal.interrupt = null; if (!['observe', 'replan'].includes(goal.stage)) goal.stage = goal.stage === 'travel' || goal.stage === 'surface' ? 'surface' : 'approach' }
      if (!waitOver()) return null
      const spent = exhausted(goal)
      if (spent) return hold(mine, spent, ['supplies_changed'], '試行または時間の予算を使い切りました')
      if (!await takeControls(ok)) {
        if (!current() || goal !== owner) return null
        if (!ok()) continue
        const seen = failure({ code: 'STOP_UNCONFIRMED', retry: { kind: 'owner_released' }, detail: '前の操作の終了を確認できません' })
        if (seen.count >= BUDGET.STAGE_ATTEMPTS) return hold(mine, 'STOP_UNCONFIRMED', ['owner_released'], '前の操作の終了を確認できません', null)
        goal.wait = { kind: 'owner_released', until: now() + BUDGET.WAIT_MS }
        return null
      }
      if (!current() || goal !== owner) return null
      if (!ok() || interrupter()) continue
      if (goal.stage === 'replan') {
        end('done', 'RETURN_DONE', 'が完了しました。作業を計画し直します')
        quietUntil = now() + DONE_MS
        await restart(mine)
        return true
      }
      const stage = goal.stage, began = now()
      const steps = createReturnSteps({ goal: () => owner, ports: { ...ports, policy }, flow: { ok, interrupter, say, now, sleep } })
      let out = null
      try {
        // An unresolved source rejection survives hold/reload. Before any
        // further step (including a resumed approach), refresh it first.
        if (goal.pendingTransfer) {
          out = typeof ports.chests.hands.recoverTransfer === 'function'
            ? await ports.chests.hands.recoverTransfer(goal.pendingTransfer, { aborted: () => !ok() || !!interrupter() })
            : { status: 'failed', code: goal.pendingTransfer.code, hold: true, evidence: { transfer: goal.pendingTransfer.transfer } }
          if (out.status === 'completed') out = { ...out, next: 'observe' }
        } else out = await steps[stage]()
      } catch (error) { out = { status: 'failed', code: 'STEP_THREW', detail: error?.message, progress: {}, evidence: null, retry: null } }
      if (!current() || goal !== owner || goal.stage !== stage) return null
      // The step began in another connection, dimension or life: its answer is not used.
      if (!ok()) continue
      const transfer = out.evidence?.transfer
      if (sourceRejected(transfer?.rejectionProof)) {
        goal.pendingTransfer = transfer.recovery?.freshMainObserved === true && transfer.recovery.inventoryKnown === true ? null : { code: goal.pendingTransfer?.code ?? (stage === 'verify' ? 'WITHDRAW_REFUSED' : 'TRANSFER_REJECTED'), transfer }
        commit()
      }
      if (out.status !== 'interrupted') goal.budget.activeMs += now() - began
      if (out.status === 'cancelled') return null
      if (out.status === 'completed' || out.status === 'partial') {
        const to = out.next ?? (out.status === 'completed' ? NEXT[stage] : stage)
        memory.progress()
        goal.budget.interrupts = 0
        if (to !== stage) { say(`${LABEL[stage]} → ${LABEL[to]}（${out.code}）`); goal.stage = to; goal.stageAt = now() }
        commit()
        // A step back is never taken in the same instant, and the same one from the same place is a loop (return-laps.js).
        if (isBack(stage, to)) {
          if (laps.back({ from: stage, to, code: out.code, target: goal.target, position: ports.getPosition() })) return hold(mine, 'STAGE_LOOP', ['position_changed'], `${LABEL[stage]}と${LABEL[to]}の間を進まずに行き来しています（${out.code}）`, stage)
          await sleep(BUDGET.LAP_WAIT_MS)
          if (!current() || goal !== owner) return null
        }
        continue
      }
      if (out.status === 'interrupted') {
        // Something with priority has the controls: the goal waits for it and
        // nothing is charged, however often (live 2026-11-18 04:18-04:22 JST: the
        // eleventh flee in a row was counted as a failure, 9 of 12 tries).
        if (interrupter()) continue
        // An interruption nobody owns any more is tried again; many in a row count as a failure.
        if (++goal.budget.interrupts <= BUDGET.MAX_INTERRUPTS) { goal.wait = { kind: 'time', until: now() + 2000 }; continue }
        goal.budget.interrupts = 0
        out = { ...out, status: 'failed', code: 'INTERRUPTED_REPEATEDLY' }
      }
      const seen = failure(out, stage)
      if (out.next) goal.stage = out.next
      commit()
      // Nothing here can change it (the base is in another dimension): held at once.
      if (out.hold === true) return hold(mine, out.code, [], `${LABEL[stage]}を続けられません`, stage)
      if (seen.count >= BUDGET.STAGE_ATTEMPTS || seen.cycle) {
        if (alternative(out)) { commit(); continue }
        return hold(mine, out.code, out.retry?.kind && out.retry.kind !== 'now' && out.retry.kind !== 'time' ? [out.retry.kind] : [], seen.cycle ? '同じ失敗を繰り返しています' : `${LABEL[stage]}が同じ条件で ${seen.count} 回失敗しました`, stage, out.retry)
      }
      if (out.status === 'blocked' && out.retry && out.retry.kind !== 'now') goal.wait = { kind: out.retry.kind, terrainCells: terrainCells(out.retry.terrainCells), until: now() + (out.retry.timeoutMs ?? out.retry.ms ?? BUDGET.WAIT_MS) }
      // The same step again, but not in the same instant.
      else if (out.status === 'failed') goal.wait = { kind: 'time', until: now() + BUDGET.RETRY_MS }
    }
  }

  async function tick () {
    if (disposed()) return null
    if (!playing()) { if (goal) cancel(normalizeMode(getMode()) === 'player' ? 'MANUAL_STOP' : 'MODE_CHANGED'); return null }
    if (running) return null
    running = true
    const mine = generation
    try { return await drive(mine) } catch (error) { log(`プレイヤーモード: 帰還の処理に失敗 ${brief(error?.message)}`); return false } finally { running = false }
  }

  // A manual stop or a mode change: the goal is dropped and nothing is started.
  function cancel (code = 'MANUAL_STOP') {
    generation++
    if (!goal) return false
    end('cancelled', code, 'を取り消しました')
    return true
  }

  function status () {
    const active = goal?.state === 'active'
    return {
      active,
      // An operation of this goal is in flight now (a waiting goal has none).
      working: running,
      reason: active ? `拠点へ資材を預けに行きます（${LABEL[goal.stage]}${goal.interrupt ? `・${goal.interrupt.who}のため待機` : ''}）。` : null,
      banked: banked + (goal?.progress.banked ?? 0),
      base: shared.playerBase ?? null,
      goal: goal ? { id: goal.id, state: goal.state, stage: goal.stage, reason: goal.reason, scope: goal.scope, banked: goal.progress.banked, taken: goal.progress.taken, remaining: goal.remaining, lastProgressAt: goal.progress.lastAt, lastProgress: goal.progress.last, attempts: goal.budget.attempts, attemptLimit: attemptLimit(goal), activeMs: goal.budget.activeMs, wakes: goal.budget.wakes, last: goal.last, wait: goal.wait, hold: goal.hold ? { code: goal.hold.code, kinds: goal.hold.kinds, until: goal.hold.until } : null, interrupt: goal.interrupt, saved: goal.saved, owner: active && !goal.interrupt && running ? 'return' : null } : null
    }
  }

  return { tick, cancel, status, memory }
}

module.exports = { createReturnRunner }
