'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { marginRuleDescriptor } from '../../../../lib/forms/marginRuleFormConfig'

export default function MarginRulesListPage() {
  return <ParamListScreen descriptor={marginRuleDescriptor} />
}
