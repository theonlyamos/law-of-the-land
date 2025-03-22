import { Server } from 'socket.io'
import { NextResponse } from 'next/server'
import { handleSearchRequest } from '@/lib/socket-handlers'

declare global {
    // eslint-disable-next-line no-var
    var io: Server | undefined
}

const ioHandler = (_req: Request) => {
    if (!global.io) {
        console.log('Initializing Socket.IO server...')
        global.io = new Server({
            path: '/api/socketio',
            addTrailingSlash: false,
        })

        global.io.on('connection', (socket) => {
            console.log('Client connected')

            // Handle search requests
            socket.on('search:request', (data) => {
                handleSearchRequest(socket, data)
            })

            socket.on('disconnect', () => {
                console.log('Client disconnected')
            })
        })
    }
    return new NextResponse('Socket.IO server is running')
}

export const GET = ioHandler 