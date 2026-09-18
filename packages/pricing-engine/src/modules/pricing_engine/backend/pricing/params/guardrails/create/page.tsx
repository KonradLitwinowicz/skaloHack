'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { guardrailDescriptor } from '../../../../../lib/forms/guardrailFormConfig'

export default function GuardrailsCreatePage() {
  return <ParamCreateScreen descriptor={guardrailDescriptor} />
}
