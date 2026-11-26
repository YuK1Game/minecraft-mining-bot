'use strict'

// Declarative spatial context evaluation & precondition exit middleware for player mode.
// Prevents ground-assuming tasks (house repair, foraging, surface sand/wool gathering,
// long-distance travel) from digging straight up through branch-mine ceilings or
// running inside enclosed structures without leaving properly first.
const { underCover } = require('./player-surface')
const { inside: insideHouse } = require('./house/house-exit')
const { insideMine } = require('./mining/mine-location')
const { wetColumn } = require('../movement/water-ledges')
const R = require('./return/return-result')

const BASE_YARD_RADIUS_M = 48

function finitePos (pos) {
  return Boolean(pos && [pos.x, pos.y, pos.z].every(Number.isFinite))
}

function readSpatialContext ({
  dimension = 'overworld',
  feet = null,
  position = null,
  getBlock = null,
  houseOrigin = null,
  baseChest = null,
  mineBranch = null,
  runtime = null
} = {}) {
  const resolvedFeet = finitePos(feet)
    ? { x: feet.x, y: feet.y, z: feet.z }
    : finitePos(position)
      ? { x: position.x, y: position.y - 1.62, z: position.z }
      : null
  const resolvedEye = finitePos(position)
    ? { x: position.x, y: position.y, z: position.z }
    : resolvedFeet
      ? { x: resolvedFeet.x, y: resolvedFeet.y + 1.62, z: resolvedFeet.z }
      : null

  const dim = dimension ?? 'overworld'
  let inBranchMine = false
  if (dim === 'overworld' && mineBranch?.plan && mineBranch?.shaft && (runtime || resolvedFeet)) {
    try {
      inBranchMine = insideMine({ runtime, getFeet: () => resolvedFeet }, mineBranch) === true
    } catch {
      inBranchMine = false
    }
  }

  const inStarterHouse = dim === 'overworld' && Boolean(houseOrigin && resolvedFeet && insideHouse(houseOrigin, resolvedFeet))
  const inWater = Boolean(getBlock && resolvedFeet && wetColumn(getBlock, resolvedFeet) !== null)
  const covered = Boolean(getBlock && resolvedEye && !inStarterHouse && underCover(getBlock, resolvedEye))
  const inBaseYard = dim === 'overworld' && Boolean(
    baseChest && resolvedFeet &&
    Math.hypot(resolvedFeet.x - baseChest.x, resolvedFeet.z - baseChest.z) <= BASE_YARD_RADIUS_M
  )

  let zone = 'unknown'
  if (dim === 'nether') zone = 'nether'
  else if (dim === 'end') zone = 'end'
  else if (!resolvedFeet) zone = 'unobserved'
  else if (inBranchMine) zone = 'branch_mine'
  else if (inWater) zone = 'water'
  else if (inStarterHouse) zone = 'starter_house'
  else if (covered) zone = 'underground'
  else if (inBaseYard) zone = 'base_yard'
  else zone = 'open_surface'

  return {
    dimension: dim,
    zone,
    feet: resolvedFeet,
    inBranchMine,
    inStarterHouse,
    inWater,
    covered,
    inBaseYard,
    openSurface: dim === 'overworld' && Boolean(resolvedFeet) && !inBranchMine && !inWater && !inStarterHouse && !covered
  }
}

async function ensureSpatialPreconditions (spatial, requirements = {}, exits = {}) {
  if (!requirements || typeof requirements !== 'object') {
    return R.completed('SPATIAL_READY', { evidence: { zone: spatial?.zone ?? 'unknown' } })
  }
  if (requirements.requireOverworld && spatial.dimension !== 'overworld') {
    return R.blocked('WRONG_DIMENSION', { kind: 'position_changed' }, {
      detail: `現世以外の次元 (${spatial.dimension}) では実行できません`,
      evidence: { dimension: spatial.dimension }
    })
  }
  if (requirements.forbidBranchMine !== false && spatial.inBranchMine) {
    if (typeof exits.leaveBranchMine !== 'function') {
      return R.blocked('INSIDE_BRANCH_MINE', { kind: 'position_changed' }, {
        detail: 'ブランチマイニング坑道内のため、縦坑のはしごからの退出が必要です',
        evidence: { zone: spatial.zone }
      })
    }
    const out = await exits.leaveBranchMine()
    if (out === false || out?.ok === false) {
      return R.failed('MINE_EXIT_FAILED', {
        detail: out?.reason ?? '採掘場のはしごから地上へ出られませんでした',
        evidence: { zone: spatial.zone }
      })
    }
    return R.partial('LEFT_BRANCH_MINE', {
      detail: '採掘場からはしごで退出を進めました',
      evidence: { zone: spatial.zone }
    })
  }
  if (requirements.requireDry && spatial.inWater) {
    if (typeof exits.exitWater !== 'function') {
      return R.blocked('IN_WATER', { kind: 'position_changed' }, { detail: '水中にいるため開始できません' })
    }
    const out = await exits.exitWater()
    if (!out?.ok) {
      return R.failed('WATER_EXIT_FAILED', { detail: out?.reason ?? '水から上がれませんでした' })
    }
    return R.partial('EXITED_WATER', { detail: '水から陸へ上がりました' })
  }
  if (requirements.leaveHouseFirst && spatial.inStarterHouse) {
    if (typeof exits.leaveHouse !== 'function') {
      return R.blocked('INSIDE_HOUSE', { kind: 'position_changed' }, { detail: '拠点の家の中にいるため開始できません' })
    }
    const ok = await exits.leaveHouse()
    if (!ok) {
      return R.failed('HOUSE_EXIT_FAILED', { detail: '家のドアから外へ出られませんでした' })
    }
    return R.partial('LEFT_HOUSE', { detail: '家の外へ出ました' })
  }
  if (requirements.requireOpenSky && spatial.covered) {
    if (typeof exits.climbToSurface !== 'function') {
      return R.blocked('UNDER_COVER', { kind: 'position_changed' }, { detail: '頭上が塞がっているため開始できません' })
    }
    const out = await exits.climbToSurface()
    if (!out?.ok) {
      return R.failed('SURFACE_CLIMB_FAILED', { detail: out?.reason ?? '地上へ出られませんでした' })
    }
    return R.partial('SURFACED', { detail: '地上へ出ました' })
  }
  return R.completed('SPATIAL_READY', { evidence: { zone: spatial?.zone ?? 'unknown' } })
}

module.exports = {
  BASE_YARD_RADIUS_M,
  readSpatialContext,
  ensureSpatialPreconditions
}
