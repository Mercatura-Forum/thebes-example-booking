import { useEffect, useState } from 'react'
import { isCalibrated, onCalibrated } from './chainTime'

/** True once the chain clock is calibrated; re-renders the component when it lands. */
export function useCalibrated(): boolean {
  const [cal, setCal] = useState(isCalibrated)
  useEffect(() => {
    if (cal) return
    return onCalibrated(() => setCal(true))
  }, [cal])
  return cal
}
