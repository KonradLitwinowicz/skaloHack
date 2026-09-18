'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { processStepDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function ProcessStepsEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={processStepDescriptor} recordId={params?.id} />
}
