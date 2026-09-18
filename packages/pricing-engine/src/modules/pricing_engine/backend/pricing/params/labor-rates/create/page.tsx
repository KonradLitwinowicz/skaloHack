'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { laborRateDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function LaborRatesCreatePage() {
  return <ParamCreateScreen descriptor={laborRateDescriptor} />
}
