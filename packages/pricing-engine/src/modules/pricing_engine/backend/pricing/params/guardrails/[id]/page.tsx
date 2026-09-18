'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { guardrailDescriptor } from '../../../../../lib/forms/guardrailFormConfig'

export default function GuardrailsEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={guardrailDescriptor} recordId={params?.id} />
}
