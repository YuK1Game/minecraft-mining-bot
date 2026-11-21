'use strict'

const { createLiveLog } = require('./live-log')
const { displayText } = require('./realms')

// Created by main, never by importing the host. Cloud diagnostics deliberately
// stay on the local path so a delivery failure cannot enqueue more deliveries.
function createBotLog ({ file, env = process.env, now = Date.now, output = console.log, createCloudLog } = {}) {
  const liveLog = createLiveLog({ file })
  function local (message, timestamp = now()) {
    const line = `[${new Date(timestamp + 9 * 3600000).toISOString().slice(11, 23)} JST] ${displayText(message)}`
    output(line)
    liveLog.write(line)
  }
  const cloudLog = (createCloudLog ?? require('./cloudwatch-log').createCloudWatchLog)({ env, report: message => local(message) })
  function log (message) {
    const timestamp = now()
    local(message, timestamp)
    cloudLog.write(message, timestamp)
  }
  return { log, liveLog, cloudLog }
}

module.exports = { createBotLog }
