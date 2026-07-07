import crypto from 'node:crypto'

import { appendAuditLog, buildAuditRecord, createRunId } from './audit-log.mjs'
import {
  consumeAuthorizationToken,
  inspectAuthorizationToken,
} from './authorization-token.mjs'
import {
  runStartChatActionOnCurrentJob,
  runStartChatActionOnOpenPage,
} from './browser-actions.mjs'

const commandName = 'authorized-action'
const startChatAction = 'start_chat'
const supportedActions = new Set([startChatAction])

export async function runAuthorizedActionIntentOnOpenPage (page, options = {}) {
  return await runAuthorizedActionIntent({
    ...options,
    executeAction: async ({ action, confirm, expectedJob }) => {
      if (action !== startChatAction) {
        return {
          result: {
            dryRun: !confirm,
            skipped: true,
            success: false,
            reason: 'ACTION_UNSUPPORTED',
          },
        }
      }
      return await runStartChatActionOnOpenPage(page, { confirm, expectedJob })
    },
  })
}

export async function runAuthorizedActionIntent ({
  action,
  tokenId,
  tokenFile,
  auditFile,
  confirm = false,
  headless = false,
  now = new Date(),
  query = '',
  city = '',
  executeAction = executeActionFromBrowser,
} = {}) {
  const actionIntent = normalizeActionIntent(action)
  if (!actionIntent) {
    return appendAuthorizedActionAudit(buildRejectedOutput({
      action: actionIntent,
      confirm,
      reasonCode: 'ACTION_INTENT_REQUIRED',
      reason: 'action intent is required',
    }), { auditFile })
  }
  if (!supportedActions.has(actionIntent)) {
    return appendAuthorizedActionAudit(buildRejectedOutput({
      action: actionIntent,
      confirm,
      reasonCode: 'ACTION_UNSUPPORTED',
      reason: `${actionIntent} is not a supported authorized action`,
    }), { auditFile })
  }

  const normalizedTokenId = String(tokenId ?? '').trim()
  if (!normalizedTokenId) {
    return appendAuthorizedActionAudit(buildRejectedOutput({
      action: actionIntent,
      confirm,
      reasonCode: 'AUTHORIZATION_TOKEN_REQUIRED',
      reason: 'Application Authorization Token is required',
    }), { auditFile })
  }

  const tokenInspection = inspectAuthorizationToken({
    tokenId: normalizedTokenId,
    tokenFile,
    now,
    action: actionIntent,
  })
  const authorization = summarizeTokenInspection(tokenInspection, normalizedTokenId, actionIntent)
  if (tokenInspection.status !== 'valid') {
    return appendAuthorizedActionAudit(buildRejectedOutput({
      action: actionIntent,
      confirm,
      reasonCode: tokenInspection.reasonCode,
      reason: tokenInspection.status,
      authorization,
      tokenInspection,
    }), { auditFile })
  }

  const authorizedJob = buildAuthorizedJobFromToken(tokenInspection.token)
  if (!confirm) {
    return appendAuthorizedActionAudit({
      ok: true,
      command: commandName,
      action: actionIntent,
      runId: tokenInspection.token.runId,
      dryRun: true,
      reasonCode: 'DRY_RUN',
      validation: {
        authorization,
        browserTarget: {
          planned: true,
          jobIdentityAnchor: authorizedJob.jobId,
          reasonCode: 'BROWSER_TARGET_VALIDATION_PLANNED',
        },
      },
      authorizedJob,
      plannedAction: {
        type: actionIntent,
        requiresConfirm: true,
        wouldOpenBrowser: true,
        wouldExecute: false,
        jobIdentityAnchor: authorizedJob.jobId,
      },
    }, { auditFile })
  }

  const actionOutcome = await executeAction({
    action: actionIntent,
    confirm: true,
    headless,
    expectedJob: authorizedJob,
    query,
    city,
  })
  const actionResult = normalizeActionResult(actionOutcome)
  const actionReasonCode = getActionReasonCode(actionResult)
  const actionSucceeded = Boolean(actionResult?.success)
  const baseOutput = {
    ok: actionSucceeded,
    command: commandName,
    action: actionIntent,
    runId: tokenInspection.token.runId,
    dryRun: false,
    reasonCode: actionSucceeded ? 'ACTION_EXECUTED' : actionReasonCode,
    validation: {
      authorization,
      browserTarget: summarizeBrowserTargetValidation({
        actionResult,
        authorizedJob,
      }),
    },
    authorizedJob,
    actionResult,
  }

  if (!actionSucceeded) {
    return appendAuthorizedActionAudit(baseOutput, { auditFile })
  }

  const consumption = consumeAuthorizationToken({
    tokenId: normalizedTokenId,
    tokenFile,
    now,
    action: actionIntent,
  })
  const consumptionSummary = summarizeTokenConsumption(consumption, normalizedTokenId, actionIntent)
  return appendAuthorizedActionAudit({
    ...baseOutput,
    ok: Boolean(consumption.consumed),
    reasonCode: consumption.consumed ? 'ACTION_EXECUTED' : 'TOKEN_CONSUMPTION_FAILED',
    consumption: consumptionSummary,
  }, { auditFile })
}

async function executeActionFromBrowser ({
  action,
  confirm,
  headless,
  expectedJob,
  query,
  city,
}) {
  if (action !== startChatAction) {
    return {
      result: {
        dryRun: !confirm,
        skipped: true,
        success: false,
        reason: 'ACTION_UNSUPPORTED',
      },
    }
  }
  return await runStartChatActionOnCurrentJob({
    confirm,
    headless,
    expectedJob,
    query,
    city,
  })
}

function appendAuthorizedActionAudit (output, { auditFile } = {}) {
  const auditResult = appendAuditLog(
    buildAuthorizedActionAuditRecord(output),
    { auditFile }
  )
  return {
    ...output,
    auditResult,
  }
}

function buildAuthorizedActionAuditRecord (output) {
  const actions = []
  if (output.validation?.authorization) {
    actions.push({
      type: 'authorization_validation',
      result: output.validation.authorization,
    })
  }
  if (output.validation?.browserTarget) {
    actions.push({
      type: 'browser_target_validation',
      result: output.validation.browserTarget,
    })
  }
  if (output.plannedAction) {
    actions.push({
      type: output.action || startChatAction,
      result: output.plannedAction,
    })
  } else {
    actions.push({
      type: output.action || startChatAction,
      result: output.actionResult ?? {
        skipped: true,
        reasonCode: output.reasonCode,
        reason: output.reason,
      },
    })
  }
  if (output.consumption) {
    actions.push({
      type: 'authorization_consumption',
      result: output.consumption,
    })
  }

  return buildAuditRecord({
    runId: output.runId || createRunId(),
    command: commandName,
    dryRun: output.dryRun,
    profile: output.authorizedJob,
    finalDecision: output.authorizedJob
      ? { decision: 'apply', source: 'application_authorization' }
      : null,
    actions,
    errors: output.ok
      ? []
      : [{ reasonCode: output.reasonCode, message: output.reason ?? output.reasonCode }],
  })
}

function buildRejectedOutput ({
  action,
  confirm,
  reasonCode,
  reason,
  authorization = null,
  tokenInspection = null,
}) {
  const token = tokenInspection?.token
  return {
    ok: false,
    command: commandName,
    action: action || null,
    runId: token?.runId ?? null,
    dryRun: !confirm,
    reasonCode,
    reason,
    validation: {
      authorization,
      browserTarget: {
        planned: false,
        skipped: true,
        reasonCode,
      },
    },
  }
}

function normalizeActionIntent (value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.replace(/-/g, '_')
}

function normalizeActionResult (outcome) {
  if (!outcome) return null
  return outcome.result ?? outcome
}

function buildAuthorizedJobFromToken (token) {
  const evidenceJob = token?.decisionEvidence?.job ?? {}
  return {
    ...evidenceJob,
    jobId: token?.jobId,
  }
}

function summarizeTokenInspection (inspection, tokenId, action) {
  return {
    status: inspection.status,
    reasonCode: inspection.reasonCode,
    inspectedAt: inspection.inspectedAt,
    action,
    authorizationFingerprint: fingerprintTokenId(tokenId),
    runId: inspection.token?.runId ?? null,
    jobIdentityAnchor: inspection.token?.jobId ?? null,
    expiresAt: inspection.token?.expiresAt ?? null,
    allowedActionCount: Array.isArray(inspection.token?.allowedActions)
      ? inspection.token.allowedActions.length
      : 0,
  }
}

function summarizeTokenConsumption (consumption, tokenId, action) {
  return {
    consumed: Boolean(consumption.consumed),
    status: consumption.status,
    reasonCode: consumption.reasonCode,
    consumedAt: consumption.inspectedAt,
    action,
    authorizationFingerprint: fingerprintTokenId(tokenId),
    jobIdentityAnchor: consumption.token?.jobId ?? null,
  }
}

function summarizeBrowserTargetValidation ({ actionResult, authorizedJob }) {
  const jobMatch = actionResult?.jobMatch
  if (jobMatch) {
    return {
      planned: false,
      jobIdentityAnchor: authorizedJob.jobId,
      match: Boolean(jobMatch.match),
      reasonCode: jobMatch.match ? 'JOB_MATCHED' : 'JOB_MISMATCH',
      comparedBy: jobMatch.comparedBy,
      expected: jobMatch.expected,
      actual: jobMatch.actual,
    }
  }
  return {
    planned: false,
    jobIdentityAnchor: authorizedJob.jobId,
    match: Boolean(actionResult?.success),
    reasonCode: actionResult?.success ? 'JOB_MATCHED' : getActionReasonCode(actionResult),
  }
}

function getActionReasonCode (actionResult) {
  if (!actionResult) return 'ACTION_RESULT_MISSING'
  if (actionResult.reason) return actionResult.reason
  if (actionResult.success) return 'ACTION_EXECUTED'
  return 'ACTION_FAILED'
}

function fingerprintTokenId (tokenId) {
  return `sha256:${crypto.createHash('sha256').update(String(tokenId ?? '')).digest('hex').slice(0, 16)}`
}
