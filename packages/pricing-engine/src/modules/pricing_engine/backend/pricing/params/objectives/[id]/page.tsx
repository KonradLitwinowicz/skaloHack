'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { objectiveDescriptor } from '../../../../../lib/forms/objectiveFormConfig'

export default function ObjectivesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={objectiveDescriptor} recordId={params?.id} />
}
