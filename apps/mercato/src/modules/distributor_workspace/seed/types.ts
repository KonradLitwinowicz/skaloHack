export type DistributorSeedScope = {
  tenantId: string
  organizationId: string
}

export type SeedRunOptions = {
  /** Parse, validate and report, but write nothing. */
  dryRun?: boolean
  /** Cap how many records are created; the full dataset is used when omitted. */
  limit?: number
}

export type SeedReport = {
  created: number
  skipped: number
  details: Record<string, number>
  warnings: string[]
}

export function emptyReport(): SeedReport {
  return { created: 0, skipped: 0, details: {}, warnings: [] }
}

export function bump(report: SeedReport, key: string, by = 1): void {
  report.details[key] = (report.details[key] ?? 0) + by
}
