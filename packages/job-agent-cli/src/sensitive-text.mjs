const sensitiveSignalPattern = /canary|secret|private|cookie|token|api[_-]?key|password/i

const sensitiveFragmentPatterns = [
  ['sensitive_canary_or_secret', /[A-Z0-9_.-]*(?:CANARY|SECRET|PRIVATE|COOKIE|TOKEN|API[_-]?KEY|PASSWORD)[A-Z0-9_.-]*/ig],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig],
  ['windows_path', /[A-Z]:\\[^\s"'<>|]+/g],
  ['unix_path', /(?:\/Users|\/home|\/tmp|\/var|\/mnt|\/Volumes)\/[^\s"'<>]+/g],
  ['phone', /(?:\+?\d[\d -]{8,}\d)/g],
]

export function isSensitiveProfileSignal (signal) {
  return sensitiveSignalPattern.test(String(signal ?? ''))
}

export function redactSensitiveFragments (text) {
  return sensitiveFragmentPatterns.reduce(
    (output, [, pattern]) => output.replace(pattern, '[REDACTED]'),
    String(text ?? '')
  )
}

export function extractSensitiveFragments (text) {
  const source = String(text ?? '')
  const result = []
  for (const [kind, pattern] of sensitiveFragmentPatterns) {
    for (const match of source.matchAll(pattern)) {
      result.push({ kind, value: match[0] })
    }
  }
  return result
}
