'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { objectiveDescriptor } from '../../../../../lib/forms/objectiveFormConfig'

export default function ObjectivesCreatePage() {
  return <ParamCreateScreen descriptor={objectiveDescriptor} />
}
