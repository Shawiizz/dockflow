import { NextResponse } from 'next/server'
import { findService } from '../../../_mock/store'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const { searchParams } = new URL(request.url)
  const service = findService(name, searchParams.get('env'))
  if (!service) {
    return NextResponse.json({ success: false, message: `Service "${name}" not found` }, { status: 404 })
  }
  service.state = 'running'
  service.replicasRunning = service.replicas
  service.updatedAt = new Date().toISOString()
  return NextResponse.json({ success: true, message: `Restarted ${name}` })
}
