import https from "https";
import crypto from "crypto";

/**
 * Extract Jira ADF (Atlassian Document Format) content to plain text.
 * Handles nested structures, arrays, and various node types including mentions.
 * @param {Object|Array|string} adfNode - The ADF node to extract text from
 * @param {Object} userMap - Map of Jira identifiers (email/displayName) to GitHub usernames
 * @returns {string} Extracted plain text
 */
function extractText(adfNode, userMap = {}) {
  if (!adfNode) return "";
  
  // Handle string nodes - convert Jira mention format to plain text
  if (typeof adfNode === "string") {
    // Convert Jira mention format [~accountid:...] or [~email@domain.com] to plain text mentions
    return adfNode.replace(/\[~([^\]]+)\]/g, (match, ref) => {
      // Try to look up by email or display name if provided
      const mapped = userMap?.[ref];
      if (mapped) {
        const username = Array.isArray(mapped) ? mapped[0] : mapped;
        return `@${username}`;
      }
      // For accountId format, just return empty or fallback to @someone
      if (ref.startsWith('accountid:')) {
        return '@someone';
      }
      // For email or username references, return as-is
      return `@${ref}`;
    });
  }
  
  if (Array.isArray(adfNode)) {
    return adfNode.map(node => extractText(node, userMap)).join("\n");
  }
  
  const { type, text, content, attrs } = adfNode;
  
  // Handle mention nodes from ADF structure
  // Handle mention nodes from ADF structure
  if (type === "mention" && attrs) {
    /**
     * Jira Cloud mentions:
     * attrs.id   -> accountId (NEVER expose)
     * attrs.text -> "@Display Name" (safe)
     */

    // Always prefer attrs.text
    if (typeof attrs.text === "string" && attrs.text.trim()) {
      const cleanName = attrs.text.replace(/^@/, "").trim();

      // Try mapping by display name (case-insensitive)
      const lowerCleanName = cleanName.toLowerCase();
      const mapped = userMap?.[cleanName] || 
                     Object.entries(userMap || {}).find(([k]) => k.toLowerCase() === lowerCleanName)?.[1];
      
      if (mapped) {
        const username = Array.isArray(mapped) ? mapped[0] : mapped;
        return `@${username}`;
      }

      // Return display name without leaking accountId
      return `@${cleanName}`;
    }

    // Absolute fallback — NEVER return accountId
    return "@someone";
  }

  
  // Handle text nodes
  if (text) {
    return text;
  }
  
  // Recursively process content
  if (content) {
    return content.map(node => extractText(node, userMap)).join(type === "paragraph" ? "" : "\n");
  }
  
  return "";
}

/**
 * Extract acceptance criteria from Jira issue fields.
 * Tries custom field first, then falls back to description parsing.
 * @param {Object} fields - Jira issue fields object
 * @param {string} customFieldName - Name of the custom field (e.g., 'customfield_10200')
 * @returns {string} Extracted acceptance criteria or empty string
 */
function extractAcceptanceCriteria(fields, customFieldName) {
  // Try custom field first (e.g., customfield_10200)
  if (customFieldName && fields[customFieldName]) {
    return extractText(fields[customFieldName]);
  }
  
  // Fallback: try to extract from description if it has "Acceptance Criteria" section
  const description = extractText(fields.description);
  const acMatch = description.match(/Acceptance Criteria:?\s*([\s\S]*?)(?=\n\n|$)/i);
  if (acMatch && acMatch[1]) {
    return acMatch[1].trim();
  }
  
  return "";
}

/**
 * Check if the Jira issue has any of the configured trigger labels.
 * @param {string[]} issueLabels - Array of labels from the Jira issue
 * @param {string[]} triggerLabels - Array of trigger labels to check against
 * @returns {boolean} True if at least one trigger label is found
 */
function hasTriggerLabel(issueLabels, triggerLabels) {
  if (!Array.isArray(issueLabels) || !issueLabels.length) return false;
  if (!Array.isArray(triggerLabels) || !triggerLabels.length) return false;
  const set = new Set(issueLabels);
  return triggerLabels.some(l => set.has(l));
}

/**
 * Map Jira labels to GitHub labels using the configured label mapping.
 * Automatically adds 'from-jira' label to all mapped issues.
 * @param {string[]} jiraLabels - Array of labels from Jira
 * @param {Object} labelMap - Label mapping configuration (Jira label -> GitHub label(s))
 * @returns {string[]} Array of GitHub labels to apply
 */
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

/**
 * Map Jira user to GitHub username(s) with fallback strategy.
 * Tries email first, then displayName. Does NOT map accountId.
 * @param {Object} jiraUser - Jira user object (assignee, reporter, or commenter)
 * @param {Object} userMap - User mapping configuration (email/displayName -> GitHub username)
 * @returns {Object} Object with mapped usernames array and display info
 */
function resolveUser(jiraUser, userMap) {
  if (!jiraUser) return { usernames: [], displayName: 'Unknown', email: null, isMapped: false };
  
  const displayName = jiraUser.displayName || 'Unknown User';
  const email = jiraUser.emailAddress || null;
  
  // Only look up by email and displayName - NOT accountId
  const lookupKeys = [email, displayName].filter(Boolean);
  
  for (const key of lookupKeys) {
    const mapped = userMap?.[key];
    if (mapped) {
      const usernames = Array.isArray(mapped) ? mapped : [mapped];
      return { usernames, displayName, email, isMapped: true };
    }
  }
  
  // No mapping found
  return { usernames: [], displayName, email, isMapped: false };
}

/**
 * Build a standardized GitHub status label from Jira status name.
 * @param {string} statusName - The Jira status name
 * @returns {string|undefined} Formatted status label or undefined
 */
function buildStatusLabel(statusName) {
  if (!statusName) return undefined;
  return `status: ${statusName}`;
}

/**
 * Update issue body with current status and date information.
 * Removes old status/date lines and appends updated values.
 * @param {string} oldBody - Existing issue body content
 * @param {string} statusName - Current Jira status name
 * @param {string} startDate - Issue start date (ISO format)
 * @param {string} dueDate - Issue due date (ISO format)
 * @returns {string} Updated issue body
 */
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

/**
 * Make an HTTPS request to GitHub API with proper error handling.
 * @param {Object} options - HTTPS request options
 * @param {string} payload - Optional request payload
 * @returns {Promise<{statusCode: number, body: string, headers: Object}>} Response object
 * @throws {Error} Network or request errors
 */
async function githubRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ 
        statusCode: res.statusCode, 
        body: data,
        headers: res.headers || {}
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout after 30 seconds'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Build standard GitHub API headers.
 * @param {string} token - GitHub access token
 * @param {boolean} withContentType - Whether to include Content-Type header
 * @returns {Object} Headers object
 */
function buildGitHubHeaders(token, withContentType = false) {
  const headers = {
    "Authorization": `token ${token}`,
    "User-Agent": "jira-webhook",
    "Accept": "application/vnd.github+json"
  };
  if (withContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Validate that a GitHub username exists and has access to the repository.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} username - GitHub username to validate
 * @param {string} token - GitHub access token
 * @returns {Promise<boolean>} True if user is valid and has access
 */
async function validateGitHubUser(owner, repo, username, token) {
  if (!username) return false;
  try {
    const userResp = await githubRequest({
      hostname: "api.github.com",
      path: `/users/${encodeURIComponent(username)}`,
      method: "GET",
      headers: buildGitHubHeaders(token)
    });
    
    if (userResp.statusCode !== 200) {
      console.warn(`GitHub user ${username} not found`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`Error validating GitHub user ${username}:`, err.message);
    return false;
  }
}

/**
 * Validate milestone exists in the repository.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} milestoneId - Milestone ID to validate
 * @param {string} token - GitHub access token
 * @returns {Promise<number|undefined>} Validated milestone ID or undefined
 */
async function validateMilestone(owner, repo, milestoneId, token) {
  if (!milestoneId) return undefined;
  try {
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/milestones/${milestoneId}`,
      method: "GET",
      headers: buildGitHubHeaders(token)
    });
    if (resp.statusCode >= 200 && resp.statusCode < 300) return milestoneId;
    console.warn(`Milestone ID ${milestoneId} not found, skipping`);
  } catch (err) {
    console.warn("Error validating milestone:", err.message);
  }
  return undefined;
}

/**
 * Validate that project IDs exist and are accessible.
 * @param {number[]} projectIds - Array of GitHub project IDs
 * @param {string} token - GitHub access token
 * @returns {Promise<number[]>} Array of validated project IDs
 */
async function validateProjects(projectIds, token) {
  if (!Array.isArray(projectIds) || !projectIds.length) return [];
  const valid = [];
  for (const id of projectIds) {
    try {
      const resp = await githubRequest({
        hostname: "api.github.com",
        path: `/projects/${id}`,
        method: "GET",
        headers: buildGitHubHeaders(token)
      });
      if (resp.statusCode >= 200 && resp.statusCode < 300) valid.push(id);
      else console.warn(`Project ID ${id} not found, skipping`);
    } catch (err) {
      console.warn(`Error validating project ID ${id}:`, err.message);
    }
  }
  return valid;
}

/**
 * Safely parse JSON string without throwing errors.
 * @param {string} str - JSON string to parse
 * @returns {Object|Array|undefined} Parsed object or undefined if invalid
 */
function safeParseJSON(str) {
  if (!str) return undefined;
  try { return JSON.parse(str); } catch (err) { 
    console.warn('Failed to parse JSON:', err.message);
    return undefined; 
  }
}

/**
 * Find a GitHub issue by Jira key.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} token - GitHub access token
 * @param {string} jiraKey - Jira issue key to search for
 * @returns {Promise<Object|null>} GitHub issue object or null if not found
 */
async function findIssue(owner, repo, token, jiraKey) {
  if (!jiraKey) return null;
  
  try {
    const searchQuery = encodeURIComponent(`repo:${owner}/${repo} "${jiraKey}" in:title,body is:issue`);
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/search/issues?q=${searchQuery}`,
      method: "GET",
      headers: buildGitHubHeaders(token)
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

/**
 * Create a GitHub comment with proper attribution for unmapped users.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} token - GitHub access token
 * @param {number} issueNumber - GitHub issue number
 * @param {Object} jiraComment - Jira comment object
 * @param {Object} userMap - User mapping configuration
 * @returns {Promise<boolean>} True if comment was created successfully
 */
async function createGitHubComment(owner, repo, token, issueNumber, jiraComment, userMap) {
  try {
    const author = jiraComment.author || {};
    const created = jiraComment.created || new Date().toISOString();
    const userInfo = resolveUser(author, userMap);
    
    // Extract comment body with user map for mention resolution
    const commentBody = extractText(jiraComment.body, userMap) || 'No content';
    
    // Build comment body with proper attribution
    let finalCommentBody;
    if (userInfo.isMapped && userInfo.usernames.length > 0) {
      const mentions = userInfo.usernames.map(u => `@${u}`).join(', ');
      finalCommentBody = `**Comment by ${mentions}** (${userInfo.displayName} in Jira)\n\n${commentBody}`;
    } else {
      finalCommentBody = `**Comment by ${userInfo.displayName}**${userInfo.email ? ` (${userInfo.email})` : ''} in Jira\n\n${commentBody}\n\n---\n_Note: This Jira user is not mapped to a GitHub contributor. Consider adding them to the USER_MAP_JSON configuration._`;
    }
    finalCommentBody += `\n\n_Posted: ${created}_`;
    
    const resp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      method: "POST",
      headers: buildGitHubHeaders(token, true)
    }, JSON.stringify({ body: finalCommentBody }));
    
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      console.log(`Comment created successfully on issue #${issueNumber}`);
      return true;
    }
    console.error(`Failed to create comment: ${resp.statusCode}`, resp.body);
    return false;
  } catch (err) {
    console.error('Error creating GitHub comment:', err.message);
    return false;
  }
}

/**
 * Update GitHub issue status, labels, and body with current Jira information.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} token - GitHub access token
 * @param {number} issueNumber - GitHub issue number
 * @param {string} newStatusLabel - New status label to apply
 * @param {string} jiraStatusName - Jira status name
 * @param {string} startDate - Issue start date
 * @param {string} dueDate - Issue due date
 * @returns {Promise<void>}
 */
async function updateIssueStatus(owner, repo, token, issueNumber, newStatusLabel, jiraStatusName, startDate, dueDate) {
  try {
    const issueResp = await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: "GET",
      headers: buildGitHubHeaders(token)
    });
    
    if (issueResp.statusCode < 200 || issueResp.statusCode >= 300) return;
    
    const current = safeParseJSON(issueResp.body) || {};
    const existingLabels = (current.labels || []).map(l => typeof l === 'string' ? l : l.name).filter(Boolean);
    const preserved = existingLabels.filter(l => !String(l).toLowerCase().startsWith('status:'));
    const nextLabels = [...new Set([...preserved, newStatusLabel].filter(Boolean))];
    const desiredState = /^(done|resolved|closed)$/i.test(jiraStatusName || '') ? 'closed' : 'open';
    const nextBody = updateBodyDates(current.body, jiraStatusName, startDate, dueDate);

    await githubRequest({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: "PATCH",
      headers: buildGitHubHeaders(token, true)
    }, JSON.stringify({ labels: nextLabels, state: desiredState, body: nextBody }));
  } catch (err) {
    console.warn('Failed to update issue:', err.message);
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a) || "");
  const bBuf = Buffer.from(String(b) || "");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Validate Jira webhook secret using HMAC or plain-text comparison.
 * Supports multiple authentication methods for compatibility.
 * @param {Object} event - Lambda event object
 * @param {string} rawBody - Raw request body for HMAC validation
 * @returns {boolean} True if secret is valid or not configured
 */
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
    
    console.log(`Processing Jira webhook event: ${eventType}`);

    // GitHub / Jira config
    const owner = process.env.GITHUB_OWNER?.trim();
    const repo = process.env.GITHUB_REPO?.trim();
    const token = process.env.GITHUB_TOKEN?.trim();
    const jiraBaseUrl = process.env.JIRA_BASE_URL || "";
    const triggerLabels = (process.env.TRIGGER_LABELS || "create-github").split(",").map(s => s.trim()).filter(Boolean);
    const allowedTypes = (process.env.JIRA_TYPES || "Story,Task,Sub-task").split(",").map(s => s.trim()).filter(Boolean);
    const labelMap = safeParseJSON(process.env.LABEL_MAP_JSON);
    const userMap = safeParseJSON(process.env.USER_MAP_JSON);

    const projectIdsRaw = safeParseJSON(process.env.GITHUB_PROJECT_IDS) || [];
    const milestoneIdRaw = process.env.GITHUB_MILESTONE_ID ? parseInt(process.env.GITHUB_MILESTONE_ID) : undefined;

    if (!owner || !repo || !token) {
      return { statusCode: 500, body: JSON.stringify({ message: "Missing GitHub env configuration" }) };
    }

    // Handle comment events - Jira webhook events are: issue_commented, comment_created, comment_updated
    if (eventType === 'jira:issue_commented' || eventType === 'comment_created' || eventType === 'comment_updated') {
      const issue = jiraPayload.issue || {};
      const jiraKey = issue.key;
      const comment = jiraPayload.comment || {};
      
      console.log(`Comment event detected: ${eventType} for issue ${jiraKey}`);
      
      if (!jiraKey) {
        console.warn('No Jira key found in comment event');
        return { statusCode: 400, body: JSON.stringify({ message: 'No Jira key found' }) };
      }
      
      // Find the corresponding GitHub issue
      const ghIssue = await findIssue(owner, repo, token, jiraKey);
      
      if (!ghIssue || !ghIssue.number) {
        console.warn(`No GitHub issue found for ${jiraKey}, cannot sync comment`);
        return { statusCode: 200, body: JSON.stringify({ message: 'No corresponding GitHub issue found' }) };
      }
      
      // Create the comment in GitHub
      const success = await createGitHubComment(owner, repo, token, ghIssue.number, comment, userMap);
      
      if (success) {
        return { statusCode: 201, body: JSON.stringify({ message: 'Comment synced to GitHub' }) };
      } else {
        return { statusCode: 500, body: JSON.stringify({ message: 'Failed to sync comment' }) };
      }
    }
    
    // Handle issue events
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
    const description = extractText(fields.description, userMap) || "No description";
    const priority = fields.priority?.name || "Medium";
    const assignee = fields.assignee || null;
    const parentIssue = fields.parent || null;
    const isSubtask = issType === 'Sub-task';
    
    // Extract acceptance criteria
    const acCustomField = process.env.ACCEPTANCE_CRITERIA_FIELD || "customfield_10200";
    const acceptanceCriteria = extractAcceptanceCriteria(fields, acCustomField);

    // Build proper Jira browse URL 
    let jiraLink = "";
    if (jiraKey) {
      if (jiraBaseUrl) {
        // Use configured base URL
        jiraLink = `${jiraBaseUrl}/browse/${jiraKey}`;
      } else if (issue.self) {
        // Extract base URL from API URL: https://domain.atlassian.net/rest/api/2/issue/123 -> https://domain.atlassian.net
        const match = String(issue.self).match(/^(https?:\/\/[^\/]+)/);
        if (match) {
          jiraLink = `${match[1]}/browse/${jiraKey}`;
        }
      }
    }

    const ghLabels = mapLabels(labels, labelMap);
    const statusLabel = buildStatusLabel(statusName);
    if (statusLabel) ghLabels.push(statusLabel);
    if (isSubtask) ghLabels.push('subtask');
    
    // Resolve assignees with validation
    const assigneeInfo = resolveUser(assignee, userMap);
    const ghAssignees = [];
    
    // Validate each assignee
    for (const username of assigneeInfo.usernames) {
      const isValid = await validateGitHubUser(owner, repo, username, token);
      if (isValid) {
        ghAssignees.push(username);
      } else {
        console.warn(`GitHub user ${username} not found or invalid, skipping assignment`);
      }
    }
    
    // Log unmapped assignees
    if (!assigneeInfo.isMapped && assignee) {
      console.warn(`Jira assignee "${assigneeInfo.displayName}" (${assigneeInfo.email}) is not mapped to any GitHub user. Add to USER_MAP_JSON to enable auto-assignment.`);
    }

    const startDate = fields.customfield_10015 || undefined;
    const dueDate = fields.duedate || undefined;

    // Check if GitHub issue already exists (single API call instead of two)
    const existingIssue = await findIssue(owner, repo, token, jiraKey);

    if (existingIssue && existingIssue.number) {
      // On updates or duplicate creates, sync status and dates
      await updateIssueStatus(owner, repo, token, existingIssue.number, statusLabel, statusName, startDate, dueDate);
      return { statusCode: 200, body: JSON.stringify({ message: "GitHub issue already exists; synced status/dates" }) };
    }

    // Prepare GitHub issue body
    const bodyParts = [
      `Jira: ${jiraKey}`,
      jiraLink ? `Jira Link: ${jiraLink}` : undefined,
      "",
      isSubtask && parentIssue ? `**Subtask of:** ${parentIssue.key} - ${parentIssue.fields?.summary || 'Parent Issue'}` : undefined,
      isSubtask && parentIssue ? "" : undefined,
      "Description:",
      description,
      "",
      acceptanceCriteria ? "Acceptance Criteria:" : undefined,
      acceptanceCriteria || undefined,
      acceptanceCriteria ? "" : undefined,
      `Status: ${statusName || 'Not set'}`,
      `Due Date: ${dueDate || 'Not set'}`,
      `Start Date: ${startDate || 'Not set'}`,
      "",
      `Priority: ${priority}`
    ];
    // Add assignee information
    if (assigneeInfo.isMapped && ghAssignees.length > 0) {
      bodyParts.push(`Assignee: ${ghAssignees.map(u => `@${u}`).join(', ')}`);
    } else if (assignee?.displayName) {
      bodyParts.push(`Jira Assignee: ${assigneeInfo.displayName}`);
      if (assigneeInfo.email) {
        bodyParts.push(`Assignee Email: ${assigneeInfo.email}`);
      }
      if (!assigneeInfo.isMapped) {
        bodyParts.push("");
        bodyParts.push("_Note: Jira assignee is not mapped to a GitHub user. Add to USER_MAP_JSON configuration to enable auto-assignment._");
      }
    }
    
    const issueBody = bodyParts.filter(Boolean).join("\n");

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
      headers: buildGitHubHeaders(token, true)
    }, payload);

    if (createResp.statusCode < 200 || createResp.statusCode >= 300) {
      console.error("GitHub create issue failed:", createResp.statusCode, createResp.body);
      return { statusCode: 502, body: JSON.stringify({ message: "Failed to create GitHub issue", details: createResp.body }) };
    }

    console.log("GitHub response:", createResp.body);
    
    // Helper function to post a comment
    const postComment = async (issueNum, body) => {
      return githubRequest({
        hostname: "api.github.com",
        path: `/repos/${owner}/${repo}/issues/${issueNum}/comments`,
        method: "POST",
        headers: buildGitHubHeaders(token, true)
      }, JSON.stringify({ body }));
    };
    
    // If this is a subtask, link it to the parent GitHub issue
    if (isSubtask && parentIssue) {
      try {
        const parentGhIssue = await findIssue(owner, repo, token, parentIssue.key);
        if (parentGhIssue && parentGhIssue.number) {
          const newIssueData = safeParseJSON(createResp.body);
          const newIssueNumber = newIssueData?.number;
          
          if (newIssueNumber) {
            await Promise.all([
              postComment(parentGhIssue.number, `**Subtask created:** #${newIssueNumber} - ${title}\n\nJira: ${jiraKey}`),
              postComment(newIssueNumber, `**Parent issue:** #${parentGhIssue.number} - ${parentIssue.fields?.summary || 'Parent Issue'}\n\nJira Parent: ${parentIssue.key}`)
            ]);
            console.log(`Linked subtask #${newIssueNumber} to parent #${parentGhIssue.number}`);
          }
        } else {
          console.warn(`Parent issue ${parentIssue.key} not found in GitHub`);
        }
      } catch (err) {
        console.warn('Failed to link subtask to parent:', err.message);
      }
    }
    
    return { statusCode: 201, body: JSON.stringify({ message: "GitHub issue created" }) };

  } catch (err) {
    console.error("Unhandled error in Lambda:", err);
    return { statusCode: 500, body: JSON.stringify({ message: "Internal server error", details: err.message }) };
  }
};
