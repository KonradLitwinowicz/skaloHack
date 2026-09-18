'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { warehouseCostDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function WarehouseCostsEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={warehouseCostDescriptor} recordId={params?.id} />
}
