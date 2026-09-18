'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { guardrailDescriptor } from '../../../../lib/forms/guardrailFormConfig'

export default function GuardrailsListPage() {
  return <ParamListScreen descriptor={guardrailDescriptor} />
}
