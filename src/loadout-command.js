'use strict'

const { randomUUID } = require('node:crypto')
const { observedScope, uuidOf } = require('./server-position-verifier')
const fail = (code, message = code) => Object.assign(new Error(message), { code })
const BOUNDARY = new Set(['start_game', 'change_dimension', 'respawn', 'disconnect', 'close', 'death_info'])
// Intentionally not exported as a general operator console. Only these fixed
// self-targeted reset primitives are accepted, with no names/selectors from UI.
const ITEM = '(?:air|diamond_(?:sword|pickaxe|shovel|helmet|chestplate|leggings|boots)|bow|bread|dirt|arrow|(?:purple|blue|light_blue|yellow|brown)_shulker_box)'
const ENCHANT = '(?:protection|unbreaking|mending|thorns|respiration|aqua_affinity|swift_sneak|feather_falling|depth_strider|soul_speed|efficiency|fortune|silk_touch|sharpness|looting|fire_aspect|knockback|power|infinity|flame|punch)'
const HAND_PROBE = /^\/testfor @s\[hasitem=\{item=minecraft:(?:diamond_(?:sword|pickaxe|shovel|helmet|chestplate|leggings|boots)|bow),location=slot\.weapon\.mainhand,quantity=1\}\]$/
const POS = '-?\\d{1,8} -?\\d{1,3} -?\\d{1,8}'
// Command feedback is switched on only for a reset (2026-11-13): the gamerule
// itself and a probe that always fails (no such player) to tell a live but
// silent channel from a lost one.
const FEEDBACK_RULE = /^\/gamerule sendcommandfeedback (?:true|false)$/
const FAILURE_PROBE = '/testfor @s[name=__houchi_no_such_target__]'
const ALLOWED = [ /^\/testfor @s$/, HAND_PROBE, /^\/clear @s$/, FEEDBACK_RULE, /^\/testfor @s\[name=__houchi_no_such_target__\]$/,
  new RegExp(`^/replaceitem entity @s slot\\.(?:hotbar|inventory|weapon\\.offhand|armor\\.(?:head|chest|legs|feet)) \\d{1,2} minecraft:${ITEM}(?: (?:[1-9]|[1-5][0-9]|6[0-4]))?$`),
  new RegExp(`^/enchant @s ${ENCHANT} [1-5]$`),
  new RegExp(`^/setblock ${POS} minecraft:(?:purple|blue|light_blue|yellow|brown)_shulker_box keep$`),
  new RegExp(`^/execute if block ${POS} minecraft:(?:purple|blue|light_blue|yellow|brown)_shulker_box run setblock ${POS} minecraft:air replace$`),
  new RegExp(`^/replaceitem block ${POS} slot\\.container (?:[0-9]|1[0-9]|2[0-6]) minecraft:(?:(?:bread|dirt) 64|air 1)$`),
  new RegExp(`^/loot replace entity @s slot\\.inventory (?:2[0-3]) 1 mine ${POS} minecraft:diamond_pickaxe$`),
  new RegExp(`^/setblock ${POS} minecraft:chest keep$`),
  new RegExp(`^/replaceitem block ${POS} slot\\.container (?:[0-9]|[1-4][0-9]|5[0-3]) minecraft:(?:air|purple_shulker_box|blue_shulker_box|light_blue_shulker_box|yellow_shulker_box|brown_shulker_box|diamond_pickaxe|diamond_shovel|diamond_sword|diamond_helmet|diamond_chestplate|diamond_leggings|diamond_boots|bow|bread|arrow|dirt|totem_of_undying) (?:[1-9]|[1-5][0-9]|6[0-4])$`),
  new RegExp(`^/loot replace block ${POS} slot\\.container (?:[0-9]|[1-4][0-9]|5[0-3]) 1 mine ${POS} minecraft:diamond_pickaxe$`)
]
function allowed (command) {
  if (typeof command !== 'string' || command.length > 300 || !ALLOWED.some(p => p.test(command))) return false
  const chunks = command.split(' ')
  const coords = command.startsWith('/setblock ') ? [chunks.slice(1, 4)] : command.startsWith('/replaceitem block ') ? [chunks.slice(2, 5)] : command.startsWith('/loot replace block ') ? [chunks.slice(3, 6), chunks.slice(10, 13)] : command.startsWith('/loot ') ? [chunks.slice(8, 11)] : command.startsWith('/execute ') ? [chunks.slice(3, 6), chunks.slice(9, 12)] : []
  if (coords.some(p => !p.every(n => /^-?\d+$/.test(n)) || !p.every((n, i) => Number.isSafeInteger(Number(n)) && (i === 1 ? Number(n) >= -63 && Number(n) <= 317 : Math.abs(Number(n)) < 30000000)))) return false
  if (coords.length === 2 && command.startsWith('/execute ') && coords[0].join(' ') !== coords[1].join(' ')) return false
  return true
}
function createLoadoutCommand ({ client, getState, timeoutMs = 5000, now = Date.now, uuid = randomUUID }) {
  let pending = null
  const used = new Set()
  function settle (request, error, receipt) {
    if (pending !== request) return
    pending = null; clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort)
    error ? request.reject(error) : request.resolve(receipt)
  }
  function send (command, { signal } = {}) {
    if (!allowed(command)) return Promise.reject(fail('RESET_COMMAND_NOT_ALLOWED'))
    if (pending) return Promise.reject(fail('RESET_COMMAND_BUSY'))
    if (signal?.aborted) return Promise.reject(fail('RESET_CANCELLED'))
    const scope = observedScope(getState()), id = uuidOf(uuid())
    if (!scope || !id) return Promise.reject(fail('RESET_SCOPE_UNKNOWN'))
    if (used.has(id)) return Promise.reject(fail('RESET_COMMAND_ID_REUSED'))
    used.add(id)
    return new Promise((resolve, reject) => {
      const r = pending = { scope, id, command, signal, resolve, reject, sentAt: now() }
      r.abort = () => settle(r, fail('RESET_COMMAND_UNCONFIRMED', '送信済みコマンドの結果が未確認です。自動再送しません。'))
      r.timer = setTimeout(() => settle(r, fail('RESET_COMMAND_TIMEOUT', 'コマンド応答を確認できません。権限と現在の所持品を確認してください。')), timeoutMs)
      signal?.addEventListener('abort', r.abort, { once: true })
      try { client.queue('command_request', { command, origin: { type: 'player', uuid: id, request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' }) }
      catch (error) { settle(r, fail('RESET_COMMAND_UNCONFIRMED', String(error.message).slice(0, 240))) }
    })
  }
  function applyPacket (name, packet = {}) {
    const r = pending
    if (!r) return false
    if (BOUNDARY.has(name) || observedScope(getState()) !== r.scope) { settle(r, fail('RESET_SCOPE_CHANGED')); return true }
    if (name !== 'command_output' || uuidOf(packet.origin?.uuid) !== r.id) return false
    if (now() - r.sentAt > timeoutMs || now() < r.sentAt || packet.origin.type !== 'player' || !Number.isInteger(packet.success_count) || !Array.isArray(packet.output)) { settle(r, fail('RESET_COMMAND_OUTPUT_INVALID')); return true }
    const success = packet.success_count > 0 && packet.output.length > 0 && packet.output.every(o => o?.success === true && typeof o.message_id === 'string' && o.message_id.length > 0 && Array.isArray(o.parameters) && o.parameters.every(p => typeof p === 'string'))
    const messageId = String(packet.output[0]?.message_id ?? 'unknown').replace(/^%/, '').slice(0, 140)
    const explicitRejection = packet.success_count === 0 && packet.output.length === 1 && packet.output[0]?.success === false && typeof packet.output[0].message_id === 'string' && Array.isArray(packet.output[0].parameters) && packet.output[0].parameters.every(p => typeof p === 'string')
    if (!success) settle(r, Object.assign(fail('RESET_COMMAND_REJECTED', 'コマンドが拒否されました: ' + messageId), { messageId, serverRejected: explicitRejection }))
    else if (HAND_PROBE.test(r.command) && (packet.success_count !== 1 || packet.output.length !== 1 || messageId !== 'commands.testfor.success' || packet.output[0].parameters.length !== 1 || !packet.output[0].parameters[0] || getState().playerName && packet.output[0].parameters[0] !== getState().playerName)) settle(r, fail('RESET_HAND_OUTPUT_INVALID', '手持ち確認の応答が一致しません。'))
    else settle(r, null, { serverConfirmed: true, requestId: r.id, scope: r.scope, receivedAt: now() })
    return true
  }
  return { send, applyPacket, cancel: () => { if (pending) pending.abort() }, busy: () => !!pending }
}
module.exports = { createLoadoutCommand, allowed, FAILURE_PROBE }
