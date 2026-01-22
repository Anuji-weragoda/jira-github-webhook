# Jira to GitHub Issue Automation

Automatically creates GitHub issues from Jira tickets when labeled with a trigger label. Uses AWS Lambda to sync issue details between Jira and GitHub.

## What It Does

- **Automated Sync**: When you add a label to a Jira issue, it automatically creates a corresponding GitHub issue
- **Complete Data Transfer**: Copies title, description, acceptance criteria, labels, and attachments
- **Image Handling**: Downloads images from Jira and uploads them to GitHub
- **Label Mapping**: Maps Jira labels to GitHub labels based on your configuration
- **Metadata Included**: Preserves Jira issue key, type, priority, status, reporter, and assignee

## How It Works

1. Jira webhook sends an event when an issue is created or updated
2. AWS Lambda function receives and processes the webhook
3. If the issue has the trigger label (default: `create-github`), it creates a GitHub issue
4. All issue details are synced to the GitHub issue

## Key Features

- Real-time synchronization
- Secure webhook authentication (HMAC verification)
- Serverless architecture (AWS Lambda + API Gateway)
- Automatic image migration from Jira to GitHub
- Custom label mapping
-  Exclude unwanted custom fields (like "Rank")

## Project Structure

```
src/handlers/
  └── jira-webhook.mjs       # Main Lambda function
__tests__/
  └── performance/           # Load and performance tests
template.yaml               # AWS infrastructure definition
samconfig.toml             # Deployment configuration
```

## Quick Start

```bash
# Install dependencies
npm install

# Configure your settings in template.yaml
# Then deploy to AWS
sam build
sam deploy --guided
```

After deployment, configure the Jira webhook with the API endpoint provided.

## Configuration

Key environment variables in `template.yaml`:

| Variable                   | Default                                  | Purpose                              |
| -------------------------- | ---------------------------------------- | ------------------------------------ |
| `GITHUB_OWNER`           | `Anuji-weragoda`                       | GitHub repository owner              |
| `GITHUB_REPO`            | `jira-github-webhook`                  | Target GitHub repository             |
| `JIRA_BASE_URL`          | `https://anujiweragoda.atlassian.net/` | Your Jira instance                   |
| `TRIGGER_LABELS`         | `create-github`                        | Label that triggers issue creation   |
| `EXCLUDED_CUSTOM_FIELDS` | `Rank`                                 | Custom fields to exclude from GitHub |

## Documentation

For detailed setup and configuration, see the [docs/](docs/) folder.
