/**
 * The `distributor` role: an operator of a B2B wholesale distributor who runs the
 * catalog, quotes customers, handles orders and touches stock.
 *
 * Every id below is declared by a core module's `acl.ts`. The set is dependency-closed —
 * `dependsOn` chains were resolved so granting it never produces an incoherent ACL.
 *
 * Deliberately excluded, and why:
 * - `auth.*`, `directory.*`, `configs.*`, `entities.*`, `api_keys.*` — platform administration
 *   (one read-only exception: `auth.users.list`, see below)
 * - `pricing.mode.change` — flipping the engine out of shadow mode is a privileged act
 * - `pricing.supplier.import` — it drags `pricing.params.write` and is an import surface, not daily work
 * - `sales.documents.number.edit` — rewriting a document number is an audit concern
 * - `sales.returns.create` — it depends on `sales.orders.manage` (sales/acl.ts:80-84); granted only
 *   on request, so the escalation stays a deliberate decision rather than a side effect
 * - enterprise features (`security.*`, `record_locks.*`) — those modules sit behind env flags
 */
export const DISTRIBUTOR_ROLE = 'distributor'

export const DISTRIBUTOR_ROLE_NAMES = [DISTRIBUTOR_ROLE] as const

export const DISTRIBUTOR_FEATURES = [
  // Dashboard widgets are gated one by one, on top of `dashboards.view`. Without these the
  // operator lands on an empty home screen that says "no widgets available for your account" —
  // which reads as a broken install rather than as a missing permission.
  //
  // The two distributor_workspace widgets (`expiringStock`, `stockGaps`) are the exception: both
  // read `/api/wms/dashboard/operational`, so they gate on `dashboards.view` + `wms.view` rather
  // than on a widget-specific id. A synthetic id would add no access boundary the route does not
  // already enforce, and this module declares no `acl.ts` for the platform to register it from.
  'analytics.view',
  'attachments.view',
  // The messages composer lists backend users as recipients (`GET /api/auth/users`). Read-only:
  // the role still cannot create, edit or delete a user.
  'auth.users.list',
  'catalog.categories.manage',
  'catalog.categories.view',
  'catalog.pricing.manage',
  'catalog.products.manage',
  'catalog.products.view',
  'catalog.variants.manage',
  'currencies.view',
  // Logging calls and visits against a customer is daily sales work. It is also the second half of
  // the gate on `GET /api/staff/team-members/assignable` (`customers.roles.view` AND one of
  // `customers.roles.manage` / `customers.activities.manage`), which the company and person lists call.
  'customers.activities.manage',
  'customers.activities.view',
  'customers.companies.manage',
  'customers.companies.view',
  'customers.interactions.view',
  'customers.people.manage',
  'customers.people.view',
  // The company and person lists load assignable account owners from
  // `GET /api/staff/team-members/assignable`, whose metadata requires this id (see above for the rest).
  'customers.roles.view',
  'customers.widgets.new-customers',
  'customers.widgets.next-interactions',
  'customers.widgets.todos',
  // Without this the layout API answers canConfigure:false and the operator has no way to add,
  // remove or reorder a card — the start screen is whatever the first visit happened to seed.
  'dashboards.configure',
  'dashboards.view',
  'dictionaries.view',
  // `/backend/messages` sits in this role's daily nav group; it reads `/api/messages/types`
  // (`messages.view`) and a message cannot be written without `messages.compose`.
  'messages.compose',
  'messages.view',
  'notifications.manage_preferences',
  'notifications.view',
  'perspectives.use',
  'pricing.audit.read',
  'pricing.params.read',
  'pricing.params.write',
  'pricing.quote',
  'pricing.simulate',
  'pricing.view',
  'sales.channels.view',
  'sales.invoices.manage',
  'sales.orders.manage',
  'sales.orders.view',
  'sales.quotes.manage',
  'sales.quotes.view',
  'sales.returns.view',
  // Sales status dictionaries (`/api/sales/order-statuses` and siblings, `makeStatusDictionaryRoute`)
  // require `sales.settings.manage` even for GET, and the order and quote lists load them for their
  // status column — without it both lists log a 403 on every visit. The core `employee` role grants it.
  'sales.settings.manage',
  'sales.settings.view',
  'sales.shipments.manage',
  'sales.widgets.new-orders',
  'sales.widgets.new-quotes',
  'search.global',
  'shipping_carriers.view',
  'wms.adjust_inventory',
  'wms.manage_inventory',
  'wms.manage_reservations',
  'wms.receive_inventory',
  'wms.view',
] as const
