'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { warehouseCostDescriptor } from '../../../../lib/forms/costInputFormConfigs'

export default function WarehouseCostsListPage() {
  return <ParamListScreen descriptor={warehouseCostDescriptor} />
}
