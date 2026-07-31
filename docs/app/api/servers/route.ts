import { NextResponse } from 'next/server'
import { servers, projectInfo } from '../_mock/store'

export function GET() {
  return NextResponse.json({
    servers,
    environments: projectInfo.environments,
    total: servers.length,
  })
}
