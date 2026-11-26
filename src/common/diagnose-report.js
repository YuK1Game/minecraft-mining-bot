'use strict'

// Read-only diagnostic summary builder for `.local/` runtime artifacts and
// optional `/status` payload. Never reads `.auth/` or `.env`.
const fs = require('node:fs')
const path = require('node:path')
const { inspectIncidentTerrain } = require('../modes/incident-replay')

function readJsonSafe (filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function toJstString (isoOrMs) {
  if (isoOrMs == null) return '不明'
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs))
  if (!Number.isFinite(ms)) return String(isoOrMs)
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} JST`
}

function listIncidents (root) {
  const dir = path.resolve(root, '.local', 'incidents')
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => path.join(dir, name))
  } catch {
    return []
  }
}

function summarizeIncidents (files) {
  const byType = new Map()
  const byGoal = new Map()
  let stalledTotal = 0
  let stalledCount = 0
  for (const filePath of files) {
    const doc = readJsonSafe(filePath)
    if (!doc) continue
    const typeKey = `${doc.source ?? 'unknown'}/${doc.code ?? 'UNKNOWN'}`
    byType.set(typeKey, (byType.get(typeKey) ?? 0) + 1)
    const goalKey = doc.goal?.key ?? null
    if (goalKey) byGoal.set(goalKey, (byGoal.get(goalKey) ?? 0) + 1)
    if (Number.isFinite(doc.goal?.stalledMs)) {
      stalledTotal += doc.goal.stalledMs
      stalledCount++
    }
  }
  const sortDesc = map => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }))
  return {
    total: files.length,
    avgStalledSec: stalledCount > 0 ? Math.round(stalledTotal / stalledCount / 1000) : null,
    topTypes: sortDesc(byType).slice(0, 6),
    topGoals: sortDesc(byGoal).slice(0, 5)
  }
}

function collectDiagnostics ({ root, incidentPath = null, liveStatus = null } = {}) {
  const baseRoot = path.resolve(root)
  const modeDoc = readJsonSafe(path.join(baseRoot, '.local', 'mode.json'))
  const playDoc = readJsonSafe(path.join(baseRoot, '.local', 'player-play.json'))
  const baseDoc = readJsonSafe(path.join(baseRoot, '.local', 'player-base.json'))
  const travelDoc = readJsonSafe(path.join(baseRoot, '.local', 'long-travel', 'current.json'))
  const incidents = listIncidents(baseRoot)
  const incidentSummary = summarizeIncidents(incidents)
  const chosenIncidentFile = incidentPath ? path.resolve(baseRoot, incidentPath) : incidents.at(-1) ?? null
  const incidentDoc = chosenIncidentFile ? readJsonSafe(chosenIncidentFile) : null
  const terrain = incidentDoc?.terrain ? inspectIncidentTerrain(incidentDoc.terrain) : null

  return {
    generatedAt: toJstString(Date.now()),
    mode: liveStatus?.mode?.mode ?? modeDoc?.mode ?? 'quarry',
    playerWanted: playDoc?.playing === true,
    baseChest: baseDoc?.chest ?? null,
    longTravel: travelDoc ? {
      phase: travelDoc.phase ?? null,
      destination: travelDoc.destination ?? null,
      savedAt: toJstString(travelDoc.savedAt)
    } : null,
    live: liveStatus ? {
      phase: liveStatus.phase ?? liveStatus.bot?.phase ?? null,
      dimension: liveStatus.dimension ?? liveStatus.bot?.dimension ?? null,
      health: liveStatus.health ?? liveStatus.bot?.health ?? null,
      position: liveStatus.position ?? liveStatus.bot?.position ?? null,
      hotReload: liveStatus.hotReload ? {
        generation: liveStatus.hotReload.generation ?? null,
        lastReloadAt: toJstString(liveStatus.hotReload.lastReloadAt),
        lastError: liveStatus.hotReload.lastError ?? null
      } : null
    } : null,
    incidentCount: incidents.length,
    incidentSummary,
    latestIncident: incidentDoc ? {
      file: path.relative(baseRoot, chosenIncidentFile).replace(/\\/g, '/'),
      capturedAt: toJstString(incidentDoc.capturedAt),
      source: incidentDoc.source ?? null,
      code: incidentDoc.code ?? null,
      stage: incidentDoc.stage ?? null,
      reason: incidentDoc.reason ?? null,
      world: incidentDoc.world ?? null,
      goal: incidentDoc.goal ?? null,
      journal: incidentDoc.journal ?? {},
      inventoryCount: incidentDoc.inventory?.known ? (incidentDoc.inventory.items ?? []).reduce((sum, i) => sum + (i.count ?? 0), 0) : null,
      inventoryKnown: incidentDoc.inventory?.known === true,
      topItems: (incidentDoc.inventory?.items ?? []).slice(0, 8).map(i => `${String(i.name ?? '').replace(/^minecraft:/, '')}x${i.count}`),
      terrain
    } : null
  }
}

function formatDiagnosticsText (report) {
  const lines = []
  lines.push(`=== MinecraftBot 診断サマリ (${report.generatedAt}) ===`)
  lines.push(`モード: ${report.mode} | プレイ継続希望: ${report.playerWanted ? 'はい' : 'いいえ'} | インシデント保存数: ${report.incidentCount}`)
  if (report.baseChest) {
    lines.push(`本拠点チェスト: (${report.baseChest.x}, ${report.baseChest.y}, ${report.baseChest.z})`)
  }
  if (report.live) {
    const pos = report.live.position ? `(${report.live.position.x?.toFixed?.(1) ?? report.live.position.x}, ${report.live.position.y?.toFixed?.(1) ?? report.live.position.y}, ${report.live.position.z?.toFixed?.(1) ?? report.live.position.z})` : '不明'
    lines.push(`稼働状態: phase=${report.live.phase ?? '?'} dim=${report.live.dimension ?? '?'} HP=${report.live.health ?? '?'} pos=${pos}`)
    if (report.live.hotReload) {
      lines.push(`ホットリロード: 世代=${report.live.hotReload.generation ?? '?'} 最終=${report.live.hotReload.lastReloadAt}${report.live.hotReload.lastError ? ` エラー=${report.live.hotReload.lastError}` : ''}`)
    }
  }
  if (report.longTravel) {
    const dest = report.longTravel.destination ? `(${report.longTravel.destination.x}, ${report.longTravel.destination.z})` : 'なし'
    lines.push(`長距離移動記録: phase=${report.longTravel.phase ?? '?'} 目的地=${dest} 保存=${report.longTravel.savedAt}`)
  }
  if (report.incidentSummary?.topTypes?.length) {
    const types = report.incidentSummary.topTypes.map(t => `${t.key}x${t.count}`).join(', ')
    const goals = report.incidentSummary.topGoals?.length ? ` | 頻出目標: ${report.incidentSummary.topGoals.map(g => `${g.key}x${g.count}`).join(', ')}` : ''
    const avg = report.incidentSummary.avgStalledSec != null ? ` | 平均停滞: ${report.incidentSummary.avgStalledSec}秒` : ''
    lines.push(`インシデント傾向: ${types}${goals}${avg}`)
  }
  if (!report.latestIncident) {
    lines.push('最新インシデント: なし（.local/incidents/ に記録はありません）')
    return lines.join('\n')
  }
  const inc = report.latestIncident
  lines.push(`--- 最新インシデント: ${inc.file} ---`)
  lines.push(`発生時刻: ${inc.capturedAt} | 種別: ${inc.source}/${inc.code} | 段階: ${inc.stage ?? '-'}`)
  if (inc.reason) lines.push(`理由: ${inc.reason}`)
  if (inc.world) {
    const f = inc.world.feet ? `(${inc.world.feet.x}, ${inc.world.feet.y}, ${inc.world.feet.z})` : '不明'
    lines.push(`状態: 次元=${inc.world.dimension ?? '?'} HP=${inc.world.health ?? '?'} 満腹度=${inc.world.hunger ?? '?'} 死亡=${inc.world.dead ? 'はい' : 'いいえ'} 足元=${f}`)
  }
  if (inc.goal) {
    const stalled = inc.goal.stalledMs != null ? `${Math.round(inc.goal.stalledMs / 1000)}秒` : '-'
    lines.push(`目標台帳: key=${inc.goal.key ?? '-'} id=${inc.goal.id ?? '-'} 停滞=${stalled} 判断回数=${inc.goal.decisions ?? 0}`)
  }
  const lanes = Object.entries(inc.journal ?? {})
  if (lanes.length) {
    lines.push(`直近判断: ${lanes.map(([lane, row]) => `${lane}=${row.key ?? '-'}(${row.turns ?? 0}回)`).join(' / ')}`)
  }
  lines.push(`持ち物: ${inc.inventoryKnown ? (inc.topItems.join(', ') || '空') : '未受信(?)'}`)
  if (inc.terrain?.available) {
    lines.push(`周辺地形(v${inc.terrain.version}): 既知=${inc.terrain.knownCells} 未受信=${inc.terrain.unknownCells} 空気=${inc.terrain.airCells} 固形=${inc.terrain.solidCells} 水=${inc.terrain.waterCells} 危険=${inc.terrain.hazardCells}`)
  }
  return lines.join('\n')
}

module.exports = {
  collectDiagnostics,
  formatDiagnosticsText,
  listIncidents,
  summarizeIncidents,
  toJstString
}
