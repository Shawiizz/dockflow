import { NextResponse } from 'next/server'
import { getLogs, findService } from '../../../_mock/store'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const { searchParams } = new URL(request.url)
  if (!findService(name, searchParams.get('env'))) {
    return NextResponse.json({ logs: [], service: name, lines: 0 }, { status: 404 })
  }
  const lines = Number(searchParams.get('lines')) || 100
  return NextResponse.json({ logs: getLogs(name, lines), service: name, lines })
}
