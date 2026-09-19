import { mul, toDecimal } from '../decimal'
import type { Decimal } from '../decimal'

// One unit table, two readers: the handling surcharge weighs a box to decide whether it is heavy,
// and the shelf-life salvage floor weighs it to price its disposal. Two private copies would
// eventually disagree about what a pound is, and the disagreement would surface as a price.
const WEIGHT_UNIT_TO_KILOGRAM: Record<string, string> = {
  kg: '1',
  dag: '0.01',
  g: '0.001',
  t: '1000',
  lb: '0.45359237',
}

export type WeightReading = {
  kilograms: Decimal | null
  unitRecognized: boolean
}

export function readWeightKilograms(
  weightValue: string | null,
  weightUnit: string | null,
): WeightReading {
  if (weightValue === null || weightValue.trim() === '') return { kilograms: null, unitRecognized: true }
  // A null unit on a Polish distributor's catalog row is kilograms; that convention is recorded in
  // `inputs.weightUnit` so a reader can see what was assumed rather than having to infer it.
  const unit = (weightUnit ?? 'kg').trim().toLowerCase()
  const conversion = WEIGHT_UNIT_TO_KILOGRAM[unit]
  if (!conversion) return { kilograms: null, unitRecognized: false }
  return { kilograms: mul(toDecimal(weightValue), toDecimal(conversion)), unitRecognized: true }
}
