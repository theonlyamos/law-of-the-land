# Law of the Land

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Next.js](https://img.shields.io/badge/Next.js-13.0+-blueviolet.svg)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-18.0+-61DAFB.svg?logo=react&logoColor=white)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.5+-007ACC.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-3.0+-38B2AC.svg?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-F9DC3E.svg?logo=bun&logoColor=black)](https://bun.sh/)
[![Docker](https://img.shields.io/badge/Docker-20.10+-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)
[![Buildship](https://img.shields.io/badge/Buildship-Serverless-FF6B6B.svg)](https://buildship.com/)

Law of the Land is a legal information app that leverages Retrieval-Augmented Generation (RAG) technology to provide easy access to the laws and regulations of a country. By chunking and embedding legal documents such as constitutions, ordinances, and local laws, users can query the app to obtain clear, accurate information on what is allowed or prohibited. With its simple, user-friendly interface, the app aims to make legal knowledge more accessible to everyone.

## Features

- **RAG-powered Search**: Utilizes advanced AI technology to retrieve and generate accurate legal information.
- **User-friendly Interface**: Simple and intuitive design for easy navigation and querying.
- **Comprehensive Legal Database**: Includes various types of legal documents for thorough coverage.
- **Real-time Updates**: Ensures the most current legal information is available to users.
- **Backend**: Utilizes Buildship.app for efficient and scalable backend (No-code Backend Orchestration).

## Technology Stack

- **Frontend**: Next.js, React, TypeScript
- **Styling**: Tailwind CSS
- **AI Integration**: OpenAI API, GroundX API
- **Runtime**: Bun
- **Containerization**: Docker
- **Backend**: Buildship.app (No-code Backend Orchestration)
- **Deployment**: Deployed on vercel (Frontend) and Buildship (Backend) https://lawoftheland.vercel.app/

## Getting Started

### Local Development

1. Clone the repository
2. Install dependencies: `bun install`
3. Set up environment variables (see `.env.example`)
4. Create a `.env.local` file in the root directory with the necessary environment variables:
   ```
   GROUNDX_API_KEY=your_groundx_api_key
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_BASE_URL=https://api.openai.com/v1
   HELICONE_API_KEY=your_helicone_api_key
   ```
5. Run the development server: `bun run dev`

### Using Docker

1. Clone the repository
   ```
   git clone https://github.com/theonlyamos/law-of-the-land.git
   ```
2. Create a `.env.local` file in the root directory with the necessary environment variables:
   ```
   GROUNDX_API_KEY=your_groundx_api_key
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_BASE_URL=https://api.openai.com/v1
   HELICONE_API_KEY=your_helicone_api_key
   ```
3. Build the Docker image:
   ```
   docker build -t law-of-the-land .
   ```
4. Run the Docker container, passing in the environment variables:
   ```
   docker run -p 3000:3000 --env-file .env.local law-of-the-land
   ```

The app will be available at `http://localhost:3000`.

### Deploying to Buildship

1. Sign up for a Buildship account at [buildship.com](https://buildship.com)
2. Follow Buildship's documentation to set up your project
3. Deploy your serverless function (`api-search.ts`) to Buildship
4. Update the frontend code to use the Buildship function URL

Note: Make sure to replace the placeholder values in the `.env` file with your actual API keys and URLs. Never commit this file to version control.

## Contributing

We welcome contributions to Law of the Land! Please see our [Contributing Guidelines](CONTRIBUTING.md) for more information.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Contact

- GitHub: [theonlyamos](https://github.com/theonlyamos)
- Email: theonlyamos@gmail.com
- LinkedIn: [Amos Amissah](https://www.linkedin.com/in/amos-amissah-1b4626178/)
- Twitter: [@theonlyamos](https://twitter.com/theonlyamos)
