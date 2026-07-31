import { NextResponse } from 'next/server'
import { connectionInfo } from '../../_mock/store'

export function GET() {
  return NextResponse.json(connectionInfo)
}
