/**
 * The module's own access boundary.
 *
 * Every gate in this module requires one of these ids IN ADDITION to the ids of the modules that
 * own the data it reads (`sales.*`, `wms.*`, `customers.*`, `pricing.*`, `dashboards.*`). Those
 * ids keep enforcing the data boundary; the ids below only say "this operator may use the
 * distributor workspace screens and widgets". Granting `distributor_workspace.*` on its own
 * therefore never opens sales, stock or customer data.
 */
export const features = [
  {
    id: 'distributor_workspace.widgets.next-actions',
    title: 'Next actions dashboard widget',
    module: 'distributor_workspace',
  },
  {
    id: 'distributor_workspace.widgets.expiring-stock',
    title: 'Expiring stock dashboard widget',
    module: 'distributor_workspace',
  },
  {
    id: 'distributor_workspace.widgets.stock-gaps',
    title: 'Stock gaps dashboard widget',
    module: 'distributor_workspace',
  },
  {
    id: 'distributor_workspace.forecast.view',
    title: 'View customer order forecasts',
    module: 'distributor_workspace',
  },
  {
    id: 'distributor_workspace.forecast.feedback',
    title: 'Record order forecast feedback',
    module: 'distributor_workspace',
    dependsOn: ['distributor_workspace.forecast.view'],
  },
  {
    id: 'distributor_workspace.pricing.compare',
    title: 'Compare document prices',
    module: 'distributor_workspace',
  },
]

export default features
