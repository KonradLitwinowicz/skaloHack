'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { orderScenarioDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function OrderScenariosCreatePage() {
  return <ParamCreateScreen descriptor={orderScenarioDescriptor} />
}
