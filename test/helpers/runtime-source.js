'use strict'

// Some tests assert on the runtime's source text. Long-distance travel moved
// from runtime.js to long-travel-runtime.js (2026-11-15), where each use of a
// runtime binding is written rt.<name>. This returns both texts as one, with
// that prefix removed, so those assertions read the code as it was written.
const fs = require('node:fs')

function runtimeSource () {
  // The runtime reads the trip's own values back as travelRuntime.<name>.
  const runtime = fs.readFileSync(require.resolve('../../src/runtime'), 'utf8').replace(/\btravelRuntime\.(longTravel|longTravelFile)\b/g, '$1')
  const travel = fs.readFileSync(require.resolve('../../src/long-travel-runtime'), 'utf8').replace(/\brt\./g, '')
  return runtime + '\n' + travel
}

module.exports = { runtimeSource }
