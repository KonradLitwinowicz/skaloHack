import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createPricingService } from './services/pricingService'
import { createPricingAdvisorService } from './services/pricingAdvisorService'
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
  PricingShadowObservation,
  PricingSupplierProfile,
  PricingVehicle,
  PricingWarehouseCost,
} from './data/entities'

type AppCradle = AppContainer['cradle'] & { em: EntityManager }

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
  })
}
