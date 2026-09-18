'use client'

import * as React from 'react'
import { ParamCreateScreen } from '../../../../../lib/forms/paramScreens'
import { deliveryZoneDescriptor } from '../../../../../lib/forms/logisticsFormConfigs'

export default function DeliveryZonesCreatePage() {
  return <ParamCreateScreen descriptor={deliveryZoneDescriptor} />
}
