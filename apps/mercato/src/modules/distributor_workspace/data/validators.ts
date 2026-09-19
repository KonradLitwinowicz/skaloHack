import { z } from 'zod'
import { PREDICTION_FEEDBACK_KINDS } from '../lib/orderForecast'

const uuid = z.string().uuid()

/**
 * A feedback row always names a product, but which of the two ids identifies it depends on the
 * catalog: a simple product has no variant. The refinement is what stops a request that names
 * neither from creating a row nothing can ever match back to a prediction.
 */
export const predictionFeedbackCreateSchema = z
  .object({
    productId: uuid.nullable().optional(),
    productVariantId: uuid.nullable().optional(),
    productName: z.string().trim().max(500).nullable().optional(),
    kind: z.enum(PREDICTION_FEEDBACK_KINDS),
    note: z.string().trim().max(2000).nullable().optional(),
    validUntil: z.coerce.date().nullable().optional(),
  })
  .refine((value) => Boolean(value.productId) || Boolean(value.productVariantId), {
    message: 'distributor_workspace.orderForecast.errors.productRequired',
    path: ['productId'],
  })

export const predictionFeedbackDeleteSchema = z
  .object({
    productId: uuid.nullable().optional(),
    productVariantId: uuid.nullable().optional(),
  })
  .refine((value) => Boolean(value.productId) || Boolean(value.productVariantId), {
    message: 'distributor_workspace.orderForecast.errors.productRequired',
    path: ['productId'],
  })

export type PredictionFeedbackCreateInput = z.infer<typeof predictionFeedbackCreateSchema>
export type PredictionFeedbackDeleteInput = z.infer<typeof predictionFeedbackDeleteSchema>
