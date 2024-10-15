import { NextResponse } from 'next/server'
import { Groundx } from "groundx-typescript-sdk"

export async function POST(request: Request) {
  const { query } = await request.json()

  const groundx = new Groundx({
    apiKey: process.env.GROUNDX_API_KEY as string,
  })

  try {
    const response = await groundx.search.content({
      id: 11833,
      query
    })
    return NextResponse.json(response.data)
  } catch (error) {
    console.error('Error:', error)
    return NextResponse.json({ error: 'An error occurred while processing your request.' }, { status: 500 })
  }
}
