# Law of the Land

Law of the Land is a legal information app that leverages Retrieval-Augmented Generation (RAG) technology to provide easy access to the laws and regulations of a country. By chunking and embedding legal documents such as constitutions, ordinances, and local laws, users can query the app to obtain clear, accurate information on what is allowed or prohibited. With its simple, user-friendly interface, the app aims to make legal knowledge more accessible to everyone.

## Features

- **RAG-powered Search**: Utilizes advanced AI technology to retrieve and generate accurate legal information.
- **User-friendly Interface**: Simple and intuitive design for easy navigation and querying.
- **Comprehensive Legal Database**: Includes various types of legal documents for thorough coverage.
- **Real-time Updates**: Ensures the most current legal information is available to users.

## Technology Stack

- **Frontend**: Next.js, React, TypeScript
- **Styling**: Tailwind CSS
- **AI Integration**: OpenAI API, GroundX API
- **Runtime**: Bun
- **Containerization**: Docker
- **Deployment**: [Pending...]

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
