import { NextResponse } from 'next/server'
import { findServer } from '../../../_mock/store'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const { searchParams } = new URL(request.url)
  const server = findServer(name, searchParams.get('env'))
  if (!server) {
    return NextResponse.json({ name, status: 'error', error: 'Server not found' }, { status: 404 })
  }
  return NextResponse.json(server)
}
