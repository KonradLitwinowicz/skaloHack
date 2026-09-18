'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { fuelPriceDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function FuelPricesCreatePage() {
  return <ParamCreateScreen descriptor={fuelPriceDescriptor} />
}
