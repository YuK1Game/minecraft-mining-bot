'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createBotLog } = require('../src/host/bot-log')
const { createCloudWatchLog } = require('../src/host/cloudwatch-log')
const { displayText } = require('../src/host/realms')

async function logFile (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudwatch-host-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'bot.log')
}

test('host log preserves local display and sends the original messages with matching full timestamps', async t => {
  const file = await logFile(t), output = [], delivered = []
  const timestamps = [Date.UTC(2026, 10, 21, 14, 59, 59, 123), Date.UTC(2026, 10, 21, 15, 0, 0, 456)]
  const messages = ['採掘終了\n\u00a7a次の区間へ', '受信した詳細: ' + '日本語'.repeat(100)]
  const env = { BOT_PROFILE: 'integration' }
  let ticks = 0, cloudClosed = false
  const logger = createBotLog({
    file, env, now: () => timestamps[ticks++], output: line => output.push(line),
    createCloudLog: options => {
      assert.equal(options.env, env)
      return { write: (message, timestamp) => delivered.push({ message, timestamp }), close: async () => { cloudClosed = true } }
    }
  })
  for (const message of messages) assert.equal(logger.log(message), undefined)
  await Promise.all([logger.liveLog.close(), logger.cloudLog.close()])
  const expected = [`[23:59:59.123 JST] ${displayText(messages[0])}`, `[00:00:00.456 JST] ${displayText(messages[1])}`]
  assert.deepEqual(output, expected)
  assert.equal(await fs.readFile(file, 'utf8'), expected.join('\n') + '\n')
  assert.deepEqual(delivered, messages.map((message, index) => ({ message, timestamp: timestamps[index] })))
  assert.equal(ticks, 2, 'one wall-clock reading per event shared by local and remote logs')
  assert.equal(cloudClosed, true)
})

test('cloud diagnostics stay in the console and local log without recursively sending themselves', async t => {
  const file = await logFile(t), output = [], delivered = []
  const logger = createBotLog({
    file, now: () => Date.UTC(2026, 10, 21, 15, 0), output: line => output.push(line),
    createCloudLog: ({ report }) => {
      report('CloudWatch: 送信を準備しました')
      return { write: message => { delivered.push(message); report('CloudWatch: 一時的に送信できません') }, close: async () => {} }
    }
  })
  logger.log('Bot の作業ログ')
  await Promise.all([logger.liveLog.close(), logger.cloudLog.close()])
  assert.deepEqual(delivered, ['Bot の作業ログ'])
  assert.deepEqual(output, ['CloudWatch: 送信を準備しました', 'Bot の作業ログ', 'CloudWatch: 一時的に送信できません'].map(message => `[00:00:00.000 JST] ${message}`))
  assert.equal(await fs.readFile(file, 'utf8'), output.join('\n') + '\n')
})

test('importing the real host does not initialize CloudWatch or schedule work even when keys are present', () => {
  const host = require.resolve('../src/host/host')
  const script = `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const load = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === './cloudwatch-log' || request.startsWith('@aws-sdk/')) throw new Error('CloudWatch must stay lazy on host import')
      return load.call(this, request, parent, isMain)
    }
    global.setTimeout = global.setInterval = () => { throw new Error('Host import must not schedule background work') }
    assert.equal(typeof require(${JSON.stringify(host)}).main, 'function')
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLOUDWATCH_ACCESS_KEY_ID: 'test-id', CLOUDWATCH_SECRET_ACCESS_KEY: 'test-secret' }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})

test('the real host shutdown awaits both local persistence and cloud delivery within its existing deadline', async t => {
  const file = await logFile(t), host = require.resolve('../src/host/host')
  const script = `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const { createBotLog } = require(${JSON.stringify(require.resolve('../src/host/bot-log'))})
    const load = Module._load, exit = process.exit.bind(process), later = global.setTimeout
    const delivered = []
    let closeStarted = false, closeFinished = false, localFinished = false, deadlineSeen = false
    global.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) deadlineSeen = true
      return later(callback, delay, ...args)
    }
    Module._load = function (request, parent, isMain) {
      if (request.startsWith('@aws-sdk/')) throw new Error('AWS transport is forbidden in this fixture')
      if (request === './config' && parent.filename === ${JSON.stringify(host)}) return { loadConfig: () => ({ profile: 'offline-host-test', port: 3000, authDir: ${JSON.stringify(path.dirname(file))} }) }
      if (request === './bot-log' && parent.filename === ${JSON.stringify(host)}) return {
        createBotLog: options => {
          const logger = createBotLog({ ...options, file: ${JSON.stringify(file)}, env: {}, createCloudLog: ({ report }) => ({
            write: (message, timestamp) => delivered.push({ message, timestamp }),
            close: () => {
              closeStarted = true
              return new Promise(resolve => setImmediate(() => {
                assert.equal(logger.liveLog.snapshot().closing, false, 'local log must still accept the final cloud diagnostic')
                report('CloudWatch Logs: UNSENT_LOG_EVENTS（テスト）')
                closeFinished = true
                resolve()
              }))
            }
          }) })
          const closeLocal = logger.liveLog.close
          logger.liveLog.close = () => {
            assert.equal(closeFinished, true, 'local close must follow cloud close')
            return closeLocal().then(() => { localFinished = true })
          }
          return logger
        }
      }
      if (request === './realm-join' && parent.filename === ${JSON.stringify(host)}) return { installRealmJoinHandling: () => () => {} }
      if (request === 'bedrock-protocol') return { createClient: () => { throw new Error('Minecraft connections are forbidden in this fixture') } }
      if (request === 'bedrock-protocol/src/options') return { CURRENT_VERSION: '1.26.60', Versions: { '1.26.60': true } }
      if (request === 'prismarine-auth') return { Authflow: class {}, Titles: { MinecraftNintendoSwitch: 'offline-test' } }
      if (request === 'prismarine-realms') return { RealmAPI: { from: () => ({ getRealms: async () => [{ id: '1', name: 'Offline fixture', state: 'OPEN' }] }) } }
      if (request === 'prismarine-realms/src/rest' || request === 'node-fetch') return () => { throw new Error('Network is forbidden in this fixture') }
      return load.call(this, request, parent, isMain)
    }
    process.argv = [process.execPath, ${JSON.stringify(host)}, '--list']
    process.exit = code => {
      assert.equal(code, 0)
      assert.equal(closeStarted, true)
      assert.equal(closeFinished, true, 'host must wait for cloud close before exiting')
      assert.equal(localFinished, true, 'host must persist the final local diagnostic before exiting')
      assert.equal(deadlineSeen, true, 'existing five-second host deadline stays in place')
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].message, 'ログイン用プロフィール: offline-host-test')
      assert.equal(Number.isSafeInteger(delivered[0].timestamp), true)
      console.log('HOST_LOG_CLOSE_CONFIRMED')
      exit(0)
    }
    require(${JSON.stringify(host)}).main().catch(error => { console.error(error); exit(2) })
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /HOST_LOG_CLOSE_CONFIRMED/)
  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\.\d{3} JST\] ログイン用プロフィール: offline-host-test$/)
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\.\d{3} JST\] CloudWatch Logs: UNSENT_LOG_EVENTS（テスト）$/)
})

test('real local and CloudWatch publishers deliver the same events without a slow remote blocking the local file', async t => {
  const file = await logFile(t), output = [], requests = []
  let timestamp = Date.UTC(2026, 10, 21, 14, 59, 59, 123), release, entered
  const pending = new Promise(resolve => { release = resolve })
  const sending = new Promise(resolve => { entered = resolve })
  const first = '採掘の実行詳細: ' + '日本語'.repeat(100), second = '次の区間へ移動'
  const logger = createBotLog({
    file, now: () => timestamp, output: line => output.push(line),
    env: { CLOUDWATCH_ACCESS_KEY_ID: 'test-access-id', CLOUDWATCH_SECRET_ACCESS_KEY: 'test-secret', CLOUDWATCH_LOG_STREAM: 'STORM/bot' },
    createCloudLog: options => createCloudWatchLog({
      ...options, now: () => timestamp, flushIntervalMs: 60000,
      transport: { send: async (input, { signal }) => { requests.push(input); assert.equal(signal.aborted, false); entered(); return pending }, close () {} }
    })
  })
  try {
    logger.log(first)
    timestamp += 1000
    logger.log(second)
    assert.equal(requests.length, 0, 'write does not synchronously start the remote transport')
    const flush = logger.cloudLog.flush()
    await sending
    await logger.liveLog.flush()
    assert.equal(logger.cloudLog.snapshot().sentEvents, 0, 'a pending request is not counted as delivered')
    assert.equal(await fs.readFile(file, 'utf8'), output.join('\n') + '\n', 'local persistence finishes while AWS delivery is still pending')
    assert.deepEqual(requests, [{
      logGroupName: '/minecraft-bot/personal', logStreamName: 'STORM/bot',
      logEvents: [{ message: first, timestamp: timestamp - 1000 }, { message: second, timestamp }]
    }])
    assert.ok(output.includes(`[23:59:59.123 JST] ${displayText(first)}`))
    assert.ok(output.includes(`[00:00:00.123 JST] ${second}`))
    release({})
    await flush
    assert.equal(logger.cloudLog.snapshot().sentEvents, 2)
    assert.equal(logger.cloudLog.snapshot().queuedEvents, 0)
  } finally {
    release({})
    await Promise.all([logger.liveLog.close(), logger.cloudLog.close()])
  }
})

test('without dedicated keys the real CloudWatch publisher stays disabled and local logging still works', async t => {
  const file = await logFile(t), output = []
  let sends = 0
  const logger = createBotLog({
    file, env: {}, output: line => output.push(line),
    createCloudLog: options => createCloudWatchLog({ ...options, transport: { send: async () => { sends++ }, close () {} } })
  })
  logger.log('CloudWatch 未設定でも通常どおり稼働')
  await Promise.all([logger.liveLog.close(), logger.cloudLog.close()])
  assert.equal(sends, 0)
  assert.equal(logger.cloudLog.snapshot().enabled, false)
  assert.equal(await fs.readFile(file, 'utf8'), output.join('\n') + '\n')
  assert.equal(output.length, 1)
})

test('the production SDK adapter uses only dedicated credentials and wires PutLogEvents, cancellation and cleanup', async t => {
  const file = await logFile(t)
  const script = `
    const assert = require('node:assert/strict')
    const Module = require('node:module'), load = Module._load
    const timestamp = Date.UTC(2026, 10, 21, 15, 0)
    let loads = 0, sends = 0, destroyed = 0
    class PutLogEventsCommand { constructor(input) { this.input = input } }
    class CloudWatchLogsClient {
      constructor(options) {
        assert.equal(options.region, 'ap-northeast-1')
        assert.deepEqual(options.credentials, { accessKeyId: 'dedicated-test-key', secretAccessKey: 'dedicated-test-secret', sessionToken: 'dedicated-test-session' })
        assert.equal(options.ignoreConfiguredEndpointUrls, true)
        assert.equal(options.maxAttempts, 1)
        assert.equal(options.requestHandler.connectionTimeout, 2000)
        assert.equal(options.requestHandler.requestTimeout, 2000)
        assert.equal(options.requestHandler.throwOnRequestTimeout, true)
      }
      async send(command, options) {
        sends++
        assert.ok(command instanceof PutLogEventsCommand)
        assert.deepEqual(command.input, {
          logGroupName: '/minecraft-bot/personal', logStreamName: 'STORM/bot',
          logEvents: [{ message: 'SDK 境界の確認', timestamp }]
        })
        assert.ok(options.abortSignal instanceof AbortSignal)
        assert.equal(options.abortSignal.aborted, false)
        return {}
      }
      destroy() { destroyed++ }
    }
    Module._load = function (request, parent, isMain) {
      if (request === '@aws-sdk/client-cloudwatch-logs') { loads++; return { CloudWatchLogsClient, PutLogEventsCommand } }
      return load.call(this, request, parent, isMain)
    }
    const { createBotLog } = require(${JSON.stringify(require.resolve('../src/host/bot-log'))})
    async function run() {
      const logger = createBotLog({
        file: ${JSON.stringify(file)}, now: () => timestamp, output: () => {},
        env: {
          CLOUDWATCH_ACCESS_KEY_ID: 'dedicated-test-key', CLOUDWATCH_SECRET_ACCESS_KEY: 'dedicated-test-secret',
          CLOUDWATCH_SESSION_TOKEN: 'dedicated-test-session', CLOUDWATCH_LOG_STREAM: 'STORM/bot',
          AWS_ACCESS_KEY_ID: 'unrelated-key', AWS_SECRET_ACCESS_KEY: 'unrelated-secret', AWS_ENDPOINT_URL: 'https://unused.invalid'
        }
      })
      assert.equal(loads, 0)
      logger.log('SDK 境界の確認')
      assert.equal(loads, 0, 'write remains synchronous and does not load the SDK')
      try {
        await logger.cloudLog.flush()
        assert.equal(loads, 1)
        assert.equal(sends, 1)
        assert.equal(logger.cloudLog.snapshot().sentEvents, 1)
      } finally { await Promise.all([logger.cloudLog.close(), logger.liveLog.close()]) }
      assert.equal(destroyed, 1)
      console.log('SDK_ADAPTER_CONFIRMED')
    }
    run().catch(error => { console.error(error); process.exitCode = 1 })
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SDK_ADAPTER_CONFIRMED/)
  assert.match(await fs.readFile(file, 'utf8'), /\[00:00:00\.000 JST\] SDK 境界の確認\n/)
})
