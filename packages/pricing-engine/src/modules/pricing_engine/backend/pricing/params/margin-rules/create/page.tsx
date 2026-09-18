'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { marginRuleDescriptor } from '../../../../../lib/forms/marginRuleFormConfig'

export default function MarginRulesCreatePage() {
  return <ParamCreateScreen descriptor={marginRuleDescriptor} />
}
