'use strict'

const { createLiveLog } = require('./live-log')
const { displayText } = require('./realms')

// Created by main, never by importing the host.
function createBotLog ({ file, now = Date.now, output = console.log } = {}) {
  const liveLog = createLiveLog({ file })
  function log (message) {
    const line = `[${new Date(now() + 9 * 3600000).toISOString().slice(11, 23)} JST] ${displayText(message)}`
    output(line)
    liveLog.write(line)
  }
  return { log, liveLog }
}

module.exports = { createBotLog }
