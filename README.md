# PR Review Bot Together

AI-powered code review bot that automatically analyzes pull requests using Together AI's language models.

An automated code review bot that uses Together AI's LLMs to provide intelligent feedback on GitHub pull requests.

## Features

- 🤖 Automated code review comments on pull requests
- 🔍 Analyzes code changes and suggests improvements
- 🚀 Powered by Together AI's LLMs (Meta-Llama-3.1-8B-Instruct-Turbo)
- ⚡ Runs on GitHub Actions
- 🔒 Secure handling of API keys and tokens
- 🎯 Configurable file exclusions

## Setup

1. Create the following secrets in your GitHub repository:
   - `TOGETHER_API_KEY`: Your Together AI API key
   - `GITHUB_TOKEN`: Automatically provided by GitHub Actions

2. Add the workflow file to your repository:
   ```yaml
   name: PR Review Bot
   on:
     pull_request:
       types: [opened, synchronize]

   jobs:
     review:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         - name: Run PR Review
           uses: ./
           with:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
             TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
             TOGETHER_API_MODEL: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
             exclude: '*.md,*.txt'
   ```

## Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```env
   TOGETHER_API_KEY=your_api_key_here
   TOGETHER_API_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo
   GITHUB_TOKEN=your_github_token_here
   ```

4. Build and run:
   ```bash
   npm run build
   NODE_ENV=development npm start
   ```

## Configuration

- `TOGETHER_API_MODEL`: Choose your preferred Together AI model
- `exclude`: Comma-separated list of file patterns to exclude from review
- Additional configuration options can be set in the workflow file

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

