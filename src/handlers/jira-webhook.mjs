import https from "https";
import crypto from "crypto";

// Extract Jira ADF content to plain text
function extractText(adfNode) {
  if (!adfNode) return "";
  if (typeof adfNode === "string") return adfNode;
  if (Array.isArray(adfNode)) return adfNode.map(extractText).join("\n");
  const { type, text, content } = adfNode;
  if (text) return text;
  if (content) return content.map(extractText).join("\n");
  if (type === "paragraph") return content?.map(extractText).join("") || "";
  return "";
}

// Check if the Jira issue has a trigger label
function hasTriggerLabel(issueLabels, triggerLabels) {
  const set = new Set(issueLabels || []);
  return triggerLabels.some(l => set.has(l));
}

// Map Jira labels to GitHub labels
function mapLabels(jiraLabels, labelMap) {
  const out = [];
  const seen = new Set();
  for (const jl of jiraLabels || []) {
    const mapped = labelMap?.[jl];
    if (Array.isArray(mapped)) {
      for (const ml of mapped) {
        if (!seen.has(ml)) { seen.add(ml); out.push(ml); }
      }
    } else if (typeof mapped === "string") {
      if (!seen.has(mapped)) { seen.add(mapped); out.push(mapped); }
    } else {
      if (!seen.has(jl)) { seen.add(jl); out.push(jl); }
    }
  }
  if (!seen.has("from-jira")) { seen.add("from-jira"); out.push("from-jira"); }
  return out;
}

// Map Jira assignee to GitHub username(s)
function resolveAssignees(jiraAssignee, userMap) {
  if (!jiraAssignee) return [];
  const key = jiraAssignee.emailAddress || jiraAssignee.displayName;
  const mapped = userMap?.[key];
  if (!mapped) return [];
  return Array.isArray(mapped) ? mapped : [mapped];
}

function buildStatusLabel(statusName) {
  if (!statusName) return undefined;
  return `status: ${statusName}`;
}

function updateBodyDates(oldBody, statusName, startDate, dueDate) {
  const lines = String(oldBody || '').split('\n');
  const filtered = lines.filter(l => !/^Status:\s|^Due Date:\s|^Start Date:\s|^Acceptance Criteria:\s/.test(l));
  const block = [
    `Status: ${statusName || 'Not set'}`,
    `Due Date: ${dueDate || 'Not set'}`,
    `Start Date: ${startDate || 'Not set'}`
  ];
  return [...filtered, '', ...block].join('\n');
}

// Make HTTPS request
async function githubRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Validate milestone exists in the repo
async function validateMilestone(owner, repo, milestoneId, token) {
  if (!milestoneId) return undefined;
  try {
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/milestones/${milestoneId}`,
      method: "GET",
      headers: {
        "Authorization": `token ${token}`,
        "User-Agent": "jira-webhook",
        "Accept": "application/vnd.github+json"
      }
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) return milestoneId;
    console.warn(`Milestone ID ${milestoneId} not found, skipping`);
  } catch (err) {
    console.warn("Error validating milestone:", err.message);
  }
  return undefined;
}

// Validate project IDs exist
async function validateProjects(projectIds, token) {
  if (!Array.isArray(projectIds) || !projectIds.length) return [];
  const valid = [];
  for (const id of projectIds) {
    try {
      const resp = await githubRequest({
        hostname: "api.github.com",
        path: `/projects/${id}`,
        method: "GET",
        headers: {
          "Authorization": `token ${token}`,
          "User-Agent": "jira-webhook",
          "Accept": "application/vnd.github+json"
        }
      });
      if (resp.statusCode >= 200 && resp.statusCode < 300) valid.push(id);
      else console.warn(`Project ID ${id} not found, skipping`);
    } catch (err) {
      console.warn(`Error validating project ID ${id}:`, err.message);
    }
  }
  return valid;
}

// Safe JSON parsing
function safeParseJSON(str) {
  if (!str) return undefined;
  try { return JSON.parse(str); } catch { return undefined; }
}

// Check if a GitHub issue for this Jira key already exists
async function issueExists(owner, repo, token, jiraKey) {
  // First try GitHub search (fast, but sometimes eventual consistency)
  try {
    const searchQuery = encodeURIComponent(`repo:${owner}/${repo} "${jiraKey}" in:title,body is:issue`);
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/search/issues?q=${searchQuery}`,
      method: "GET",
      headers: {
        "Authorization": `token ${token}`,
        "User-Agent": "jira-webhook",
        "Accept": "application/vnd.github+json"
      }
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const sr = safeParseJSON(resp.body) || {};
      if ((sr.total_count || 0) > 0) return true;
    }
  } catch (err) {
    console.warn("GitHub search failed, will fallback to listing issues:", err.message);
  }

  // Fallback: list recent issues with label from-jira and scan title/body
  try {
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/issues?state=all&labels=from-jira&per_page=100`,
      method: "GET",
      headers: {
        "Authorization": `token ${token}`,
        "User-Agent": "jira-webhook",
        "Accept": "application/vnd.github+json"
      }
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const issues = safeParseJSON(resp.body) || [];
      return issues.some(i =>
        (i.title && String(i.title).includes(jiraKey)) ||
        (i.body && String(i.body).includes(jiraKey))
      );
    }
  } catch (err) {
    console.warn("GitHub list issues fallback failed:", err.message);
  }
  return false;
}

async function findIssue(owner, repo, token, jiraKey) {
  try {
    const searchQuery = encodeURIComponent(`repo:${owner}/${repo} "${jiraKey}" in:title,body is:issue`);
    const resp = await githubRequest({
      hostname: 'api.github.com',
      path: `/search/issues?q=${searchQuery}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'jira-webhook',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const sr = safeParseJSON(resp.body) || {};
      const item = (sr.items || [])[0];
      if (item && item.number) return item;
    }
  } catch (err) {
    console.warn('findIssue search failed:', err.message);
  }
  return null;
}

async function updateIssueStatus(owner, repo, token, issueNumber, newStatusLabel, jiraStatusName, startDate, dueDate) {
  // Fetch existing issue to preserve other labels and update body
  let issueResp;
  try {
    issueResp = await githubRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'jira-webhook',
        'Accept': 'application/vnd.github+json'
      }
    });
  } catch (err) {
    console.warn('Failed to fetch issue before update:', err.message);
    return;
  }
  if (issueResp.statusCode < 200 || issueResp.statusCode >= 300) return;
  const current = safeParseJSON(issueResp.body) || {};
  const existingLabels = (current.labels || []).map(l => typeof l === 'string' ? l : l.name).filter(Boolean);
  const preserved = existingLabels.filter(l => !String(l).toLowerCase().startsWith('status:'));
  const nextLabels = [...new Set([...preserved, newStatusLabel].filter(Boolean))];
  const desiredState = /^(done|resolved|closed)$/i.test(jiraStatusName || '') ? 'closed' : 'open';
  const nextBody = updateBodyDates(current.body, jiraStatusName, startDate, dueDate);

  try {
    await githubRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'jira-webhook',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      }
    }, JSON.stringify({ labels: nextLabels, state: desiredState, body: nextBody }));
  } catch (err) {
    console.warn('Failed to update issue:', err.message);
  }
}

// Jira Webhook Secret Validation (supports Atlassian X-Hub-Signature HMAC)
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a) || "");
  const bBuf = Buffer.from(String(b) || "");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function validateJiraSecret(event, rawBody) {
  const secretEnv = process.env.JIRA_WEBHOOK_SECRET?.trim();
  // If no secret configured, skip validation
  if (!secretEnv) return true;

  const headers = event.headers || {};
  const qs = event.queryStringParameters || {};

  // Normalize headers to lowercase for consistent lookup
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[String(k).toLowerCase()] = v;
  }

  // Prefer HMAC verification when X-Hub-Signature is present (Jira Cloud behavior)
  const sigHeader = lower['x-hub-signature'] || lower['x-hub-signature-256'];
  if (sigHeader && rawBody != null) {
    // Accept formats like "sha256=abcdef" or bare hex
    const parts = String(sigHeader).split("=");
    const provided = parts.length === 2 ? parts[1] : parts[0];
    const computed = crypto.createHmac('sha256', secretEnv).update(rawBody, 'utf8').digest('hex');
    return timingSafeEqualStr(provided, computed);
  }

  // Fallbacks: plain-text secret header or query string
  const candidate = lower['x-atlassian-webhook-secret']
    || lower['x-jira-webhook-secret']
    || lower['x-webhook-secret']
    || lower['x-hook-secret']
    || qs.secret
    || qs.token;

  return String(candidate || '').trim() === secretEnv;
}

// Lambda Handler
export const handler = async (event) => {
  try {
    console.log("Incoming Jira webhook:", event.body);

    // Decode payload early to validate HMAC using exact bytes
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");

    // Validate Jira webhook secret
    if (!validateJiraSecret(event, rawBody)) {
      // Log the header keys to help diagnose name mismatches
      try {
        const hdrKeys = Object.keys(event.headers || {});
        console.warn("Invalid Jira webhook secret", { headerKeys: hdrKeys });
      } catch {}
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    let jiraPayload;
    try {
      jiraPayload = JSON.parse(rawBody || "{}");
    } catch (err) {
      console.error("Invalid JSON payload:", err);
      return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON payload" }) };
    }

    const eventType = jiraPayload.webhookEvent;

    // GitHub / Jira config
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_TOKEN;
    const jiraBaseUrl = process.env.JIRA_BASE_URL || "";
    const triggerLabels = (process.env.TRIGGER_LABELS || "create-github").split(",").map(s => s.trim()).filter(Boolean);
    const allowedTypes = (process.env.JIRA_TYPES || "Story,Task").split(",").map(s => s.trim()).filter(Boolean);
    const labelMap = safeParseJSON(process.env.LABEL_MAP_JSON);
    const userMap = safeParseJSON(process.env.USER_MAP_JSON);

    const projectIdsRaw = safeParseJSON(process.env.GITHUB_PROJECT_IDS) || [];
    const milestoneIdRaw = process.env.GITHUB_MILESTONE_ID ? parseInt(process.env.GITHUB_MILESTONE_ID) : undefined;

    if (!owner || !repo || !token) {
      return { statusCode: 500, body: JSON.stringify({ message: "Missing GitHub env configuration" }) };
    }

    const issue = jiraPayload.issue || {};
    const fields = issue.fields || {};
    const issType = fields.issuetype?.name;
    const labels = fields.labels || [];
    const statusName = fields.status?.name;

    if (!allowedTypes.includes(issType)) {
      console.info(`Unsupported type ${issType}, ignoring`);
      return { statusCode: 200, body: JSON.stringify({ message: `Unsupported type ${issType}, ignoring` }) };
    }
    if (!hasTriggerLabel(labels, triggerLabels)) {
      console.info("Trigger label not present, ignoring");
      return { statusCode: 200, body: JSON.stringify({ message: "Trigger label not present, ignoring" }) };
    }

    const jiraKey = issue.key;
    const title = fields.summary || jiraKey || "New Jira Item";
    const description = extractText(fields.description) || "No description";
    const priority = fields.priority?.name || "Medium";
    const assignee = fields.assignee || null;

    const jiraLink = jiraBaseUrl && jiraKey ? `${jiraBaseUrl}/browse/${jiraKey}` : (issue.self || "");

    const ghLabels = mapLabels(labels, labelMap);
    const statusLabel = buildStatusLabel(statusName);
    if (statusLabel) ghLabels.push(statusLabel);
    const ghAssignees = resolveAssignees(assignee, userMap);

    // Check if GitHub issue already exists (robust check)
    const exists = await issueExists(owner, repo, token, jiraKey);

    const startDate = fields.customfield_10015 || undefined;
    const dueDate = fields.duedate || undefined;

    if (exists) {
      // On updates or duplicate creates, sync status and dates
      const found = await findIssue(owner, repo, token, jiraKey);
      if (found && found.number) {
        await updateIssueStatus(owner, repo, token, found.number, statusLabel, statusName, startDate, dueDate);
      }
      return { statusCode: 200, body: JSON.stringify({ message: "GitHub issue already exists; synced status/dates" }) };
    }

    // Prepare GitHub issue body
    const issueBody = [
      `Jira: ${jiraKey}`,
      jiraLink ? `Jira Link: ${jiraLink}` : undefined,
      "",
      "Description:",
      description,
      "",
      `Status: ${statusName || 'Not set'}`,
      `Due Date: ${dueDate || 'Not set'}`,
      `Start Date: ${startDate || 'Not set'}`,
      "",
      `Priority: ${priority}`,
      assignee?.displayName ? `Assignee: ${assignee.displayName}` : undefined
    ].filter(Boolean).join("\n");

    // Validate milestone and projects
    const milestoneId = await validateMilestone(owner, repo, milestoneIdRaw, token);
    const projectIds = await validateProjects(projectIdsRaw, token);

    // GitHub create issue payload
    const payload = JSON.stringify({
      title: `${jiraKey ? `${jiraKey}: ` : ""}${title}`.trim(),
      body: issueBody,
      labels: ghLabels,
      assignees: ghAssignees,
      milestone: milestoneId,
      project_ids: projectIds
    });

    const createResp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/issues`,
      method: "POST",
      headers: {
        "Authorization": `token ${token}`,
        "User-Agent": "jira-webhook",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, payload);

    const success = createResp.statusCode >= 200 && createResp.statusCode < 300;
    if (!success) {
      console.error("GitHub create issue failed:", createResp.statusCode, createResp.body);
      return { statusCode: 502, body: JSON.stringify({ message: "Failed to create GitHub issue", details: createResp.body }) };
    }

    console.log("GitHub response:", createResp.body);
    return { statusCode: 201, body: JSON.stringify({ message: "GitHub issue created" }) };

  } catch (err) {
    console.error("Unhandled error in Lambda:", err);
    return { statusCode: 500, body: JSON.stringify({ message: "Internal server error", details: err.message }) };
  }
};
