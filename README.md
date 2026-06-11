# Law of the Land

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Next.js](https://img.shields.io/badge/Next.js-16-blueviolet.svg)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=white)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-007ACC.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-4-38B2AC.svg?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-F9DC3E.svg?logo=bun&logoColor=black)](https://bun.sh/)
[![Convex](https://img.shields.io/badge/Convex-DB%20%2B%20Auth-EE342F.svg)](https://convex.dev/)

Law of the Land is a legal information app that leverages Retrieval-Augmented Generation (RAG) technology to provide easy access to the laws and regulations of a country. By chunking and embedding legal documents such as constitutions, ordinances, and local laws, users can query the app to obtain clear, accurate information on what is allowed or prohibited. With its simple, user-friendly interface, the app aims to make legal knowledge more accessible to everyone.

## Features

- **RAG-powered Search**: GroundX retrieves relevant passages from the legal document library; Gemini generates plain-language answers grounded in them.
- **Accounts & Saved Chats**: Better Auth (email/password, GitHub, Google) with chat history stored in Convex and synced across devices.
- **Session Management**: Review and revoke active sessions per device.
- **User-friendly Interface**: Simple, Stripe/Linear-inspired design for easy navigation and querying.

## Technology Stack

- **Frontend**: Next.js 16 (App Router), React 19, TypeScript
- **Styling**: Tailwind CSS 4, Radix UI
- **AI Integration**: Google Gemini (answers), GroundX (RAG document search)
- **Database & Auth**: Convex + Better Auth
- **Runtime**: Bun
- **Containerization**: Docker
- **Deployment**: Vercel (frontend) + Convex (backend) — https://lawoftheland.vercel.app/

## Getting Started

### Local Development

1. Clone the repository
   ```
   git clone https://github.com/theonlyamos/law-of-the-land.git
   ```
2. Install dependencies: `bun install`
3. Create a Convex project: `bunx convex dev` (fills in `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`)
4. Copy `.env.example` to `.env.local` and fill in the remaining values (GroundX, Google AI, Better Auth secret, optional OAuth credentials)
5. Run the Convex dev server and the app together: `bun run dev:all` (or `bun run dev` if Convex is already running)

### Using Docker

1. Create a `.env.local` file as described above
2. Build the Docker image:
   ```
   docker build -t law-of-the-land .
   ```
3. Run the container:
   ```
   docker run -p 3000:3000 --env-file .env.local law-of-the-land
   ```

The app will be available at `http://localhost:3000`.

Note: Never commit `.env.local` to version control.

## Contributing

We welcome contributions to Law of the Land! Please see our [Contributing Guidelines](CONTRIBUTING.md) for more information.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Contact

- GitHub: [theonlyamos](https://github.com/theonlyamos)
- Email: theonlyamos@gmail.com
- LinkedIn: [Amos Amissah](https://www.linkedin.com/in/amos-amissah-1b4626178/)
- Twitter: [@theonlyamos](https://twitter.com/theonlyamos)
