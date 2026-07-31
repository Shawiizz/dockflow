import { NextResponse } from 'next/server'
import { findService } from '../../../_mock/store'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const service = findService(name)
  if (!service) {
    return NextResponse.json({ success: false, message: `Service "${name}" not found` }, { status: 404 })
  }
  const body = await request.json().catch(() => ({}))
  const replicas = typeof body.replicas === 'number' ? body.replicas : service.replicas
  service.replicas = replicas
  service.replicasRunning = replicas
  service.state = replicas > 0 ? 'running' : 'stopped'
  service.updatedAt = new Date().toISOString()
  return NextResponse.json({ success: true, message: `Scaled ${name} to ${replicas} replica(s)` })
}
