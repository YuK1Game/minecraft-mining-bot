'use strict'

// Small block/point helpers that were copied into dozens of modules.
// Each keeps the exact expression of the copies it replaces.

// Truthy only for an object whose x, y and z are finite numbers; a missing
// point is returned as is (null/undefined), like the original one-liners.
const finitePoint = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
// "x,y,z" for a block position.
const pointKey = point => `${point.x},${point.y},${point.z}`
// Straight-line distance between two points.
const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

module.exports = { finitePoint, pointKey, distance3 }
