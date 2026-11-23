'use strict'

// What the Bot is after and which way it chose: one log line per decision.
//
// User, 2026-11-23 16:34 JST: 「もうちょうログ細く出せる？Botが何をしようとして、どういう行動の判断をしたか」.
// Before, the log held what a step did once it had answered (「プレイヤーモード: …」) and what failed. Which of
// the expedition's steps took the two seconds and what made it take them (health 12 or less, dusk, 35 slots, no
// weapon, a tree begun, a goal held), which thing a kit step was after and for what, and who had the player (the
// expedition or the ordinary work) were not in it: they had to be worked out from the lines around.
//
// One journal for every part that decides. A part says its decision each time it decides (every two seconds);
// the journal writes the line when the decision is another one:
// - `note(lane, key, text)`: a lane is one decider (「遠征」, 「持ち主」, ...). The key is the decision without its
//   numbers (the goal and the branch); the text carries the numbers (health, slots, counts) as they were when
//   the line was written.
// - The same key again writes nothing, and once in AGAIN_MS a line 「判断（N 分続いています）」, so that a reader
//   who comes in later finds what is going on.
// - Two decisions taking turns (A, B, A, B every two seconds) write each of them once in QUIET_MS, with the
//   number of turns in between.
// - A line is at most WIDE characters (the log cuts at about 260).
// The lanes are in `shared`, so a reload of the behaviour code does not write every decision again.
// The lines are a record only: nothing reads them back to decide.
const QUIET_MS = 30000, AGAIN_MS = 300000, KEEP = 16, WIDE = 230, SETTLE_MS = 200

const cut = text => text.length > WIDE ? text.slice(0, WIDE - 1) + '…' : text
const one = value => Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '?'
const cell = p => p && Number.isFinite(p.x) ? `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})` : null

function createJournal ({ shared, log = () => {}, now = Date.now }) {
  const book = shared.decisionJournal ??= {}
  function note (lane, key, text) {
    const at = now(), row = book[lane] ??= { key: null, since: 0, at: 0, seen: {}, turns: 0 }
    if (row.key === key) {
      if (at - row.at < AGAIN_MS) return false
      row.at = row.seen[key] = at
      log(cut(`判断（${Math.round((at - row.since) / 60000)} 分続いています）: ${text}`))
      return true
    }
    row.key = key
    row.since = at
    if (at - (row.seen[key] ?? -Infinity) < QUIET_MS) { row.turns++; return false }
    row.seen[key] = row.at = at
    const old = Object.keys(row.seen)
    if (old.length > KEEP) for (const name of old.sort((a, b) => row.seen[a] - row.seen[b]).slice(0, old.length - KEEP)) delete row.seen[name]
    log(cut(`判断: ${text}` + (row.turns ? `（この間に ${row.turns} 回入れ替わりました）` : '')))
    row.turns = 0
    return true
  }
  return { note }
}

// The expedition's side: `judge(branch, action, why)` for the step that takes these two seconds, and
// `judge.need(name, have, want)` for a thing a kit step sets out to get. Things asked for inside one another
// (a helmet, for it ingots, for them raw iron) are written as one line, left to right, once the asking has gone
// as deep as it goes: SETTLE_MS after the first one at the latest, and when the outermost one returns.
function expeditionJudge ({ journal, goal = () => null, later = (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer } }) {
  const tag = () => { const g = goal(); return g?.id ?? g?.key ?? '目的は未定' }
  const judge = (branch, action, why = null) => journal.note('遠征', `${tag()}|${branch}`, `遠征［${tag()}］ ${String(action).replace(/。$/, '')}` + (why ? `｜理由: ${why}` : ''))
  const stack = []
  let deepest = null, timer = null
  const flush = () => {
    timer = null
    const chain = deepest
    deepest = null
    if (chain) journal.note('遠征の調達', `${tag()}|${chain.map(part => part.name).join('<')}`, `遠征［${tag()}］ いま用意する物: ${chain.map(part => `${part.name} ${part.have}/${part.want}`).join(' ← ')}` + (chain.length > 1 ? '（左の物のために、右の物を先に用意します）' : ''))
  }
  judge.need = (name, have, want) => {
    stack.push({ name, have, want })
    if (!deepest || stack.length >= deepest.length) { deepest = stack.slice(); timer ??= later(flush, SETTLE_MS) }
    let left = false
    return () => { if (left) return; left = true; stack.pop(); if (!stack.length) flush() }
  }
  return judge
}

// Who has the player: the expedition or the ordinary work, and what the reading of the objective was.
const owner = (journal, { expedition, label = null, ahead = null }) => journal.note('持ち主', (expedition ? 'expedition' : 'crew') + '|' + (ahead ?? ''),
  `作業の持ち主は${expedition ? '遠征' : '通常の作業'}` + (label ? `｜いまの目的: ${String(label).replace(/。$/, '')}` : '') + (ahead ? `｜先に動いているもの: ${ahead}` : ''))

// The ordinary work's next action with what it is aimed at: 「次の行動: 理由［tunnel diamond → (x, y, z)］」.
function nextAction (decision) {
  const at = cell(decision?.resourceTarget ?? decision?.target ?? decision?.position ?? null)
  const aim = [decision?.type, decision?.resource ?? decision?.item ?? decision?.preparation ?? null, at && '→ ' + at].filter(Boolean).join(' ')
  return cut(`次の行動: ${decision?.reason ?? ''}` + (aim ? `［${aim}］` : ''))
}

module.exports = { createJournal, expeditionJudge, owner, nextAction, one, cell, QUIET_MS, AGAIN_MS, SETTLE_MS, WIDE }
