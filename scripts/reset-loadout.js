'use strict'

// Local cmd/PowerShell command. No auth cache is read and no Realm is joined.
// It talks only to the already-running Bot API, with its own session-bound,
// single-use preview token. A non-interactive invocation never clears items.
const { createInterface } = require('node:readline/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { requestControl } = require('./lib/dashboard-control')
const { normalizeChunkArea, areaContainsFeet, chunkAreaKey } = require('../src/chunk-area')
function currentChunkArea (state) {
  const proof = state?.positionProof, feet = proof?.feet
  const observedAt = typeof proof?.observedAt === 'number' ? proof.observedAt : Date.parse(proof?.observedAt)
  if (!state?.session || proof?.confirmed !== true || proof.session !== state.session ||
    !Number.isSafeInteger(proof.generation) || proof.generation < 0 || typeof proof.source !== 'string' || !/position/i.test(proof.source) || /prediction/i.test(proof.source) ||
    !Number.isFinite(observedAt) || observedAt > Date.now() || !Number.isFinite(proof.radius) || proof.radius < 0 || proof.radius > 1.5 ||
    !feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis]) && Math.abs(feet[axis]) <= 30000000)) throw new Error('Botの現在チャンクの実位置を確認できません。管理画面で位置を確認してください。')
  const x = Math.floor(feet.x / 16), z = Math.floor(feet.z / 16), area = normalizeChunkArea({ x1: x, z1: z, x2: x, z2: z })
  if (!areaContainsFeet(area, feet, proof.radius)) throw new Error('Botの実位置を1チャンク内に確認できません。管理画面で位置を確認してください。')
  return area
}
async function main (args = process.argv.slice(2), { request = requestControl, stdin = process.stdin, stdout = process.stdout, ask } = {}) {
  if (args.some(a => a !== '--preview') || args.length > 1) throw new Error('使い方: npm run loadout:reset [-- --preview]')
  const apiPort = Number(process.env.API_PORT ?? 3000)
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('API_PORT が不正です。')
  const state = await request({ apiPort })
  const area = currentChunkArea(state), session = state.session, generation = state.positionProof.generation
  const response = await request({ apiPort, payload: { command: 'resetPreview', session, area }, timeoutMs: 30000 })
  if (response.state?.session !== session || response.state?.positionProof?.generation !== generation || chunkAreaKey(currentChunkArea(response.state)) !== chunkAreaKey(area)) throw new Error('接続または確認した範囲が変わりました。再送せず管理画面で確認してください。')
  const p = response.resetPreview
  stdout.write(`\n${p.target.realm} / ${p.target.player}\n地上ラージチェスト初期セット ${p.manifest.version}\n空の収納用シュルカー22箱 + 補給4箱（ツルハシ27・シャベル27・土1728・トーテム27）\nダイヤ装備一式・ダイヤ剣・無限の弓・パン64・矢64\nチェスト: ${p.homeChest.position.x}, ${p.homeChest.position.y}, ${p.homeChest.position.z} と ${p.homeChest.other.x}, ${p.homeChest.other.y}, ${p.homeChest.other.z}\n一時箱: ${p.stage.x}, ${p.stage.y}, ${p.stage.z}\n地上ラージチェストの既存内容があれば初期セットに置き換えます。\n`)
  if (args.includes('--preview')) return { previewOnly: true }
  if (!ask && !stdin.isTTY) throw new Error('対話入力が必要です。非対話では --preview のみ利用できます。')
  const terminal = ask ? null : createInterface({ input: stdin, output: stdout })
  let answer
  try { answer = await (ask ?? (prompt => terminal.question(prompt)))('実行する場合だけ RESET と入力: ') } finally { terminal?.close() }
  if (answer !== 'RESET') { stdout.write('キャンセルしました。\n'); return { cancelled: true } }
  const latest = await request({ apiPort })
  if (latest?.session !== session || latest?.positionProof?.generation !== generation || chunkAreaKey(currentChunkArea(latest)) !== chunkAreaKey(area)) throw new Error('接続または確認した範囲が変わりました。再送せず管理画面で確認してください。')
  const started = await request({ apiPort, payload: { command: 'resetStart', session, resetToken: p.token, area, confirm: 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY' }, timeoutMs: 30000 })
  const id = started.reset.operationId; let last = ''
  for (let attempt = 0; attempt < 1250; attempt++) {
    const s = await request({ apiPort }), reset = s.loadout
    if (s.session !== session || reset?.operationId !== id) throw new Error('接続または操作が変わりました。再送せず管理画面で確認してください。')
    const message = `${reset.step ?? reset.phase}${reset.supplyProgress ? ` ${reset.supplyProgress.role} ${reset.supplyProgress.filled}/27` : ''}`
    if (message !== last) { stdout.write(message + '\n'); last = message }
    if (!reset.busy) {
      if (reset.phase !== 'completed' || reset.serverConfirmed !== true) throw new Error(reset.error?.message ?? 'リセットが完了していません。')
      stdout.write('サーバーの初期セットを確認しました。採掘は停止したままです。\n'); return reset
    }
    await delay(500)
  }
  throw new Error('確認期限を超えました。再送せず管理画面を確認してください。')
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { main }
