'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { objectiveDescriptor } from '../../../../lib/forms/objectiveFormConfig'

export default function ObjectivesListPage() {
  return <ParamListScreen descriptor={objectiveDescriptor} />
}
