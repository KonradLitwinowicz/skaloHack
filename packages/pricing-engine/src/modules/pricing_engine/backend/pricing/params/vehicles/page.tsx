'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { vehicleDescriptor } from '../../../../lib/forms/logisticsFormConfigs'

export default function VehiclesListPage() {
  return <ParamListScreen descriptor={vehicleDescriptor} />
}
