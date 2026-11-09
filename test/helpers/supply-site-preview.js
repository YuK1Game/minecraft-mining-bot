'use strict'
const { createQuarryPortableStorage } = require('../../src/quarry-portable-storage')
// Exercise the production terrain/entity checks without allowing this read-only
// preview fixture to accidentally send, equip, place, open, or mine anything.
function supplySitePreview ({ getState, getBlock, getEntities = () => [] }) {
  const forbidden = () => { throw Error('Read-only supply site preview attempted a world action') }
  return createQuarryPortableStorage({ getState, getBlock, getEntities,
    crafting: { rawItem: forbidden, closeContainer: forbidden }, chest: { open: forbidden, depositItem: forbidden, rawItem: forbidden },
    interactions: { placeBlock: forbidden }, equip: forbidden, moveTo: forbidden, mine: forbidden, getMining: forbidden, stopMining: forbidden,
    previewMove: forbidden }).previewSupplySite
}
module.exports = { supplySitePreview }
