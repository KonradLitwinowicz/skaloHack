import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * What the operator knows that the order history cannot.
 *
 * The forecast answers "is this rhythm still running?" from the data, and a replay of that data
 * answers "how often has it been right?" (see `lib/orderForecastBacktest.ts`) — so neither question
 * needs a table. What no amount of history can tell us is the phone call: the chef who mentioned
 * they are switching supplier for gloves, the kitchen closing for a refit, the manager who just
 * confirmed next Monday's pallet. That is the only thing stored here.
 *
 * Keeping the table to human statements has a consequence worth stating plainly: it never goes
 * stale against the orders, because it makes no claim about them. Deleting every row would cost
 * the operator their notes and change no prediction's arithmetic.
 *
 * `product_key` mirrors `productKeyOf` in `lib/orderForecast.ts` exactly (`variant:<id>` or
 * `product:<id>`). It exists because Postgres treats NULLs as distinct in a unique index, so a
 * constraint over the two nullable id columns would happily admit duplicates for a product with no
 * variant; the derived key gives the uniqueness a non-null column to hold on to.
 */
@Entity({ tableName: 'distributor_order_prediction_feedback' })
@Index({
  name: 'distributor_order_prediction_feedback_scope_idx',
  properties: ['organizationId', 'tenantId', 'customerEntityId'],
})
@Unique({
  name: 'distributor_order_prediction_feedback_unique',
  properties: ['organizationId', 'tenantId', 'customerEntityId', 'productKey'],
})
export class DistributorOrderPredictionFeedback {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'customer_entity_id', type: 'uuid' })
  customerEntityId!: string

  @Property({ name: 'product_key', type: 'text' })
  productKey!: string

  @Property({ name: 'product_id', type: 'uuid', nullable: true })
  productId?: string | null

  @Property({ name: 'product_variant_id', type: 'uuid', nullable: true })
  productVariantId?: string | null

  /**
   * Snapshot, not a lookup. A dismissal has to stay readable after the product it refers to is
   * delisted from the catalog, which is one of the commoner reasons for dismissing a prediction.
   */
  @Property({ name: 'product_name', type: 'text', nullable: true })
  productName?: string | null

  @Property({ type: 'text' })
  kind!: string

  @Property({ type: 'text', nullable: true })
  note?: string | null

  /**
   * When the statement stops being true. A confirmation is about one upcoming delivery and expires
   * with it; a dismissal of a delisted product is open-ended and leaves this null.
   */
  @Property({ name: 'valid_until', type: Date, nullable: true })
  validUntil?: Date | null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
