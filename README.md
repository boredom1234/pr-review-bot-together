# PR Review Bot Together

AI-powered code review bot that automatically analyzes pull requests using Together AI's language models.

## Features

- 🤖 Automated code review comments on pull requests
- 🔍 Three-level severity analysis:
  - ❌ Critical: Security issues, bugs, broken functionality, performance issues
  - ⚠️ Warning: Code quality, maintainability, best practices, potential edge cases
  - 💡 Suggestion: Readability improvements, minor optimizations
- 🚫 Automatic PR blocking for critical issues and warnings
- 📊 Detailed review summary with issue counts
- 🔒 Secure handling of API keys and tokens
- ⚡ Runs on GitHub Actions
- 📝 Full file context analysis for better suggestions
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

## Review Behavior

The bot will:
1. Analyze each changed file in the PR
2. Provide detailed comments with severity levels
3. Generate a summary report with:
   - Count of issues by severity
   - Clear indicators for blocking issues
   - Recommendations for next steps
4. Automatically fail the GitHub Action if:
   - Any critical issues are found
   - Any warnings are detected

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

The action can be configured with the following inputs:

- `GITHUB_TOKEN`: Required. Used for GitHub API operations
- `TOGETHER_API_KEY`: Required. Your Together AI API key
- `TOGETHER_API_MODEL`: Required. The Together AI model to use (default: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo')
- `exclude`: Optional. Comma-separated list of glob patterns for files to exclude from review

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details

