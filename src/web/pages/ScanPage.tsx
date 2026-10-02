import { useState } from 'react'
import { CameraPanel } from '../components/scan/CameraPanel.tsx'
import { QueueSummary, ScanQueue } from '../components/scan/ScanQueue.tsx'
import { ScanTargetBar } from '../components/scan/ScanTarget.tsx'
import { CAN_USE_LIVE_CAMERA } from '../lib/platform.ts'
import { useAnnounceAutoAdded, useCapture, useScanTarget } from '../lib/scan.ts'

/**
 * Scan cards into the collection, and into a deck as well (spec §5.1): where they go at the top, the camera on the
 * left, and the queue on the right. On a phone the queue is under the camera, the capture button in a bar above the
 * tabs with the queue's summary, and a capture's row comes into view once it's in the queue.
 */
export function ScanPage() {
  const capture = useCapture()
  const { target, setTarget } = useScanTarget()
  /** The scan last captured here, for the queue to bring into view. */
  const [captured, setCaptured] = useState<number | null>(null)
  useAnnounceAutoAdded()
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-3xl font-semibold text-stone-50">Scan</h1>
      <ScanTargetBar target={target} onChange={setTarget} />
      <div className="grid gap-6 md:grid-cols-2 lg:gap-8">
        <CameraPanel
          onCapture={(jpeg, auto, lifted) => capture.mutate({ jpeg, auto, lifted, target }, { onSuccess: (item) => setCaptured(item.id) })}
          summary={<QueueSummary />}
        />
        <ScanQueue target={target} onTarget={setTarget} live={CAN_USE_LIVE_CAMERA} reveal={captured} />
      </div>
    </div>
  )
}
