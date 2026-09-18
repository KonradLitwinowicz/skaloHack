'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { packagingCostDescriptor } from '../../../../lib/forms/costInputFormConfigs'

export default function PackagingCostsListPage() {
  return <ParamListScreen descriptor={packagingCostDescriptor} />
}
