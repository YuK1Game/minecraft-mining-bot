'use strict'

const actionBusyError = message => Object.assign(new Error(message), { code: 'ACTION_BUSY' })
module.exports = { actionBusyError }
