import { Migration } from '@mikro-orm/migrations';

export class Migration20260919122436_distributor_workspace extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "distributor_basket_proposals" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "customer_entity_id" uuid not null, "expected_at" date not null, "lines_snapshot" jsonb not null, "total_net_snapshot" numeric(18,4) null, "currency_code" text null, "status" text not null, "sent_at" timestamptz null, "responded_at" timestamptz null, "response_note" text null, "valid_until" timestamptz null, "converted_order_id" uuid null, "created_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "distributor_basket_proposals_scope_idx" on "distributor_basket_proposals" ("organization_id", "tenant_id", "customer_entity_id", "status");`);
    this.addSql(`alter table "distributor_basket_proposals" add constraint "distributor_basket_proposals_delivery_unique" unique ("organization_id", "tenant_id", "customer_entity_id", "expected_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "distributor_basket_proposals" cascade;`);
  }

}
