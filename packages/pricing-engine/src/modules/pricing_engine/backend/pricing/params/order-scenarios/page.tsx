'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { orderScenarioDescriptor } from '../../../../lib/forms/costInputFormConfigs'

export default function OrderScenariosListPage() {
  return <ParamListScreen descriptor={orderScenarioDescriptor} />
}
