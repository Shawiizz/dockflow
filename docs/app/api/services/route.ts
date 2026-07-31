import { NextResponse } from 'next/server'
import { services, stackName } from '../_mock/store'

export function GET() {
  return NextResponse.json({
    services,
    stackName,
    total: services.length,
  })
}
