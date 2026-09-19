import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('pricing_engine')

/** Postgres `undefined_table`. The code is stable across server versions, locales and drivers. */
const UNDEFINED_TABLE = '42P01'

/**
 * Whether an error is Postgres telling us the table is not there yet.
 *
 * Matched on the SQLSTATE code, never on the message text: the message is localised by the server's
 * `lc_messages`, so a database running in anything but English would quietly stop matching and the
 * tolerance below would turn back into a crash — the worst kind of regression, because it only
 * appears on somebody else's machine.
 *
 * The driver error is wrapped by MikroORM, so the chain is walked rather than the top frame read.
 */
export function isUndefinedTableError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = current as { code?: unknown; previous?: unknown; cause?: unknown; originalError?: unknown }
    if (record.code === UNDEFINED_TABLE) return true
    current = record.previous ?? record.cause ?? record.originalError ?? null
  }
  return false
}

const reported = new Set<string>()

/**
 * Says it once per process, per table.
 *
 * A pricing engine under load runs this path on every quote, and a warning per quote would bury the
 * log it is meant to stand out in. One line is enough: the condition does not change until somebody
 * runs a migration, and running one restarts the process.
 */
export function reportMissingTableOnce(tableName: string): void {
  if (reported.has(tableName)) return
  reported.add(tableName)
  logger.warn(
    `[pricing_engine] Table "${tableName}" does not exist; treating it as empty. Run \`yarn db:migrate\` to enable the features that use it.`,
  )
}
