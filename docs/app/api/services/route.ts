import { NextResponse } from 'next/server'
import { getServices, getStackName } from '../_mock/store'

export function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const env = searchParams.get('env')
  const services = getServices(env)
  return NextResponse.json({
    services,
    stackName: getStackName(env),
    total: services.length,
  })
}
