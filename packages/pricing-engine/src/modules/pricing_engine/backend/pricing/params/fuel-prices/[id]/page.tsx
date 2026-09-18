'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { fuelPriceDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function FuelPricesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={fuelPriceDescriptor} recordId={params?.id} />
}
