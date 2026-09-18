'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { purchasePositionDescriptor } from '../../../../../lib/forms/purchasePositionFormConfig'

export default function PurchasePositionsEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={purchasePositionDescriptor} recordId={params?.id} />
}
