/**
 * The `distributor` role: an operator of a B2B wholesale distributor who runs the
 * catalog, quotes customers, handles orders and touches stock.
 *
 * Every id below is declared by a core module's `acl.ts`. The set is dependency-closed —
 * `dependsOn` chains were resolved so granting it never produces an incoherent ACL.
 *
 * Deliberately excluded, and why:
 * - `auth.*`, `directory.*`, `configs.*`, `entities.*`, `api_keys.*` — platform administration
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
  'attachments.view',
  'catalog.categories.manage',
  'catalog.categories.view',
  'catalog.pricing.manage',
  'catalog.products.manage',
  'catalog.products.view',
  'catalog.variants.manage',
  'currencies.view',
  'customers.companies.manage',
  'customers.companies.view',
  'customers.interactions.view',
  'customers.people.manage',
  'customers.people.view',
  'dashboards.view',
  'dictionaries.view',
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
  'sales.settings.view',
  'sales.shipments.manage',
  'search.global',
  'shipping_carriers.view',
  'wms.adjust_inventory',
  'wms.manage_inventory',
  'wms.manage_reservations',
  'wms.receive_inventory',
  'wms.view',
] as const
