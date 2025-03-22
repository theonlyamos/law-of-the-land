import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { initIO } from '@/lib/socket-server'

export function middleware(request: NextRequest) {
    // Initialize Socket.IO if it hasn't been initialized yet
    if (request.headers.get('upgrade') === 'websocket') {
        const server = request.socket.server
        if (server) {
            initIO(server)
        }
    }

    return NextResponse.next()
}

export const config = {
    matcher: '/api/socketio',
} 