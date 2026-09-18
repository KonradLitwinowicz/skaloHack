'use client'

import * as React from 'react'
import { ParamListScreen } from '../../../../lib/forms/paramScreens'
import { deliveryZoneDescriptor } from '../../../../lib/forms/logisticsFormConfigs'

export default function DeliveryZonesListPage() {
  return <ParamListScreen descriptor={deliveryZoneDescriptor} />
}
