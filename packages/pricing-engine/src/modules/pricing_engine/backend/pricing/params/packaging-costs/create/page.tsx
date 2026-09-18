'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { packagingCostDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function PackagingCostsCreatePage() {
  return <ParamCreateScreen descriptor={packagingCostDescriptor} />
}
