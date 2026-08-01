import { NextResponse } from 'next/server'
import { getServers, projectInfo } from '../_mock/store'

export function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const servers = getServers(searchParams.get('env'))
  return NextResponse.json({
    servers,
    environments: projectInfo.environments,
    total: servers.length,
  })
}
