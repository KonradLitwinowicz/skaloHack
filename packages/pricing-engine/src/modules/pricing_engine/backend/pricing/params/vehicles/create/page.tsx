'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { vehicleDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function VehiclesCreatePage() {
  return <ParamCreateScreen descriptor={vehicleDescriptor} />
}
