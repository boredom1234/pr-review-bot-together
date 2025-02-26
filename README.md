# PR Review Bot

An AI-powered code review bot for GitHub pull requests using TogetherAI's language models. The bot analyzes code changes, provides intelligent feedback, and checks code quality using various language-specific tools.

## Features

- **AI Code Review**: Analyzes code changes and provides intelligent feedback using TogetherAI's language models
- **Quality Metrics**: Runs language-specific quality tools to identify issues in your code
- **Multi-language Support**: Supports JavaScript/TypeScript, Python, Go, Java, Ruby, and Rust
- **Customizable Configuration**: Configure quality tools, ignore rules, and severity thresholds
- **Comment Management**: Track resolved issues and filter comments based on status
- **Detailed Reports**: Generates comprehensive reports with quality metrics and issue summaries

## Setup

### 1. Add the GitHub Action to your repository

Create a workflow file (e.g., `.github/workflows/pr-review.yml`) with the following content:

```yaml
name: PR Review Bot
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Fetch all history for quality tools

      # Set up Node.js for ESLint
      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '16'
          cache: 'npm'
      
      # Set up Python for Pylint
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
          cache: 'pip'
      
      # Set up Go for Golint
      - name: Set up Go
        uses: actions/setup-go@v4
        with:
          go-version: '1.19'
          cache: true
      
      # Set up Java for Checkstyle
      - name: Set up Java
        uses: actions/setup-java@v3
        with:
          distribution: 'temurin'
          java-version: '17'
          cache: 'maven'
      
      # Set up Ruby for RuboCop
      - name: Set up Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.1'
          bundler-cache: true
      
      # Cache quality tools
      - name: Cache quality tools
        uses: actions/cache@v3
        with:
          path: |
            ~/.npm
            ~/.cache/pip
            ~/.cargo
            ~/go/bin
            ~/checkstyle.jar
          key: ${{ runner.os }}-quality-tools-${{ hashFiles('**/package-lock.json', '**/requirements.txt', '**/Cargo.lock', '**/go.sum', '**/Gemfile.lock') }}
          restore-keys: |
            ${{ runner.os }}-quality-tools-
      
      - name: PR Review Bot
        uses: boredom1234/pr-review-bot-together@master
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
          TOGETHER_API_MODEL: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'
          exclude: '*.md,*.txt'  # optional: files to exclude
          
          # Quality metrics options
          enable_quality_metrics: 'true'
          quality_tools: 'auto'  # or specify: 'eslint,pylint,golint,checkstyle,rubocop,clippy'
          quality_config_paths: '{"eslint":".eslintrc.json","pylint":"pylintrc"}'  # optional: custom config paths
          ignore_rules: '{"eslint":["no-console","no-unused-vars"],"pylint":["missing-docstring"]}'  # optional: rules to ignore
          ignore_files: '**/*.test.js,**/*.spec.js,**/vendor/**'  # optional: additional files to ignore
          fail_on_quality_issues: 'true'
          max_critical_issues: '0'
          max_warning_issues: '10'
          max_suggestion_issues: '-1'
          comment_mode: 'unresolved'  # options: 'all', 'new', 'unresolved'
```

### 2. Add the required secrets to your repository

- `GITHUB_TOKEN`: Automatically provided by GitHub Actions
- `TOGETHER_API_KEY`: Your TogetherAI API key (get one at [together.ai](https://together.ai))

## Configuration Options

### AI Model Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `TOGETHER_API_KEY` | Your TogetherAI API key | (Required) |
| `TOGETHER_API_MODEL` | The TogetherAI model to use | `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` |
| `exclude` | Glob patterns to exclude files from analysis | `*.md,*.txt` |

### Available Models

| Model | Price per 1M tokens |
|-------|---------------------|
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | $0.88 |
| `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo-128K` | $0.18 |
| `meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo` | $3.50 |
| `deepseek-ai/DeepSeek-V3` | $1.25 |
| `deepseek-ai/DeepSeek-R1` | $3.00 / $7.00 |

### Quality Metrics Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `enable_quality_metrics` | Enable code quality metrics analysis | `true` |
| `quality_tools` | Comma-separated list of quality tools to run | `auto` |
| `quality_config_paths` | JSON mapping of tool names to config file paths | `{}` |
| `ignore_rules` | JSON mapping of tool names to arrays of rules to ignore | `{}` |
| `ignore_files` | Additional glob patterns to exclude from quality analysis | `""` |

### Supported Quality Tools

- `eslint`: JavaScript/TypeScript
- `pylint`: Python
- `golint`: Go
- `checkstyle`: Java
- `rubocop`: Ruby
- `clippy`: Rust

### Failure Conditions

| Option | Description | Default |
|--------|-------------|---------|
| `fail_on_quality_issues` | Fail the action if quality issues are found | `false` |
| `max_critical_issues` | Maximum number of critical issues allowed before failing | `0` |
| `max_warning_issues` | Maximum number of warning issues allowed before failing | `-1` |
| `max_suggestion_issues` | Maximum number of suggestion issues allowed before failing | `-1` |

Set any threshold to `-1` to disable failing on that severity level.

### Comment Management

| Option | Description | Default |
|--------|-------------|---------|
| `comment_mode` | How to handle comments | `all` |

Available comment modes:
- `all`: Comment on all issues
- `new`: Only comment on new issues
- `unresolved`: Comment on new and unresolved issues

## Examples

### Basic Configuration

```yaml
- name: PR Review Bot
  uses: boredom1234/pr-review-bot-together@master
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
```

### Custom Quality Tools

```yaml
- name: PR Review Bot
  uses: boredom1234/pr-review-bot-together@master
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
    quality_tools: 'eslint,pylint,golint'
    quality_config_paths: '{"eslint":".eslintrc.custom.json","pylint":"custom_pylintrc"}'
```

### Ignoring Rules and Files

```yaml
- name: PR Review Bot
  uses: boredom1234/pr-review-bot-together@master
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
    ignore_rules: '{"eslint":["no-console","no-unused-vars"],"pylint":["missing-docstring"]}'
    ignore_files: '**/*.test.js,**/*.spec.js,**/vendor/**'
```

### Custom Failure Thresholds

```yaml
- name: PR Review Bot
  uses: boredom1234/pr-review-bot-together@master
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TOGETHER_API_KEY: ${{ secrets.TOGETHER_API_KEY }}
    fail_on_quality_issues: 'true'
    max_critical_issues: '0'
    max_warning_issues: '10'
    max_suggestion_issues: '-1'
```

## License

MIT

