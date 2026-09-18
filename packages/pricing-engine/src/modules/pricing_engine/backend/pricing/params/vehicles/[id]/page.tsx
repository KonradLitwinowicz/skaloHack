'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { vehicleDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function VehiclesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={vehicleDescriptor} recordId={params?.id} />
}
