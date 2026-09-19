import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export const SHADOW_OBSERVE_ENV = 'OM_PRICING_SHADOW_OBSERVE'

/**
 * Off by default.
 *
 * Observing is not free: every document-totals call that passes this gate loads a supplier profile,
 * the whole time-versioned parameter set, a catalog snapshot and an inventory snapshot, then runs
 * the eleven-component pipeline and flushes a second unit of work. Sales recalculates document
 * totals on nearly every mutation of a draft, so a default-on gate would put that cost on the
 * critical path of ordinary order editing for every tenant that installs the package — including
 * the tenants with no supplier profile at all, for whom every single call would do the work only to
 * throw `SupplierProfileMissingError` and be swallowed.
 *
 * Read per call rather than at module load so a deployment can flip it without a restart, and so a
 * test can exercise both sides of the branch.
 */
export function isShadowObservationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBooleanWithDefault(env[SHADOW_OBSERVE_ENV], false)
}
