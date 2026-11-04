'use strict'

const http = require('node:http')

function createApi ({ snapshot, disconnect, blocks, mining, walking, crafting, interactions, lifecycle, movement, combat, agent, reload, action }) {
  return http.createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify(body))
    }
    const port = response.socket.localPort
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host) || request.headers.origin) {
      send(403, { error: 'ローカルのAPIクライアントから利用してください。' })
      return
    }
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/status') {
      send(200, snapshot())
    } else if (request.method === 'GET' && url.pathname === '/blocks' && blocks) {
      try { send(200, blocks(Object.fromEntries(url.searchParams))) } catch (error) { send(400, { error: error.message }) }
    } else if (request.method === 'POST' && ((['/mining/preview', '/mining/start', '/mining/stop'].includes(url.pathname) && mining) || (['/walk/preview', '/walk/start', '/walk/stop'].includes(url.pathname) && walking) || (['/craft/preview', '/craft/start', '/craft/open', '/craft/close'].includes(url.pathname) && crafting) || (['/equipment/select', '/blocks/place', '/blocks/use'].includes(url.pathname) && interactions) || (url.pathname === '/respawn' && lifecycle) || (['/move/preview', '/move/start', '/move/stop'].includes(url.pathname) && movement) || (['/combat/attack', '/combat/defend', '/combat/stop'].includes(url.pathname) && combat) || (['/agent/start', '/agent/stop', '/agent/tick'].includes(url.pathname) && agent) || (url.pathname === '/reload' && reload) || (url.pathname === '/action' && action))) {
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        send(415, { error: 'Content-Type: application/json を指定してください。' })
        return
      }
      try {
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 8192) throw new Error('リクエストが大きすぎます。')
        }
        const data = JSON.parse(body || '{}')
        if (url.pathname === '/reload') send(200, await reload())
        else if (url.pathname === '/action') send(200, await action(data))
        else if (url.pathname === '/agent/start') send(202, await agent.start(data))
        else if (url.pathname === '/agent/stop') send(200, agent.stop('APIから停止しました。'))
        else if (url.pathname === '/agent/tick') send(200, await agent.tick())
        else if (url.pathname === '/combat/attack') send(200, await combat.attack(data.runtimeId))
        else if (url.pathname === '/combat/defend') send(200, await combat.defend(data))
        else if (url.pathname === '/combat/stop') send(200, combat.stop('APIから停止しました。') ?? { phase: 'stopped' })
        else if (url.pathname === '/move/preview') send(200, movement.preview(data.target, data.options))
        else if (url.pathname === '/move/start') send(202, movement.start(data.target, data.options))
        else if (url.pathname === '/move/stop') send(200, movement.stop('APIから停止しました。'))
        else if (url.pathname === '/respawn') send(200, await lifecycle.respawn())
        else if (url.pathname === '/equipment/select') send(200, interactions.equip(data.slot))
        else if (url.pathname === '/blocks/place') send(200, await interactions.placeCraftingTable({ position: data.position, slot: data.slot }))
        else if (url.pathname === '/blocks/use') send(200, await interactions.openCraftingTable(data.position, data.slot))
        else if (url.pathname === '/craft/preview') send(200, crafting.preview(data.output, { times: data.times ?? 1 }))
        else if (url.pathname === '/craft/start') send(200, await crafting.craft(data.output, { times: data.times ?? 1 }))
        else if (url.pathname === '/craft/open') send(200, await crafting.openInventory())
        else if (url.pathname === '/craft/close') send(200, crafting.closeContainer() ?? { phase: 'closed' })
        else if (url.pathname === '/walk/preview') send(200, walking.preview(data.target))
        else if (url.pathname === '/walk/start') send(202, walking.start(data.target))
        else if (url.pathname === '/walk/stop') send(200, walking.stop('APIから停止しました。'))
        else if (url.pathname === '/mining/preview') send(200, mining.preview(data.targets))
        else if (url.pathname === '/mining/start') send(202, mining.start(data.targets))
        else send(200, mining.stop('APIから停止しました。'))
      } catch (error) { send(400, { error: error.message }) }
    } else if (request.method === 'POST' && request.url === '/disconnect') {
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        send(415, { error: 'Content-Type: application/json を指定してください。' })
        return
      }
      request.resume()
      send(202, { message: '切断します。' })
      setImmediate(disconnect)
    } else {
      send(404, { error: 'GET /status または POST /disconnect を使用してください。' })
    }
  })
}

module.exports = { createApi }
