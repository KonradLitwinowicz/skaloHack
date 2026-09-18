'use client'

import * as React from 'react'
import { ParamEditScreen } from '../../../../../lib/forms/paramScreens'
import { deliveryZoneDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function DeliveryZonesEditPage({ params }: { params?: { id?: string } }) {
  return <ParamEditScreen descriptor={deliveryZoneDescriptor} recordId={params?.id} />
}
