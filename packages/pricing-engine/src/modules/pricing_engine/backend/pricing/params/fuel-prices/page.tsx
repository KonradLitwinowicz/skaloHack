'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { fuelPriceDescriptor } from '../../../../lib/forms/logisticsFormConfigs'

export default function FuelPricesListPage() {
  return <ParamListScreen descriptor={fuelPriceDescriptor} />
}
