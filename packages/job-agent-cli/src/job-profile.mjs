export function normalizeJobProfile (raw = {}) {
  const jobInfo = raw.jobInfo ?? raw.targetJobData?.jobInfo ?? raw.selectedJobData ?? {}
  const bossInfo = raw.bossInfo ?? raw.targetJobData?.bossInfo ?? {}
  const title = firstString(
    raw.title,
    raw.jobName,
    raw.positionName,
    jobInfo.jobName,
    jobInfo.title,
    jobInfo.positionName
  )
  const jd = firstString(
    raw.jd,
    raw.description,
    raw.jobDescription,
    raw.postDescription,
    raw.detail,
    jobInfo.postDescription,
    jobInfo.description,
    jobInfo.jobDescription
  )
  return {
    jobId: firstString(raw.jobId, raw.encryptJobId, jobInfo.encryptId, jobInfo.jobId),
    title,
    company: firstString(raw.company, raw.companyName, raw.brandName, jobInfo.brandName, raw.targetJobData?.brandName),
    city: firstString(raw.city, raw.cityName, jobInfo.cityName, raw.selectedJobData?.cityName),
    salary: firstString(raw.salary, raw.salaryDesc, jobInfo.salaryDesc, raw.selectedJobData?.salaryDesc),
    experience: firstString(raw.experience, raw.jobExperience, jobInfo.jobExperience, raw.selectedJobData?.jobExperience),
    degree: firstString(raw.degree, raw.degreeName, jobInfo.degreeName, raw.selectedJobData?.degreeName),
    labels: normalizeList(raw.labels ?? raw.jobLabels ?? jobInfo.jobLabels ?? jobInfo.skills),
    jd,
    sourceKeyword: firstString(raw.sourceKeyword, raw.query, raw.pageQuery),
    bossName: firstString(raw.bossName, bossInfo.name, bossInfo.bossName),
    bossTitle: firstString(raw.bossTitle, bossInfo.title, bossInfo.position),
    raw,
  }
}

export function jobText (job) {
  return [
    job.title,
    job.company,
    job.city,
    job.salary,
    job.experience,
    job.degree,
    job.labels?.join?.(' '),
    job.jd,
    job.sourceKeyword,
  ].filter(Boolean).join('\n')
}

function firstString (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function normalizeList (value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,;|/\s]+/).map(item => item.trim()).filter(Boolean)
  return []
}
