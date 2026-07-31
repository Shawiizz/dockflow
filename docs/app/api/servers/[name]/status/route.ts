import { NextResponse } from 'next/server'
import { findServer } from '../../../_mock/store'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const server = findServer(name)
  if (!server) {
    return NextResponse.json({ name, status: 'error', error: 'Server not found' }, { status: 404 })
  }
  return NextResponse.json(server)
}
