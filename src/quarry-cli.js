'use strict'

// Terminal syntax for quarry mode:
//   /quarry plan here [bottom=Y] [top=Y] [combat=off]
//   /quarry plan <chunkX> <chunkZ> [<chunkX2> <chunkZ2>] [options]
//   /quarry plan {json}
//   /quarry start | pause | stop | resume | cancel | accept | status | load <jobId>

const USAGE = '/quarry plan here|<cx> <cz> [<cx2> <cz2>] [bottom=Y] [top=Y] [combat=off] → /quarry start。ほか pause / stop(緊急停止) / resume / cancel / accept(例外を受け入れて完了) / status / load <jobId>'

function parseQuarryCommand (line, { position = null } = {}) {
  const rest = line.trim().replace(/^\/quarry\b/, '').trim()
  const [verb = 'status', ...args] = rest.split(/\s+/).filter(Boolean)
  const simple = { start: 'start', pause: 'pause', stop: 'emergencyStop', resume: 'resume', cancel: 'cancel', accept: 'acceptExceptions', status: 'status' }
  if (simple[verb]) return { method: simple[verb], args: [] }
  if (verb === 'load') { if (!args[0]) throw new Error('/quarry load <jobId>'); return { method: 'load', args: [args[0]] } }
  if (verb !== 'plan') throw new Error(USAGE)
  const raw = rest.slice(4).trim()
  if (raw.startsWith('{')) return { method: 'plan', args: [JSON.parse(raw)] }
  const options = {}; const words = []
  for (const a of args) { const m = /^([a-z]+)=(.+)$/.exec(a); if (m) options[m[1]] = m[2]; else words.push(a) }
  const config = {}
  if (words[0] === 'here') {
    if (!position || ![position.x, position.z].every(Number.isFinite)) throw new Error('現在位置が分かりません。')
    config.target = { chunks: [{ x: Math.floor(Math.floor(position.x) / 16), z: Math.floor(Math.floor(position.z) / 16) }] }
  } else {
    const n = words.map(Number)
    if (n.length === 2 && n.every(Number.isSafeInteger)) config.target = { chunks: [{ x: n[0], z: n[1] }] }
    else if (n.length === 4 && n.every(Number.isSafeInteger)) config.target = { rect: { x1: n[0], z1: n[1], x2: n[2], z2: n[3] } }
    else throw new Error(USAGE)
  }
  const int = (k, v) => { const x = Number(v); if (!Number.isSafeInteger(x)) throw new Error(`${k} は整数で指定してください。`); return x }
  if (options.bottom != null) config.yBottom = int('bottom', options.bottom)
  if (options.top != null) config.yTop = int('top', options.top)
  if (options.chest != null) throw new Error('収納先はシュルカー専用です。chest= は使用できません。')
  config.inventory = { pickupMode: 'passive', depositWhen: 'full' }
  if (options.combat === 'off') config.quarryCombat = { enabled: false }
  if (options.id) config.jobId = options.id
  return { method: 'plan', args: [config] }
}

module.exports = { parseQuarryCommand, QUARRY_USAGE: USAGE }
