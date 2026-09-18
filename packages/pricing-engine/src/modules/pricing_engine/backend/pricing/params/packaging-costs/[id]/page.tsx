'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { packagingCostDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function PackagingCostsEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={packagingCostDescriptor} recordId={params?.id} />
}
