import { Server as NetServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import { NextApiResponse } from 'next'
import { handleSearchRequest } from './socket-handlers'

export type NextApiResponseServerIO = NextApiResponse & {
    socket: {
        server: NetServer & {
            io: SocketIOServer
        }
    }
}

let io: SocketIOServer | null = null

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.IO not initialized')
    }
    return io
}

export const initIO = (server: NetServer) => {
    if (!io) {
        io = new SocketIOServer(server, {
            path: '/api/socketio',
            addTrailingSlash: false,
        })

        io.on('connection', (socket) => {
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
    return io
} 