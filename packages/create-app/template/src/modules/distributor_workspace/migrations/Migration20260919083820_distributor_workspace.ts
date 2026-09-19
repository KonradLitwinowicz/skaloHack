import { Migration } from '@mikro-orm/migrations';

export class Migration20260919083820_distributor_workspace extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "distributor_order_prediction_feedback" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "customer_entity_id" uuid not null, "product_key" text not null, "product_id" uuid null, "product_variant_id" uuid null, "product_name" text null, "kind" text not null, "note" text null, "valid_until" timestamptz null, "created_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "distributor_order_prediction_feedback_scope_idx" on "distributor_order_prediction_feedback" ("organization_id", "tenant_id", "customer_entity_id");`);
    this.addSql(`alter table "distributor_order_prediction_feedback" add constraint "distributor_order_prediction_feedback_unique" unique ("organization_id", "tenant_id", "customer_entity_id", "product_key");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "distributor_order_prediction_feedback" cascade;`);
  }

}
