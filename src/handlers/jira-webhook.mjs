import https from "https";
import crypto from "crypto";


const GITHUB_API = process.env.GITHUB_API_HOSTNAME || "api.github.com";
const GITHUB_UPLOADS = process.env.GITHUB_UPLOADS_HOSTNAME || "uploads.github.com";
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);
const MAX_IMAGE_REDIRECTS = parseInt(process.env.MAX_IMAGE_REDIRECTS || "5", 10);
const JIRA_IMAGE_RELEASE_TAG = process.env.JIRA_IMAGE_RELEASE_TAG || "jira-images";

// Global cache for Jira field mappings (in-memory cache for Lambda warm starts)
let JIRA_FIELD_MAP_CACHE = null;


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
 * Extract start date from Jira fields
 * Uses the configured/resolved field ID from the field mapper
 */
function extractStartDate(fields, customFieldId) {
  // Return value if the resolved field ID exists in fields
  if (customFieldId && fields[customFieldId]) {
    return fields[customFieldId] || null;
  }

  return null;
}


/**
 * Jira Field Mapper - Fetches and caches field mappings from Jira API
 */
class JiraFieldMapper {
  constructor(jiraBaseUrl, email, token) {
    this.jiraBaseUrl = jiraBaseUrl;
    this.email = email;
    this.token = token;
    this.fieldMap = JIRA_FIELD_MAP_CACHE; // Use global cache
  }

  /**
   * Fetch field mappings from Jira API
   */
  async fetchFieldMap() {
    if (this.fieldMap) {
      console.log('Using cached Jira field map');
      return this.fieldMap;
    }

    if (!this.jiraBaseUrl || !this.email || !this.token) {
      console.warn('Jira credentials not provided, cannot fetch field map');
      return {};
    }

    try {
      const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
      const url = new URL(this.jiraBaseUrl);

      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: url.hostname,
            path: '/rest/api/3/field',
            method: 'GET',
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: 'application/json',
              'User-Agent': 'jira-webhook',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(data);
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            });
            res.on('error', reject);
          }
        );

        req.on('error', reject);
        req.setTimeout(REQUEST_TIMEOUT, () => {
          req.destroy();
          reject(new Error('Field fetch timeout'));
        });
        req.end();
      });

      const fields = safeParseJSON(result) || [];
      const map = {};
      const idToName = {};
  
      fields.forEach((field) => {
        const fieldName = field.name ? field.name.toLowerCase().trim() : '';
        const fieldId = field.id;

        if (fieldName && fieldId) {
          // Map both name -> id and id -> name
          map[fieldName] = fieldId;
          idToName[fieldId] = field.name;
        }
      });

      this.fieldMap = { map, idToName };
      JIRA_FIELD_MAP_CACHE = this.fieldMap; // Cache globally
      console.log(`Fetched ${Object.keys(map).length} Jira field mappings`);
      return this.fieldMap;
    } catch (err) {
      console.warn(`Failed to fetch Jira field map: ${err.message}`);
      return {};
    }
  }

  /**
   * Resolve field names to IDs
   */
  async resolveFieldNames(fieldNames) {
    const fieldMap = await this.fetchFieldMap();
    const { map = {} } = fieldMap;
    const resolvedIds = [];

    const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames].filter(Boolean);

    for (const name of names) {
      if (!name) continue;

      // If it's already a field ID (starts with 'customfield_' or is a system field)
      if (name.startsWith('customfield_') || ['summary', 'description', 'status'].includes(name)) {
        resolvedIds.push(name);
        continue;
      }

      // Try to resolve from map
      const normalizedName = name.toLowerCase().trim();
      const fieldId = map[normalizedName];

      if (fieldId) {
        console.log(`Resolved field name "${name}" -> ${fieldId}`);
        resolvedIds.push(fieldId);
      } else {
        console.warn(`Could not resolve field name: ${name}`);
      }
    }

    return resolvedIds;
  }

  /**
   * Get field name from ID
   */
  async getFieldName(fieldId) {
    const fieldMap = await this.fetchFieldMap();
    const { idToName = {} } = fieldMap;
    return idToName[fieldId] || fieldId;
  }
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
   * List GitHub issue comments
   */
  async listComments(owner, repo, issueNumber) {
    const resp = await this.request({
      hostname: GITHUB_API,
      path: `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      method: "GET",
      headers: this.buildHeaders(false),
    });

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return safeParseJSON(resp.body) || [];
    }
    return [];
  }

  /**
   * Update GitHub comment
   */
  async updateComment(owner, repo, commentId, body) {
    const resp = await this.request(
      {
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/issues/comments/${commentId}`,
        method: "PATCH",
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

  /**
   * Check if a label exists in the repository
   */
  async labelExists(owner, repo, labelName) {
    try {
      const resp = await this.request({
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/labels/${encodeURIComponent(labelName)}`,
        method: "GET",
        headers: this.buildHeaders(),
      });
      return resp.statusCode >= 200 && resp.statusCode < 300;
    } catch (err) {
      console.warn(`Error checking label ${labelName}:`, err.message);
      return false;
    }
  }

  /**
   * Create a label in the repository
   */
  async createLabel(owner, repo, labelName, color = "0366d6", description = "") {
    try {
      const resp = await this.request(
        {
          hostname: GITHUB_API,
          path: `/repos/${owner}/${repo}/labels`,
          method: "POST",
          headers: this.buildHeaders(true),
        },
        JSON.stringify({
          name: labelName,
          color: color,
          description: description,
        })
      );

      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        console.log(`Created label: ${labelName}`);
        return true;
      } else {
        console.warn(`Failed to create label ${labelName}: ${resp.statusCode} ${resp.body}`);
        return false;
      }
    } catch (err) {
      console.warn(`Error creating label ${labelName}:`, err.message);
      return false;
    }
  }

  /**
   * Ensure labels exist, create them if they don't
   */
  async ensureLabels(owner, repo, labels) {
    const ensuredLabels = [];
    
    for (const label of labels) {
      const exists = await this.labelExists(owner, repo, label);
      if (!exists) {
        console.log(`Label "${label}" does not exist, creating...`);
        const created = await this.createLabel(owner, repo, label);
        if (created) {
          ensuredLabels.push(label);
        }
      } else {
        ensuredLabels.push(label);
      }
    }
    
    return ensuredLabels;
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
   * Sanitize filename for GitHub
   */
  sanitizeFilename(filename) {
    // Convert .jfif to .jpg (GitHub doesn't recognize .jfif)
    const sanitized = filename.replace(/\.jfif$/i, '.jpg');
    
    // Remove or replace characters that might cause issues
    return sanitized
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Replace invalid chars
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .replace(/_{2,}/g, '_') // Replace multiple underscores with single
      .substring(0, 255); // Limit length
  }

  /**
   * Check if asset already exists in release
   */
  async getExistingAsset(owner, repo, releaseId, filename) {
    try {
      const resp = await this.githubClient.request({
        hostname: GITHUB_API,
        path: `/repos/${owner}/${repo}/releases/${releaseId}/assets`,
        method: "GET",
        headers: this.githubClient.buildHeaders(),
      });

      if (resp.statusCode === 200) {
        const assets = safeParseJSON(resp.body) || [];
        const existing = assets.find((a) => a.name === filename);
        if (existing) {
          console.log(`Asset ${filename} already exists: ${existing.browser_download_url}`);
          return existing.browser_download_url;
        }
      }
      return null;
    } catch (err) {
      console.warn(`Error checking existing assets: ${err.message}`);
      return null;
    }
  }

  /**
   * Upload image to GitHub release assets
   */
  async uploadToGitHub(owner, repo, filename, imageData) {
    try {
      // Sanitize filename
      const sanitizedFilename = this.sanitizeFilename(filename);
      
      // Get or create release for image storage
      let releaseId = await this.getOrCreateRelease(owner, repo);
      if (!releaseId) return null;

      // Check if asset already exists
      const existingUrl = await this.getExistingAsset(owner, repo, releaseId, sanitizedFilename);
      if (existingUrl) {
        return existingUrl;
      }

      // Upload asset
      const url = new URL(`https://${GITHUB_UPLOADS}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
      const resp = await this.githubClient.request(
        {
          hostname: url.hostname,
          path: `${url.pathname}${url.search}?name=${encodeURIComponent(sanitizedFilename)}`,
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
        const errorBody = safeParseJSON(resp.body);
        console.warn(`Failed to upload asset: ${resp.statusCode}`, errorBody?.message || '');
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
          draft: true,
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
              console.log(`Image re-hosted: ${filename} -> ${uploadedUrl}`);
            }
          }
        } catch (err) {
          console.warn(`Failed to re-host image ${filename}: ${err.message}`);
        }
      }

      // Store both original filename and sanitized version
      urlMap[filename] = publicUrl;
      const sanitized = this.sanitizeFilename(filename);
      if (sanitized !== filename) {
        urlMap[sanitized] = publicUrl;
        console.log(`Mapped both original (${filename}) and sanitized (${sanitized}) to URL`);
      }
    }

    return urlMap;
  }
}



class ConfigManager {
  constructor(env, fieldMapper = null) {
    this.env = env;
    this.fieldMapper = fieldMapper;
    this._resolvedStartDateField = null;
  }

  get github() {
    return {
      owner: this.env.GITHUB_OWNER?.trim(),
      repo: this.env.GITHUB_REPO?.trim(),
      token: this.env.GITHUB_TOKEN?.trim(),
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
      // Optional: If not provided, we will try to resolve common start date field names via JiraFieldMapper.
      startDateFieldRaw: String(this.env.START_DATE_FIELD || "").trim(),
    };
  }

  /**
   * Get resolved start date field ID (with field name resolution)
   */
  async getStartDateField() {
    if (this._resolvedStartDateField) return this._resolvedStartDateField;

    const { startDateFieldRaw } = this.jira;
    const fieldNames = startDateFieldRaw
      ? startDateFieldRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [
          "Start Date",
          "Sprint Start Date",
          "Start date",
          "Start",
        ];

    if (this.fieldMapper) {
      const resolved = await this.fieldMapper.resolveFieldNames(fieldNames);
      this._resolvedStartDateField = resolved[0] || null;
    } else {
      // Without a mapper, return null so extractStartDate falls back to built-in heuristics.
      this._resolvedStartDateField = null;
    }

    return this._resolvedStartDateField;
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
  async buildIssueBody(issue, description, attachmentUrlMap = {}) {
    const { fields } = issue;
    const statusName = fields.status?.name;
    const priority = fields.priority?.name || "Medium";
    const dueDate = fields.duedate;
    const startDateField = await this.config.getStartDateField();
    const startDate = extractStartDate(fields, startDateField);
    const assignee = fields.assignee;
    const parentIssue = fields.parent;
    const isSubtask = fields.issuetype?.subtask === true || fields.issuetype?.name === "Sub-task";
    const hasParent = !!parentIssue;

    // Replace image filenames with URLs (ensuring images are displayed, not just linked)
    let processedDescription = description;
    console.log(`Original description: ${description}`);
    console.log(`Attachment URL map:`, JSON.stringify(attachmentUrlMap));
    
    for (const [filename, url] of Object.entries(attachmentUrlMap)) {
      const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const altText = filename.replace(/\.[^.]+$/, ''); // Remove extension for alt text
      
      // Replace markdown image syntax: ![alt](filename) -> ![altText](url)
      const mdPattern = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedFilename}\\)`, "g");
      const beforeMd = processedDescription;
      processedDescription = processedDescription.replace(mdPattern, `![${altText}](${url})`);
      if (beforeMd !== processedDescription) {
        console.log(`Replaced markdown syntax for ${filename}`);
      }
      
      // Only replace plain filename if it's NOT already in markdown syntax
      // Use negative lookbehind to avoid matching filenames in ![](filename)
      const plainPattern = new RegExp(`(?<!\\]\\()\\b${escapedFilename}\\b(?!\\))`, "g");
      const beforePlain = processedDescription;
      processedDescription = processedDescription.replace(plainPattern, `![${altText}](${url})`);
      if (beforePlain !== processedDescription) {
        console.log(`Replaced plain filename ${filename}`);
      }
    }
    
    console.log(`Processed description: ${processedDescription}`);

    const jiraKey = issue.key;
    const jiraLink = this.buildJiraLink(jiraKey, issue.self);
    const assigneeInfo = this.config.resolveUser(assignee);

    const compactInline = (value) => String(value || "").replace(/\s+/g, " ").trim();

    // Exclude known/unwanted custom fields (by name or field ID)
    // Example: Jira "Rank" often has values like "0|i00173" and is not useful in GitHub.
    const excludedCustomFields = new Set(
      String(this.config.env?.EXCLUDED_CUSTOM_FIELDS || "Rank")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );

    // Extract all custom fields for display
    const customFields = [];
    const startDateFieldId = await this.config.getStartDateField();
    
    for (const [fieldId, value] of Object.entries(fields)) {
      if (!fieldId.startsWith('customfield_')) continue;
      if (!value) continue;
      
      // Skip fields already displayed in dedicated sections
      if (fieldId === startDateFieldId) continue;
      
      // Get human-readable field name
      const fieldName = this.config.fieldMapper 
        ? await this.config.fieldMapper.getFieldName(fieldId) 
        : fieldId;

      const normalizedFieldName = String(fieldName || "").trim().toLowerCase();
      if (excludedCustomFields.has(normalizedFieldName) || excludedCustomFields.has(String(fieldId).toLowerCase())) {
        continue;
      }
      
      // Extract value based on type
      let fieldValue = null;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        fieldValue = String(value);
      } else if (typeof value === 'object') {
        // Try extractText for ADF content
        const extracted = extractText(value);
        if (extracted && extracted.trim()) {
          fieldValue = extracted.trim();
        } else if (value.value !== undefined) {
          // Handle select/option fields
          fieldValue = String(value.value);
        } else if (value.name !== undefined) {
          // Handle user/name fields
          fieldValue = String(value.name);
        }
      }
      
      if (fieldValue && fieldValue.trim()) {
        console.log(`Custom field: ${fieldName} (${fieldId}) = ${fieldValue}`);
        customFields.push({ name: fieldName, value: compactInline(fieldValue) });
      }
    }

    const bodyParts = [
      `- Jira: ${jiraKey}`,
      `- Jira Link: ${jiraLink}`,
      `- Description: ${compactInline(processedDescription)}`,
    ];

    if (hasParent) {
      bodyParts.push(`- Parent: ${parentIssue.key} - ${parentIssue.fields?.summary || "Parent Issue"}`);
    }

    bodyParts.push(`- Status: ${statusName || "Not set"}`);
    bodyParts.push(`- Due Date: ${dueDate || "Not set"}`);
    if (startDate) {
      bodyParts.push(`- Start Date: ${startDate}`);
    }
    bodyParts.push(`- Priority: ${priority}`);

    // Add assignee info
    if (assigneeInfo.isMapped && assigneeInfo.usernames.length > 0) {
      bodyParts.push(`- Assignee: ${assigneeInfo.usernames.map((u) => `@${u}`).join(", ")}`);
    } else if (assignee) {
      bodyParts.push(`- Jira Assignee: ${assigneeInfo.displayName}`);
      if (assigneeInfo.email) bodyParts.push(`- Assignee Email: ${assigneeInfo.email}`);
      if (!assigneeInfo.isMapped) {
        bodyParts.push("", "Note: Jira assignee not mapped to GitHub user. Add to USER_MAP_JSON.");
      }
    }

    // Add custom fields section
    if (customFields.length > 0) {
      bodyParts.push("", "Custom Fields");
      customFields.forEach(field => {
        bodyParts.push(`- ${field.name}: ${field.value}`);
      });
    }

    return bodyParts.filter((v) => v !== undefined && v !== null).join("\n");
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
    const filtered = lines.filter(
      (l) => !/^(\-\s*)?(?:\*\*)?(Status|Due Date|Start Date|Acceptance Criteria)(?:\*\*)?:/.test(l)
    );

    return [
      ...filtered,
      "",
      `- Status: ${statusName || "Not set"}`,
      `- Due Date: ${dueDate || "Not set"}`,
      `- Start Date: ${startDate || "Not set"}`,
    ].join("\n");
  }

/**
   * Process comment and create on GitHub
   */
  async syncComment(owner, repo, issueNumber, jiraComment, issueFields = null, eventType = null) {
    const author = jiraComment.author || {};
    const created = jiraComment.created || new Date().toISOString();
    const jiraCommentId = jiraComment.id;
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
    finalBody += `\n<!-- jira-comment-id: ${jiraCommentId} -->`;

    // For comment updates, find and update existing comment
    if (eventType === "comment_updated" && jiraCommentId) {
      const comments = await this.github.listComments(owner, repo, issueNumber);
      const existing = comments.find(c => c.body?.includes(`<!-- jira-comment-id: ${jiraCommentId} -->`));
      if (existing) {
        return await this.github.updateComment(owner, repo, existing.id, finalBody);
      }
    }

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
   * Update full issue body with description and images
   */
  async updateIssueBody(owner, repo, issueNumber, issue, updateAssignee = false) {
    try {
      const { fields } = issue;
      const jiraKey = issue.key;
      const description = extractText(fields.description) || "No description";

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

      // Build new body and title
      const newBody = await this.buildIssueBody(issue, description, attachmentUrlMap);
      const newTitle = `${jiraKey}: ${fields.summary || jiraKey || "Updated Jira Item"}`;

      // Get current issue to preserve labels and state
      const current = await this.github.getIssue(owner, repo, issueNumber);
      if (!current) return false;

      const statusName = fields.status?.name;
      const existingLabels = (current.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
      const preserved = existingLabels.filter((l) => !l.toLowerCase().startsWith("status:"));
      const statusLabel = this.config.buildStatusLabel(statusName);
      const nextLabels = [...new Set([...preserved, statusLabel].filter(Boolean))];
      const desiredState = /^(done|resolved|closed)$/i.test(statusName || "") ? "closed" : "open";

      const updateData = {
        title: newTitle,
        body: newBody,
        labels: nextLabels,
        state: desiredState,
      };

      // Add assignees if updateAssignee flag is set
      if (updateAssignee) {
        const assigneeInfo = this.config.resolveUser(fields.assignee);
        const ghAssignees = [];
        for (const username of assigneeInfo.usernames) {
          if (await this.github.validateUser(username)) {
            ghAssignees.push(username);
          }
        }
        updateData.assignees = ghAssignees;
        console.log(`Updating assignees: ${ghAssignees.join(", ") || "none"}`);
      }

      await this.github.updateIssue(owner, repo, issueNumber, updateData);

      console.log(`Updated issue #${issueNumber} title and body`);
      return true;
    } catch (err) {
      console.warn("Failed to update issue body:", err.message);
      return false;
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
    
    // Final duplicate check right before creating (prevents race conditions)
    const existingCheck = await this.github.findIssue(owner, repo, jiraKey);
    if (existingCheck?.number) {
      console.log(`Issue already exists (race condition detected): #${existingCheck.number} for ${jiraKey}`);
      return existingCheck;
    }
    
    const title = `${jiraKey}: ${fields.summary || jiraKey || "New Jira Item"}`;
    const labels = fields.labels || [];
    const statusName = fields.status?.name;

    // Extract and process description
    const description = extractText(fields.description) || "No description";

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

    // Ensure all labels exist in the repository before creating the issue
    console.log(`Ensuring labels exist: ${ghLabels.join(", ")}`);
    const validLabels = await this.github.ensureLabels(owner, repo, ghLabels);
    console.log(`Valid labels to apply: ${validLabels.join(", ")}`);

    // Build issue body
    const body = await this.buildIssueBody(issue, description, attachmentUrlMap);

    // Create issue
    const issueData = {
      title,
      body,
      labels: validLabels,
      assignees: ghAssignees,
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
    console.log("Using HMAC SHA-256 validation");
    const parts = String(sigHeader).split("=");
    const provided = parts.length === 2 ? parts[1] : parts[0];
    const computed = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    return timingSafeEqualStr(provided, computed);
  }

  // Fallback: plain-text comparison
  console.log("Using plain-text secret validation");
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

    // Initialize Jira field mapper
    const jiraBaseUrl = process.env.JIRA_BASE_URL;
    const jiraEmail = process.env.JIRA_EMAIL?.trim();
    const jiraToken = process.env.JIRA_API_TOKEN?.trim();
    const fieldMapper = new JiraFieldMapper(jiraBaseUrl, jiraEmail, jiraToken);
    
    // Pre-fetch field mappings (async, don't await - will be cached for use later)
    fieldMapper.fetchFieldMap().catch(err => 
      console.warn('Background field map fetch failed:', err.message)
    );

    // Initialize configuration
    const config = new ConfigManager(process.env, fieldMapper);

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
    const changelog = jiraPayload.changelog || {};

    console.log(`Processing: ${eventType} for ${jiraKey}`);
    
    // Log changelog for debugging
    if (changelog.items) {
      console.log(`Changelog items:`, JSON.stringify(changelog.items, null, 2));
      const changes = changelog.items.map(item => item.field);
      console.log(`Changelog fields: ${changes.join(", ")}`);
    }
    
    // Skip if this is only a parent link update (not a real issue update)
    if (["jira:issue_updated", "issue_updated"].includes(eventType) && changelog.items) {
      const changes = changelog.items.map(item => item.field);
      const isOnlyParentUpdate = changes.length === 1 && changes.includes("Parent");
      if (isOnlyParentUpdate) {
        console.log(`Skipping parent-only update for ${jiraKey}`);
        return { statusCode: 200, body: JSON.stringify({ message: "Parent-only update skipped" }) };
      }
    }

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
      const success = await issueSync.syncComment(owner, repo, ghIssue.number, comment, fields, eventType);
      
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

    // Skip Epic type issues - we don't create GitHub issues for Epics
    if (issueType === "Epic") {
      console.info(`Skipping Epic issue: ${jiraKey}`);
      return { statusCode: 200, body: JSON.stringify({ message: "Epic issues are not synced" }) };
    }

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
      console.log(`Issue #${existingIssue.number} already exists for ${jiraKey}`);
      
      // For create events, if issue already exists, just return success (prevent duplicates)
      if (["jira:issue_created", "issue_created"].includes(eventType)) {
        console.log(`Issue already exists, skipping duplicate creation for ${jiraKey}`);
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Issue already exists; skipped duplicate creation",
            issueNumber: existingIssue.number,
            jiraKey,
          }),
        };
      }
      
      // Check if this is an update event (description/attachment change)
      const isUpdateEvent = ["jira:issue_updated", "issue_updated"].includes(eventType);
      
      if (isUpdateEvent) {
        console.log(`Processing issue update for #${existingIssue.number}`);
        
        // Check if assignee was changed
        const assigneeChanged = changelog.items?.some(item => item.field === "assignee") || false;
        
        const updated = await issueSync.updateIssueBody(owner, repo, existingIssue.number, issue, assigneeChanged);
        
        return {
          statusCode: updated ? 200 : 500,
          body: JSON.stringify({
            message: updated ? "Issue body updated" : "Failed to update issue",
            issueNumber: existingIssue.number,
            jiraKey,
          }),
        };
      } else {
        // Just sync status for other events (status changes, etc.)
        console.log(`Syncing status only for #${existingIssue.number}`);
        const statusLabel = config.buildStatusLabel(statusName);
        const startDateField = await config.getStartDateField();
        const startDate = extractStartDate(fields, startDateField);
        const dueDate = fields.duedate;

        await issueSync.updateIssueStatus(owner, repo, existingIssue.number, statusLabel, statusName, startDate, dueDate);

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Issue status synced",
            issueNumber: existingIssue.number,
            jiraKey,
          }),
        };
      }
    }

    // If this is an update event but no existing GitHub issue found
    const isUpdateEvent = ["jira:issue_updated", "issue_updated"].includes(eventType);
    const isCreateEvent = ["jira:issue_created", "issue_created"].includes(eventType);
    
    if (isUpdateEvent) {
      // Check if this is a meaningful update that should create an issue
      // (e.g., adding trigger label to an existing Jira issue)
      let hasJustAddedLabel = false;
      
      if (changelog.items) {
        for (const item of changelog.items) {
          if (item.field === "labels") {
            // Check if any trigger label was added (in the 'toString' field)
            const addedLabels = item.toString ? String(item.toString).split(" ") : [];
            hasJustAddedLabel = addedLabels.some(label => 
              config.jira.triggerLabels.includes(label.trim())
            );
            
            if (hasJustAddedLabel) {
              console.log(`Trigger label detected in changelog: ${item.toString}`);
              break;
            }
          }
        }
      }
      
      // Also check current labels as fallback
      if (!hasJustAddedLabel && config.hasTriggerLabel(labels)) {
        console.log(`Trigger label found in current labels, creating issue`);
        hasJustAddedLabel = true;
      }
      
      if (!hasJustAddedLabel) {
        // Update event with no existing GitHub issue and no label addition - skip
        console.log(`Update event for ${jiraKey} but no existing GitHub issue found and no trigger label - skipping`);
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Update event with no existing issue - skipped",
            jiraKey,
          }),
        };
      } else {
        console.log(`Trigger label present on ${jiraKey}, will create GitHub issue`);
      }
    }

    // Create new issue (for create events or update events with trigger label addition)
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