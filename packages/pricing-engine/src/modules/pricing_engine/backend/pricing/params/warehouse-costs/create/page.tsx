'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { warehouseCostDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function WarehouseCostsCreatePage() {
  return <ParamCreateScreen descriptor={warehouseCostDescriptor} />
}
