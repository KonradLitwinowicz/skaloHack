import { Migration } from '@mikro-orm/migrations';

export class Migration20260919084214_pricing_engine extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "pricing_deadstock_decisions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "is_demo" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "catalog_product_id" uuid not null, "catalog_variant_id" uuid null, "verdict" text not null default 'confirmed', "reason_code" text null, "note" text null, "decided_by" uuid null, "decided_at" timestamptz not null, "review_at" timestamptz null, "snapshot" jsonb null, primary key ("id"));`);
    this.addSql(`create index "pricing_deadstock_decisions_scope_idx" on "pricing_deadstock_decisions" ("tenant_id", "organization_id", "catalog_product_id");`);
  }

}
