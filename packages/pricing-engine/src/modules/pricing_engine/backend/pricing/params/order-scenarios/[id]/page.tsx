'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { orderScenarioDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function OrderScenariosEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={orderScenarioDescriptor} recordId={params?.id} />
}
