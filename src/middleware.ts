import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(_request: NextRequest) {
    // For WebSocket connections, we just pass them through
    // Socket initialization is handled in the socket route handler
    return NextResponse.next()
}

export const config = {
    matcher: '/api/socketio',
} 