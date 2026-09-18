'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { marginRuleDescriptor } from '../../../../../lib/forms/marginRuleFormConfig'

export default function MarginRulesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={marginRuleDescriptor} recordId={params?.id} />
}
