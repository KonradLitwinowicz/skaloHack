'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { purchasePositionDescriptor } from '../../../../../lib/forms/purchasePositionFormConfig'

export default function PurchasePositionsCreatePage() {
  return <ParamCreateScreen descriptor={purchasePositionDescriptor} />
}
