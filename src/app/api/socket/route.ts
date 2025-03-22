import { NextResponse } from 'next/server'
import { initSocket, NextApiResponseServerIO } from '@/lib/socket'

export async function GET(_req: Request) {
    const res = NextResponse.next()
    initSocket(res as NextApiResponseServerIO)

    return res
} 