'use strict'

const text = (value, limit) => typeof value === 'string' && value ? value.replace(/[\p{C}§]/gu, ' ').slice(0, limit) : null

// Both the control snapshot and the status cache expose only these fields.
function playerStageView (stages) {
  if (!Array.isArray(stages)) return []
  return stages.slice(0, 24).map(stage => ({
    id: text(stage?.id, 40),
    label: text(stage?.label, 40),
    shortLabel: text(stage?.shortLabel, 20),
    implemented: stage?.implemented === true,
    reached: stage?.reached === true,
    checks: (Array.isArray(stage?.checks) ? stage.checks : []).slice(0, 12).map(check => ({
      label: text(check?.label, 100),
      status: ['done', 'skipped'].includes(check?.status) ? check.status : 'pending',
      value: text(check?.value, 40)
    })).filter(check => check.label)
  })).filter(stage => stage.id && stage.label)
}

module.exports = { playerStageView }
