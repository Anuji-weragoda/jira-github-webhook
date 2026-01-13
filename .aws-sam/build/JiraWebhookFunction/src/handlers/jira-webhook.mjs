import https from "https";
import crypto from "crypto";


const GITHUB_API = "api.github.com";
const GITHUB_UPLOADS = "uploads.github.com";
const REQUEST_TIMEOUT = 30000;
const MAX_IMAGE_REDIRECTS = 5;
const JIRA_IMAGE_RELEASE_TAG = "jira-images";



/**
 * Safely parse JSON without throwing errors
 */
const safeParseJSON = (str) => {
  if (!str) return undefined;
  try {
    return JSON.parse(str);
  } catch (err) {
    console.warn("Failed to parse JSON:", err.message);
    return undefined;
  }
};

/**
 * Timing-safe string comparison to prevent timing attacks
 */
const timingSafeEqualStr = (a, b) => {
  const aBuf = Buffer.from(String(a) || "");
  const bBuf = Buffer.from(String(b) || "");
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
};


/**
 * Extract plain text from Jira ADF (Atlassian Document Format)
 * Handles nested structures 
 */
function extractText(adfNode) {
  if (!adfNode) return "";

  // Handle string nodes with wiki markup conversion
  if (typeof adfNode === "string") {
    return adfNode.replace(
      /!([^\|!]+)\|([^!]*)!/g,
      (_, filename, params) => {
        const alt = params.match(/alt="([^"]+)"/)?.[1] || filename;
        return `![${alt}](${filename})`;
      }
    );
  }

  if (Array.isArray(adfNode)) {
    return adfNode.map(extractText).join("\n");
  }

  const { type, text, content } = adfNode;

  // Skip media nodes
  if (["image", "media", "embed"].includes(type)) return "";

  // Return text content
  if (text) return text;

  // Recursively process content
  if (content) {
    const separator = type === "paragraph" ? "" : "\n";
    return content.map(extractText).join(separator);
  }

  return "";
}


/**
 * Extract acceptance criteria from Jira fields
 */
function extractAcceptanceCriteria(fields, customFieldName) {

  if (customFieldName && fields[customFieldName]) {
    return extractText(fields[customFieldName]);
  }

  return "";
}


class GitHubClient {
  constructor(token) {
    this.token = token;
  }

  /**
   * Build standard GitHub API headers
   */
  buildHeaders(includeContentType = false) {
    const headers = {
      Authorization: `token ${this.token}`,
      "User-Agent": "jira-webhook",
      Accept: "application/vnd.github+json",
    };
    if (includeContentType) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Make an HTTPS request to GitHub API
   */
  async request(options, payload = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            body: data,
            headers: res.headers || {},
          })
        );
        res.on("error", reject);
      });

      req.on("error", reject);
      req.setTimeout(REQUEST_TIMEOUT, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (payload) req.write(Buffer.isBuffer(payload) ? payload : String(payload));
      req.end();
    });
  }

  /**
   * Validate that a GitHub resource exists
   */
  async validateResource(path) {
    try {
      const resp = await this.request({
        hostname: GITHUB_API,
        path,
        method: "GET",
        headers: this.buildHeaders(),
      });
      return resp.statusCode >= 200 && resp.statusCode < 300;
    } catch (err) {
      console.warn(`Error validating resource ${path}:`, err.message);
      return false;
    }
  }

  /**
   * Validate GitHub username
   */
  async validateUser(username) {
    if (!username) return false;
    const isValid = await this.validateResource(`/users/${encodeURIComponent(username)}`);
    if (!isValid) console.warn(`GitHub user ${username} not found`);
    return isValid;
  }

  /**
   * Validate milestone
   */
  async validateMilestone(owner, repo, milestoneId) {
    if (!milestoneId) return undefined;
    const isValid = await this.validateResource(`/repos/${owner}/${repo}/milestones/${milestoneId}`);
    if (!isValid) console.warn(`Milestone ID ${milestoneId} not found`);
    return isValid ? milestoneId : undefined;
  }

  /**
   * Validate project IDs
   */
  async validateProjects(projectIds) {
    if (!Array.isArray(projectIds) || !projectIds.length) return [];
    const valid = [];
    for (const id of projectIds) {
      if (await this.validateResource(`/projects/${id}`)) {
        valid.push(id);
      } else {
        console.warn(`Project ID ${id} not found`);
      }
    }
    return valid;
  }

  /**
   * Search for GitHub issue by Jira key
   */
  async findIssue(owner, repo, jiraKey) {
    if (!jiraKey) return null;

    try {
      // Search in title
      const titleQuery = encodeURIComponent(`repo:${owner}/${repo} "${jiraKey}:" in:title is:issue`);
      const titleResp = await this.request({
        hostname: GITHUB_API,
        path: `/search/issues?q=${titleQuery}`,
        method: "GET",
        headers: this.buildHeaders(),
      });

      if (titleResp.statusCode >= 200 && titleResp.statusCode < 300) {
        const { items = [] } = safeParseJSON(titleResp.body) || {};
        const match = items.find((item) => item.title?.startsWith(`${jiraKey}:`));
        if (match) {
          console.log(`Found existing issue #${match.number} for ${jiraKey}`);
          return match;
        }
      }

      // Fallback: search in body
      const bodyQuery = encodeURIComponent(`repo:${owner}/${repo} "Jira: ${jiraKey}" in:body is:issue`);
      const bodyResp = await this.request({
        hostname: GITHUB_API,
        path: `/search/issues?q=${bodyQuery}`,
        method: "GET",
        headers: this.buildHeaders(),
      });

      if (bodyResp.statusCode >= 200 && bodyResp.statusCode < 300) {
        const { items = [] } = safeParseJSON(bodyResp.body) || {};
        const match = items.find((item) => item.body?.includes(`Jira: ${jiraKey}`));
        if (match) {
          console.log(`Found existing issue #${match.number} for ${jiraKey} (via body)`);
          return match;
        }
      }
    } catch (err) {
      console.warn("findIssue search failed:", err.message);
    }

    console.log(`No existing GitHub issue found for ${jiraKey}`);
    return null;
  }

  /**
   * Create GitHub issue
   */
  async createIssue(owner, repo, issueData) {
    const resp = await this.request(
      {
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/issues`,
        method: "POST",
        headers: this.buildHeaders(true),
      },
      JSON.stringify(issueData)
    );

    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw new Error(`Failed to create issue: ${resp.statusCode} ${resp.body}`);
    }

    return safeParseJSON(resp.body);
  }

  /**
   * Create GitHub comment
   */
  async createComment(owner, repo, issueNumber, body) {
    const resp = await this.request(
      {
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        method: "POST",
        headers: this.buildHeaders(true),
      },
      JSON.stringify({ body })
    );

    return resp.statusCode >= 200 && resp.statusCode < 300;
  }

  /**
   * Update GitHub issue
   */
  async updateIssue(owner, repo, issueNumber, updates) {
    const resp = await this.request(
      {
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
        method: "PATCH",
        headers: this.buildHeaders(true),
      },
      JSON.stringify(updates)
    );

    return resp.statusCode >= 200 && resp.statusCode < 300;
  }

  /**
   * Get GitHub issue details
   */
  async getIssue(owner, repo, issueNumber) {
    const resp = await this.request({
      hostname: GITHUB_API,
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: "GET",
      headers: this.buildHeaders(),
    });

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return safeParseJSON(resp.body);
    }
    return null;
  }
}



class ImageHandler {
  constructor(jiraEmail, jiraToken, githubClient) {
    this.jiraEmail = jiraEmail;
    this.jiraToken = jiraToken;
    this.githubClient = githubClient;
  }

  /**
   * Download image from Jira with authentication
   */
  async downloadFromJira(contentUrl, maxRedirects = MAX_IMAGE_REDIRECTS) {
    if (!this.jiraEmail || !this.jiraToken) {
      console.warn("Jira credentials not provided, cannot download images");
      return null;
    }

    const auth = Buffer.from(`${this.jiraEmail}:${this.jiraToken}`).toString("base64");
    let currentUrl = contentUrl;
    let redirectCount = 0;

    while (redirectCount < maxRedirects) {
      try {
        const url = new URL(currentUrl);
        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "GET",
            headers: {
              Authorization: `Basic ${auth}`,
              "User-Agent": "jira-webhook",
            },
          };

          const req = https.request(options, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              resolve({ redirect: res.headers.location });
              return;
            }

            // Handle success
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () => resolve({ data: Buffer.concat(chunks) }));
              res.on("error", reject);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });

          req.on("error", reject);
          req.setTimeout(REQUEST_TIMEOUT, () => {
            req.destroy();
            reject(new Error("Download timeout"));
          });
          req.end();
        });

        if (result.redirect) {
          currentUrl = result.redirect;
          redirectCount++;
          console.log(`Following redirect ${redirectCount}/${maxRedirects}`);
          continue;
        }

        if (result.data) {
          console.log(`Downloaded image: ${contentUrl} (${result.data.length} bytes)`);
          return result.data;
        }
      } catch (err) {
        console.warn(`Failed to download Jira image: ${err.message}`);
        return null;
      }
    }

    console.warn(`Too many redirects for: ${contentUrl}`);
    return null;
  }

  /**
   * Upload image to GitHub release assets
   */
  async uploadToGitHub(owner, repo, filename, imageData) {
    try {
      // Get or create release for image storage
      let releaseId = await this.getOrCreateRelease(owner, repo);
      if (!releaseId) return null;

      // Upload asset
      const url = new URL(`https://${GITHUB_UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
      const resp = await this.githubClient.request(
        {
          hostname: url.hostname,
          path: `${url.pathname}${url.search}?name=${encodeURIComponent(filename)}`,
          method: "POST",
          headers: {
            Authorization: `token ${this.githubClient.token}`,
            "User-Agent": "jira-webhook",
            "Content-Type": "application/octet-stream",
            "Content-Length": imageData.length,
          },
        },
        imageData
      );

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        console.warn(`Failed to upload asset: ${resp.statusCode}`);
        return null;
      }

      const { browser_download_url } = safeParseJSON(resp.body) || {};
      console.log(`Uploaded image to GitHub: ${browser_download_url}`);
      return browser_download_url;
    } catch (err) {
      console.warn(`Error uploading image: ${err.message}`);
      return null;
    }
  }

  /**
   * Get or create release for image storage
   */
  async getOrCreateRelease(owner, repo) {
    try {
      // Try to get existing release
      const listResp = await this.githubClient.request({
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/releases`,
        method: "GET",
        headers: this.githubClient.buildHeaders(),
      });

      if (listResp.statusCode === 200) {
        const releases = safeParseJSON(listResp.body) || [];
        const existing = releases.find((r) => r.tag_name === JIRA_IMAGE_RELEASE_TAG);
        if (existing) return existing.id;
      }

      // Create new release
      const createResp = await this.githubClient.request(
        {
          hostname: GITHUB_API,
          path: `/repos/${owner}/${repo}/releases`,
          method: "POST",
          headers: this.githubClient.buildHeaders(true),
        },
        JSON.stringify({
          tag_name: JIRA_IMAGE_RELEASE_TAG,
          name: "Jira Synced Images",
          body: "Images synced from Jira issues",
          draft: false,
          prerelease: true,
        })
      );

      if (createResp.statusCode >= 200 && createResp.statusCode < 300) {
        const { id } = safeParseJSON(createResp.body) || {};
        return id;
      }

      console.warn(`Failed to create release: ${createResp.statusCode}`);
      return null;
    } catch (err) {
      console.warn(`Error managing release: ${err.message}`);
      return null;
    }
  }

  /**
   * Process and re-host images from attachment map
   */
  async processImages(attachmentMap, owner, repo) {
    const urlMap = {};

    for (const [filename, jiraUrl] of Object.entries(attachmentMap)) {
      let publicUrl = jiraUrl;

      if (this.jiraEmail && this.jiraToken) {
        try {
          const imageData = await this.downloadFromJira(jiraUrl);
          if (imageData) {
            const uploadedUrl = await this.uploadToGitHub(owner, repo, filename, imageData);
            if (uploadedUrl) {
              publicUrl = uploadedUrl;
              console.log(`Image re-hosted: ${filename}`);
            }
          }
        } catch (err) {
          console.warn(`Failed to re-host image ${filename}: ${err.message}`);
        }
      }

      urlMap[filename] = publicUrl;
    }

    return urlMap;
  }
}



class ConfigManager {
  constructor(env) {
    this.env = env;
  }

  get github() {
    return {
      owner: this.env.GITHUB_OWNER?.trim(),
      repo: this.env.GITHUB_REPO?.trim(),
      token: this.env.GITHUB_TOKEN?.trim(),
      milestoneId: this.env.GITHUB_MILESTONE_ID ? parseInt(this.env.GITHUB_MILESTONE_ID) : undefined,
      projectIds: safeParseJSON(this.env.GITHUB_PROJECT_IDS) || [],
    };
  }

  get jira() {
    return {
      baseUrl: this.env.JIRA_BASE_URL || "",
      email: this.env.JIRA_EMAIL?.trim(),
      token: this.env.JIRA_API_TOKEN?.trim(),
      webhookSecret: this.env.JIRA_WEBHOOK_SECRET?.trim(),
      triggerLabels: (this.env.TRIGGER_LABELS || "create-github").split(",").map((s) => s.trim()).filter(Boolean),
      allowedTypes: (this.env.JIRA_TYPES || "Story,Task,Sub-task").split(",").map((s) => s.trim()).filter(Boolean),
      acField: this.env.ACCEPTANCE_CRITERIA_FIELD || "customfield_10200",
    };
  }

  get mappings() {
    return {
      labels: safeParseJSON(this.env.LABEL_MAP_JSON) || {},
      users: safeParseJSON(this.env.USER_MAP_JSON) || {},
    };
  }

  hasTriggerLabel(issueLabels) {
    if (!Array.isArray(issueLabels) || !issueLabels.length) return false;
    const triggerSet = new Set(this.jira.triggerLabels);
    return issueLabels.some((l) => triggerSet.has(l));
  }

  mapLabels(jiraLabels) {
    const out = [];
    const seen = new Set();

    for (const jl of jiraLabels || []) {
      const mapped = this.mappings.labels[jl];
      const labels = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [jl];

      labels.forEach((label) => {
        if (!seen.has(label)) {
          seen.add(label);
          out.push(label);
        }
      });
    }

    if (!seen.has("from-jira")) {
      seen.add("from-jira");
      out.push("from-jira");
    }

    return out;
  }

  resolveUser(jiraUser) {
    if (!jiraUser) {
      return { usernames: [], displayName: "Unknown", email: null, isMapped: false };
    }

    const displayName = jiraUser.displayName || "Unknown User";
    const email = jiraUser.emailAddress || null;
    const lookupKeys = [email, displayName].filter(Boolean);

    for (const key of lookupKeys) {
      const mapped = this.mappings.users[key];
      if (mapped) {
        const usernames = Array.isArray(mapped) ? mapped : [mapped];
        return { usernames, displayName, email, isMapped: true };
      }
    }

    return { usernames: [], displayName, email, isMapped: false };
  }

  buildStatusLabel(statusName) {
    return statusName ? `status: ${statusName}` : undefined;
  }
}



class IssueSyncHandler {
  constructor(config, githubClient, imageHandler) {
    this.config = config;
    this.github = githubClient;
    this.images = imageHandler;
  }

  /**
   * Build issue body with metadata
   */
  buildIssueBody(issue, description, acceptanceCriteria, attachmentUrlMap = {}) {
    const { fields } = issue;
    const statusName = fields.status?.name;
    const priority = fields.priority?.name || "Medium";
    const dueDate = fields.duedate;
    const startDate = fields.customfield_10015;
    const assignee = fields.assignee;
    const parentIssue = fields.parent;
    const isSubtask = fields.issuetype?.subtask === true || fields.issuetype?.name === "Sub-task";
    const hasParent = !!parentIssue;

    // Replace image filenames with URLs
    let processedDescription = description;
    for (const [filename, url] of Object.entries(attachmentUrlMap)) {
      const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedFilename}\\)`, "g");
      processedDescription = processedDescription.replace(pattern, `![$1](${url})`);
    }

    const jiraKey = issue.key;
    const jiraLink = this.buildJiraLink(jiraKey, issue.self);
    const assigneeInfo = this.config.resolveUser(assignee);

    const bodyParts = [
      `Jira: ${jiraKey}`,
      jiraLink ? `Jira Link: ${jiraLink}` : null,
      "",
      hasParent ? `**${isSubtask ? "Subtask" : "Child"} of:** ${parentIssue.key} - ${parentIssue.fields?.summary || "Parent Issue"}` : null,
      hasParent ? "" : null,
      "Description:",
      processedDescription,
      "",
      acceptanceCriteria ? "Acceptance Criteria:" : null,
      acceptanceCriteria || null,
      acceptanceCriteria ? "" : null,
      `Status: ${statusName || "Not set"}`,
      `Due Date: ${dueDate || "Not set"}`,
      `Start Date: ${startDate || "Not set"}`,
      "",
      `Priority: ${priority}`,
    ];

    // Add assignee info
    if (assigneeInfo.isMapped && assigneeInfo.usernames.length > 0) {
      bodyParts.push(`Assignee: ${assigneeInfo.usernames.map((u) => `@${u}`).join(", ")}`);
    } else if (assignee) {
      bodyParts.push(`Jira Assignee: ${assigneeInfo.displayName}`);
      if (assigneeInfo.email) bodyParts.push(`Assignee Email: ${assigneeInfo.email}`);
      if (!assigneeInfo.isMapped) {
        bodyParts.push("", "_Note: Jira assignee not mapped to GitHub user. Add to USER_MAP_JSON._");
      }
    }

    return bodyParts.filter(Boolean).join("\n");
  }

  /**
   * Build Jira browse URL
   */
  buildJiraLink(jiraKey, selfUrl) {
    if (!jiraKey) return "";

    const baseUrl = this.config.jira.baseUrl;
    if (baseUrl) {
      return `${baseUrl}/browse/${jiraKey}`;
    }

    const match = String(selfUrl).match(/^(https?:\/\/[^\/]+)/);
    return match ? `${match[1]}/browse/${jiraKey}` : "";
  }

  /**
   * Update issue body with current status and dates
   */
  updateBodyDates(oldBody, statusName, startDate, dueDate) {
    const lines = String(oldBody || "").split("\n");
    const filtered = lines.filter((l) => !/^(Status|Due Date|Start Date|Acceptance Criteria):/.test(l));

    return [
      ...filtered,
      "",
      `Status: ${statusName || "Not set"}`,
      `Due Date: ${dueDate || "Not set"}`,
      `Start Date: ${startDate || "Not set"}`,
    ].join("\n");
  }

/**
   * Process comment and create on GitHub
   */
  async syncComment(owner, repo, issueNumber, jiraComment, issueFields = null) {
    const author = jiraComment.author || {};
    const created = jiraComment.created || new Date().toISOString();
    const userInfo = this.config.resolveUser(author);

    let commentBody = extractText(jiraComment.body) || "No content";

    // Build comment with attribution
    let finalBody;
    if (userInfo.isMapped && userInfo.usernames.length > 0) {
      const mentions = userInfo.usernames.map((u) => `@${u}`).join(", ");
      finalBody = `**Comment by ${mentions}** (${userInfo.displayName} in Jira)\n\n${commentBody}`;
    } else {
      finalBody = `**Comment by ${userInfo.displayName}**${userInfo.email ? ` (${userInfo.email})` : ""} in Jira\n\n${commentBody}\n\n---\n_Note: This Jira user is not mapped to a GitHub contributor._`;
    }
    
    finalBody += `\n_Posted: ${created}_`;

    return await this.github.createComment(owner, repo, issueNumber, finalBody);
  }

  /**
   * Update issue status and dates
   */
  async updateIssueStatus(owner, repo, issueNumber, statusLabel, statusName, startDate, dueDate) {
    try {
      const current = await this.github.getIssue(owner, repo, issueNumber);
      if (!current) return;

      const existingLabels = (current.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
      const preserved = existingLabels.filter((l) => !l.toLowerCase().startsWith("status:"));
      const nextLabels = [...new Set([...preserved, statusLabel].filter(Boolean))];
      const desiredState = /^(done|resolved|closed)$/i.test(statusName || "") ? "closed" : "open";
      const nextBody = this.updateBodyDates(current.body, statusName, startDate, dueDate);

      await this.github.updateIssue(owner, repo, issueNumber, {
        labels: nextLabels,
        state: desiredState,
        body: nextBody,
      });

      console.log(`Updated issue #${issueNumber} status`);
    } catch (err) {
      console.warn("Failed to update issue:", err.message);
    }
  }

  /**
   * Link child/subtask to parent issue
   */
  async linkToParent(owner, repo, newIssueNumber, newIssueTitle, jiraKey, parentIssue, isSubtask) {
    try {
      const parentGhIssue = await this.github.findIssue(owner, repo, parentIssue.key);
      if (!parentGhIssue?.number) {
        console.warn(`Parent issue ${parentIssue.key} not found in GitHub`);
        return;
      }

      const relationshipLabel = isSubtask ? "Subtask" : "Child issue";
      await Promise.all([
        this.github.createComment(
          owner,
          repo,
          parentGhIssue.number,
          `**${relationshipLabel} created:** #${newIssueNumber} - ${newIssueTitle}\n\nJira: ${jiraKey}`
        ),
        this.github.createComment(
          owner,
          repo,
          newIssueNumber,
          `**Parent issue:** #${parentGhIssue.number} - ${parentIssue.fields?.summary || "Parent Issue"}\n\nJira Parent: ${parentIssue.key}`
        ),
      ]);

      console.log(`Linked ${relationshipLabel.toLowerCase()} #${newIssueNumber} to parent #${parentGhIssue.number}`);
    } catch (err) {
      console.warn("Failed to link to parent:", err.message);
    }
  }

  /**
   * Create new GitHub issue from Jira issue
   */
  async createIssue(owner, repo, issue) {
    const { fields } = issue;
    const jiraKey = issue.key;
    const title = `${jiraKey}: ${fields.summary || jiraKey || "New Jira Item"}`;
    const labels = fields.labels || [];
    const statusName = fields.status?.name;

    // Extract and process description
    const description = extractText(fields.description) || "No description";
    const acceptanceCriteria = extractAcceptanceCriteria(fields, this.config.jira.acField);

    // Build attachment map and process images
    const attachmentMap = {};
    if (Array.isArray(fields.attachment)) {
      fields.attachment.forEach((att) => {
        if (att.filename && att.content) {
          attachmentMap[att.filename] = att.content;
        }
      });
    }

    const attachmentUrlMap = await this.images.processImages(attachmentMap, owner, repo);

    // Build labels
    const ghLabels = this.config.mapLabels(labels);
    const statusLabel = this.config.buildStatusLabel(statusName);
    if (statusLabel) ghLabels.push(statusLabel);

    // Add subtask/child labels
    const isSubtask = fields.issuetype?.subtask === true || fields.issuetype?.name === "Sub-task";
    const hasParent = !!fields.parent;
    if (isSubtask) ghLabels.push("subtask");
    if (hasParent && !isSubtask) ghLabels.push("child-issue");

    // Resolve and validate assignees
    const assigneeInfo = this.config.resolveUser(fields.assignee);
    const ghAssignees = [];
    for (const username of assigneeInfo.usernames) {
      if (await this.github.validateUser(username)) {
        ghAssignees.push(username);
      } else {
        console.warn(`GitHub user ${username} not found, skipping assignment`);
      }
    }

    if (!assigneeInfo.isMapped && fields.assignee) {
      console.warn(`Jira assignee "${assigneeInfo.displayName}" not mapped to GitHub user`);
    }

    // Validate milestone and projects
    const milestoneId = await this.github.validateMilestone(owner, repo, this.config.github.milestoneId);
    const projectIds = await this.github.validateProjects(this.config.github.projectIds);

    // Build issue body
    const body = this.buildIssueBody(issue, description, acceptanceCriteria, attachmentUrlMap);

    // Create issue
    const issueData = {
      title,
      body,
      labels: ghLabels,
      assignees: ghAssignees,
      milestone: milestoneId,
      project_ids: projectIds,
    };

    const createdIssue = await this.github.createIssue(owner, repo, issueData);
    console.log(`Created GitHub issue #${createdIssue.number} for ${jiraKey}`);

    // Link to parent if applicable
    if (hasParent && fields.parent && createdIssue.number) {
      await this.linkToParent(owner, repo, createdIssue.number, fields.summary, jiraKey, fields.parent, isSubtask);
    }

    return createdIssue;
  }
}



/**
 * Validate Jira webhook secret using HMAC or plain-text
 */
function validateJiraSecret(event, rawBody, secret) {
  if (!secret) return true;

  const headers = event.headers || {};
  const qs = event.queryStringParameters || {};

  // Normalize headers
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }

  // HMAC verification
  const sigHeader = lower["x-hub-signature"] || lower["x-hub-signature-256"];
  if (sigHeader && rawBody != null) {
    const parts = String(sigHeader).split("=");
    const provided = parts.length === 2 ? parts[1] : parts[0];
    const computed = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    return timingSafeEqualStr(provided, computed);
  }

  // Fallback: plain-text comparison
  const candidate =
    lower["x-atlassian-webhook-secret"] ||
    lower["x-jira-webhook-secret"] ||
    lower["x-webhook-secret"] ||
    lower["x-hook-secret"] ||
    qs.secret ||
    qs.token;

  return String(candidate || "").trim() === secret;
}



export const handler = async (event) => {
  try {
    console.log("Incoming Jira webhook");

    // Decode payload
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";

    // Initialize configuration
    const config = new ConfigManager(process.env);

    // Validate webhook secret
    if (!validateJiraSecret(event, rawBody, config.jira.webhookSecret)) {
      console.warn("Invalid Jira webhook secret");
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    // Parse payload
    let jiraPayload;
    try {
      jiraPayload = JSON.parse(rawBody);
    } catch (err) {
      console.error("Invalid JSON payload:", err);
      return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON payload" }) };
    }

    const eventType = jiraPayload.webhookEvent;
    const issue = jiraPayload.issue || {};
    const jiraKey = issue.key;

    console.log(`Processing: ${eventType} for ${jiraKey}`);

    // Validate GitHub configuration
    const { owner, repo, token } = config.github;
    if (!owner || !repo || !token) {
      return { statusCode: 500, body: JSON.stringify({ message: "Missing GitHub configuration" }) };
    }

    // Initialize clients
    const githubClient = new GitHubClient(token);
    const imageHandler = new ImageHandler(config.jira.email, config.jira.token, githubClient);
    const issueSync = new IssueSyncHandler(config, githubClient, imageHandler);

    // Handle comment events
    if (["jira:issue_commented", "comment_created", "comment_updated"].includes(eventType)) {
      const comment = jiraPayload.comment || {};

      if (!jiraKey) {
        console.warn("No Jira key found in comment event");
        return { statusCode: 400, body: JSON.stringify({ message: "No Jira key found" }) };
      }

      const ghIssue = await githubClient.findIssue(owner, repo, jiraKey);
      if (!ghIssue?.number) {
        console.warn(`No GitHub issue found for ${jiraKey}`);
        return { statusCode: 200, body: JSON.stringify({ message: "No corresponding GitHub issue" }) };
      }

  
      const fields = issue.fields || {};
      const success = await issueSync.syncComment(owner, repo, ghIssue.number, comment, fields);
      
      return {
        statusCode: success ? 201 : 500,
        body: JSON.stringify({ message: success ? "Comment synced" : "Failed to sync comment" }),
      };
    }

    // Handle issue events
    const fields = issue.fields || {};
    const issueType = fields.issuetype?.name;
    const labels = fields.labels || [];
    const statusName = fields.status?.name;

    console.log(`Type: ${issueType}, Labels: ${labels.join(", ")}, Status: ${statusName}`);

    // Validate issue type and labels
    if (!config.jira.allowedTypes.includes(issueType)) {
      console.info(`Unsupported type: ${issueType}`);
      return { statusCode: 200, body: JSON.stringify({ message: `Unsupported type: ${issueType}` }) };
    }

    if (!config.hasTriggerLabel(labels)) {
      console.info("Trigger label not present");
      return { statusCode: 200, body: JSON.stringify({ message: "Trigger label not present" }) };
    }

    // Check if issue already exists
    const existingIssue = await githubClient.findIssue(owner, repo, jiraKey);

    if (existingIssue?.number) {
      console.log(`Issue #${existingIssue.number} already exists, syncing status`);
      const statusLabel = config.buildStatusLabel(statusName);
      const startDate = fields.customfield_10015;
      const dueDate = fields.duedate;

      await issueSync.updateIssueStatus(owner, repo, existingIssue.number, statusLabel, statusName, startDate, dueDate);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Issue already exists; synced status",
          issueNumber: existingIssue.number,
          jiraKey,
        }),
      };
    }

    // Create new issue
    console.log(`Creating new GitHub issue for ${jiraKey}`);
    const createdIssue = await issueSync.createIssue(owner, repo, issue);

    return {
      statusCode: 201,
      body: JSON.stringify({
        message: "GitHub issue created",
        issueNumber: createdIssue.number,
        jiraKey,
      }),
    };
  } catch (err) {
    console.error("Unhandled error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        details: err.message,
      }),
    };
  }
}