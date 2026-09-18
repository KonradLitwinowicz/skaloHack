'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { purchasePositionDescriptor } from '../../../../lib/forms/purchasePositionFormConfig'

export default function PurchasePositionsListPage() {
  return <ParamListScreen descriptor={purchasePositionDescriptor} />
}
