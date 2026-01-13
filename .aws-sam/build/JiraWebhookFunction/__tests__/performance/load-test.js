import http from 'k6/http';
import { check, sleep } from 'k6';
import { hmac } from 'k6/crypto';


export const options = {
  stages: [
    { duration: '10s', target: 2 },   // Ramp up to 2 users
    { duration: '50s', target: 2 },   // Stay at 2 users (normal usage)
    { duration: '10s', target: 5 },   // Ramp up to 5 users (peak activity)
    { duration: '30s', target: 5 },   // Stay at 5 users (peak period)
    { duration: '10s', target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],           // Less than 5% of requests should fail
    http_req_duration: ['p(95)<2000'],        // 95% of requests should complete within 2s
    http_req_duration: ['p(99)<3000'],        // 99% of requests should complete within 3s
    'http_req_duration{status:200}': ['p(95)<2000'],
  },
};

// Environment variables
const SECRET = __ENV.JIRA_SECRET;
const WEBHOOK_URL = __ENV.WEBHOOK_URL;
const SIGN_MODE = String(__ENV.SIGN_MODE || 'hmac256').toLowerCase(); // 'hmac256' or 'plain'

/**
 * Generate Atlassian Document Format (ADF) content
 */
function generateADF(description) {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: description,
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'This is a load test generated issue for testing webhook performance and scalability.',
          },
        ],
      },
    ],
  };
}


function generateJiraPayload(iteration) {
  const issueKey = `TEST-${100 + iteration}`;
  const timestamp = new Date().toISOString();
  
  return JSON.stringify({
    timestamp,
    webhookEvent: 'jira:issue_created',
    issue_event_type_name: 'issue_created',
    user: {
      self: 'https://jira.example.com/rest/api/2/user?accountId=test123',
      accountId: 'test123',
      displayName: 'Load Test User',
    },
    issue: {
      id: String(1000 + iteration),
      self: `https://jira.example.com/rest/api/2/issue/${issueKey}`,
      key: issueKey,
      fields: {
        issuetype: {
          self: 'https://jira.example.com/rest/api/2/issuetype/10001',
          id: '10001',
          name: 'Story',
          subtask: false,
        },
        project: {
          self: 'https://jira.example.com/rest/api/2/project/TEST',
          id: '10000',
          key: 'TEST',
          name: 'Test Project',
        },
        summary: `Load test story ${issueKey} - iteration ${iteration}`,
        description: generateADF(`Load test iteration ${iteration} at ${timestamp}`),
        labels: ['create-github', 'load-test', 'performance-test'],
        status: {
          self: 'https://jira.example.com/rest/api/2/status/10000',
          id: '10000',
          name: 'To Do',
          statusCategory: {
            id: 2,
            key: 'new',
            colorName: 'blue-gray',
            name: 'To Do',
          },
        },
        priority: {
          self: 'https://jira.example.com/rest/api/2/priority/3',
          id: '3',
          name: 'Medium',
        },
        created: timestamp,
        updated: timestamp,
      },
    },
  });
}

/**
 * Generate authentication headers based on sign mode
 */
function generateAuthHeaders(payload) {
  const headers = { 'Content-Type': 'application/json' };
  
  if (SIGN_MODE === 'plain') {
    // Use plain secret header (Jira Cloud format)
    headers['X-Atlassian-Webhook-Secret'] = SECRET;
  } else {
    // Use HMAC SHA-256 signature (GitHub format)
    const signature = hmac('sha256', payload, SECRET, 'hex');
    headers['X-Hub-Signature-256'] = `sha256=${signature}`;
  }
  
  return headers;
}

/**
 * Main test function executed by each virtual user
 */
export default function () {
  // Validate required environment variables
  if (!SECRET) {
    throw new Error('JIRA_SECRET environment variable is required. Set it before running k6.');
  }
  if (!WEBHOOK_URL) {
    throw new Error('WEBHOOK_URL environment variable is required. Set it before running k6.');
  }

  // Generate unique payload for this iteration
  const payload = generateJiraPayload(__ITER);
  const headers = generateAuthHeaders(payload);

  // Make HTTP POST request to webhook
  const response = http.post(WEBHOOK_URL, payload, {
    headers,
    timeout: '10s',
    tags: { name: 'JiraWebhook' },
  });

  // Verify response
  check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'status is 200': (r) => r.status === 200,
    'response time < 2000ms': (r) => r.timings.duration < 2000,
    'response time < 3000ms': (r) => r.timings.duration < 3000,
    'no server errors': (r) => r.status < 500,
  });

  // Log errors for debugging
  if (response.status !== 200 && response.status !== 201) {
    console.error(`Request failed with status ${response.status}: ${response.body}`);
  }

  // Random sleep between 500ms-1s to simulate realistic Jira webhook intervals
  sleep(0.5 + Math.random() * 0.5);
}

/**
 * Setup function - runs once before the test
 */
export function setup() {
  console.log('='.repeat(60));
  console.log('Starting Jira Webhook Load Test (Realistic Scale)');
  console.log('='.repeat(60));
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log(`Sign Mode: ${SIGN_MODE}`);
  console.log(`Secret: ${SECRET ? 'Configured' : 'MISSING'}`);
  console.log(`Expected requests: ~100 total over 2 minutes`);
  console.log('='.repeat(60));
}

/**
 * Teardown function - runs once after the test
 */
export function teardown(data) {
  console.log('='.repeat(60));
  console.log('Load Test Completed');
  console.log('='.repeat(60));
}
