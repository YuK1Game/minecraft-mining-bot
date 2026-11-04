'use strict'
const { main, errorText } = require('./host')
main().catch(error => { console.error(errorText(error)); process.exitCode = 1 })
