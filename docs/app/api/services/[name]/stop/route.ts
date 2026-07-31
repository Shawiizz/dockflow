import { NextResponse } from 'next/server'
import { findService } from '../../../_mock/store'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const service = findService(name)
  if (!service) {
    return NextResponse.json({ success: false, message: `Service "${name}" not found` }, { status: 404 })
  }
  service.state = 'stopped'
  service.replicasRunning = 0
  service.updatedAt = new Date().toISOString()
  return NextResponse.json({ success: true, message: `Stopped ${name}` })
}
