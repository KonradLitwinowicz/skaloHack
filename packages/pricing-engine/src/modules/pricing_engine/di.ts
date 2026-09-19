import { asFunction, asValue, type Resolver } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { SalesCalculationService } from '@open-mercato/core/modules/sales/services/salesCalculationService'
import { createPricingService } from './services/pricingService'
import { createPricingAdvisorService } from './services/pricingAdvisorService'
import { createShadowObservingCalculationService } from './services/salesShadowObserver'
import {
  PricingCalculation,
  PricingCalculationLine,
  PricingComponentDefinition,
  PricingComponentParam,
  PricingCoverageEntry,
  PricingCustomerIndicator,
  PricingCustomerIndicatorDefinition,
  PricingCustomerProfile,
  PricingDeliveryZone,
  PricingFuelPrice,
  PricingGuardrail,
  PricingLaborRate,
  PricingOrderScenario,
  PricingPackagingCost,
  PricingProcessStep,
  PricingPurchasePosition,
  PricingDeadstockDecision,
  PricingShadowObservation,
  PricingSupplierProfile,
  PricingVehicle,
  PricingWarehouseCost,
} from './data/entities'

type AppCradle = AppContainer['cradle'] & { em: EntityManager }

// Weak, so a finished request's container is still collectable and nothing here pins a tenant.
// Guards the one case the decorator cannot detect by inspection: a second `register()` on the same
// container would otherwise read back the wrapper and wrap it again, doubling every observation.
const shadowDecoratedContainers = new WeakSet<object>()

export function register(container: AppContainer) {
  container.register({
    // `.scoped()` because the service closes over the request container's `em`. A singleton would
    // pin one request's EntityManager, and with it one request's tenant.
    // `.proxy()` is mandatory, not stylistic: the container runs in Awilix CLASSIC injection mode,
    // where a factory's dependencies are resolved by PARAMETER NAME. A destructured factory has no
    // named parameters to read, so without the proxy `em` arrives undefined at runtime.
    // `packages/core/src/__tests__/di-classic-proxy.test.ts` enforces this across every module.
    pricingService: asFunction(({ em }: AppCradle) =>
      createPricingService({ em, container: container as unknown as { resolve: (name: string) => unknown } }),
    )
      .scoped()
      .proxy(),

    // Same `.scoped().proxy()` contract as `pricingService` above, and for the same reason.
    pricingAdvisorService: asFunction(({ em }: AppCradle) =>
      createPricingAdvisorService({ em, container: container as unknown as { resolve: (name: string) => unknown } }),
    )
      .scoped()
      .proxy(),

    PricingSupplierProfile: asValue(PricingSupplierProfile),
    PricingLaborRate: asValue(PricingLaborRate),
    PricingProcessStep: asValue(PricingProcessStep),
    PricingOrderScenario: asValue(PricingOrderScenario),
    PricingPackagingCost: asValue(PricingPackagingCost),
    PricingWarehouseCost: asValue(PricingWarehouseCost),
    PricingVehicle: asValue(PricingVehicle),
    PricingFuelPrice: asValue(PricingFuelPrice),
    PricingDeliveryZone: asValue(PricingDeliveryZone),
    PricingPurchasePosition: asValue(PricingPurchasePosition),
    PricingCustomerProfile: asValue(PricingCustomerProfile),
    PricingCustomerIndicatorDefinition: asValue(PricingCustomerIndicatorDefinition),
    PricingCustomerIndicator: asValue(PricingCustomerIndicator),
    PricingComponentDefinition: asValue(PricingComponentDefinition),
    PricingComponentParam: asValue(PricingComponentParam),
    PricingGuardrail: asValue(PricingGuardrail),
    PricingCalculation: asValue(PricingCalculation),
    PricingCalculationLine: asValue(PricingCalculationLine),
    PricingCoverageEntry: asValue(PricingCoverageEntry),
    PricingShadowObservation: asValue(PricingShadowObservation),
    PricingDeadstockDecision: asValue(PricingDeadstockDecision),
  })

  registerShadowObservation(container)
}

/**
 * Decorates `salesCalculationService` instead of registering a sales calculation hook.
 *
 * `register()` runs per request against a freshly built container, so the resolver captured here
 * belongs to this request alone and the wrapper cannot outlive it. The hook registries are process
 * globals with unconditional pushes, which is why this module never touches them.
 *
 * Soft-optional on purpose: with the `sales` module absent there is no registration to wrap, and
 * the rest of this module's DI must still come up.
 */
function registerShadowObservation(container: AppContainer): void {
  if (shadowDecoratedContainers.has(container)) return
  const salesCalculationResolver = container.registrations?.salesCalculationService as
    | Resolver<SalesCalculationService>
    | undefined
  if (!salesCalculationResolver) return
  shadowDecoratedContainers.add(container)

  container.register({
    salesCalculationService: asFunction(() =>
      createShadowObservingCalculationService({
        // Resolved through the captured resolver rather than by name — resolving by name would
        // re-enter the registration being replaced here and recurse forever.
        base: container.build(salesCalculationResolver),
        container: container as unknown as { resolve: (name: string) => unknown },
      }),
    ).scoped(),
  })
}
