import { NextResponse } from 'next/server'
import { projectInfo } from '../_mock/store'

export function GET() {
  return NextResponse.json(projectInfo)
}
