'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { processStepDescriptor } from '../../../../lib/forms/costInputFormConfigs'

export default function ProcessStepsListPage() {
  return <ParamListScreen descriptor={processStepDescriptor} />
}
