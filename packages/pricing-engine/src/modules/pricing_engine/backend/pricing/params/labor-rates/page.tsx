'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { laborRateDescriptor } from '../../../../lib/forms/costInputFormConfigs'

export default function LaborRatesListPage() {
  return <ParamListScreen descriptor={laborRateDescriptor} />
}
