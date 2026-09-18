'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { processStepDescriptor } from '../../../../../lib/forms/costInputFormConfigs'

export default function ProcessStepsCreatePage() {
  return <ParamCreateScreen descriptor={processStepDescriptor} />
}
