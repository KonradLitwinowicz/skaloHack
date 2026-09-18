'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { laborRateDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function LaborRatesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={laborRateDescriptor} recordId={params?.id} />
}
