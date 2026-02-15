const cp = require("child_process");
const https = require("https");
const path = require("path");
const vscode = require("vscode");

const CONFIG_ROOT = "shissues";
const SECRET_PAT_KEY = "githubPat";
const AUTH_VSCODE = "vscode";
const AUTH_PAT = "pat";
const DEFAULT_IMAGE_MAX_MB = 10;
const IMAGE_MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg"
};

const MENU_COMMANDS = {
  LIST_ISSUES: "shissues.listIssues",
  SEARCH_ISSUES: "shissues.searchIssues",
  CREATE_ISSUE: "shissues.createIssue",
  ASSIGN_ISSUE: "shissues.assignIssue",
  CREATE_PR: "shissues.createPullRequest",
  INIT: "shissues.init",
  AUTH_MODE: "shissues.setAuthMode",
  SET_PAT: "shissues.setPat",
  PERMS: "shissues.showPermissions"
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "shissues.menu";
  context.subscriptions.push(statusBar);

  const refreshStatus = () => updateStatusBarText(statusBar).catch(() => undefined);
  const issuesProvider = new IssuesWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("shissues.issuesView", issuesProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("shissues.menu", () => runGuarded(() => showMenu(context))),
    vscode.commands.registerCommand("shissues.init", () => runGuarded(() => initRepo(context))),
    vscode.commands.registerCommand("shissues.setAuthMode", () => runGuarded(() => setAuthMode())),
    vscode.commands.registerCommand("shissues.setPat", () => runGuarded(() => setPat(context))),
    vscode.commands.registerCommand("shissues.showPermissions", () => runGuarded(() => showPermissionsDoc())),
    vscode.commands.registerCommand("shissues.listIssues", () => runGuarded(() => listIssues(context, issuesProvider))),
    vscode.commands.registerCommand("shissues.searchIssues", () => runGuarded(() => searchIssues(context, issuesProvider))),
    vscode.commands.registerCommand("shissues.refreshIssuesView", () =>
      runGuarded(() => issuesProvider.refresh())
    ),
    vscode.commands.registerCommand("shissues.setIssueFilter", () =>
      runGuarded(() => setIssueFilter(context, issuesProvider))
    ),
    vscode.commands.registerCommand("shissues.clearSearch", () =>
      runGuarded(() => clearIssueSearch(context, issuesProvider))
    ),
    vscode.commands.registerCommand("shissues.createIssue", () => runGuarded(() => createIssue(context))),
    vscode.commands.registerCommand("shissues.assignIssue", () => runGuarded(() => assignIssue(context))),
    vscode.commands.registerCommand("shissues.createPullRequest", () => runGuarded(() => createPullRequest(context))),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIG_ROOT}.repo`) ||
        event.affectsConfiguration(`${CONFIG_ROOT}.authMode`)
      ) {
        refreshStatus();
      }
    })
  );

  refreshStatus();
}

function deactivate() {}

/**
 * @param {() => Promise<void>} fn
 */
async function runGuarded(fn) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Shissues: ${message}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function showMenu(context) {
  const repo = await getActiveRepo();
  const repoLabel = repo ? `(${repo})` : "(no repo selected)";
  const pick = await vscode.window.showQuickPick(
    [
      { label: "List Issues", description: repoLabel, command: MENU_COMMANDS.LIST_ISSUES },
      { label: "Search Issues", description: repoLabel, command: MENU_COMMANDS.SEARCH_ISSUES },
      { label: "Create Issue", description: repoLabel, command: MENU_COMMANDS.CREATE_ISSUE },
      { label: "Assign Issue", description: repoLabel, command: MENU_COMMANDS.ASSIGN_ISSUE },
      { label: "Create Pull Request", description: repoLabel, command: MENU_COMMANDS.CREATE_PR },
      { label: "Init / Change Repo", command: MENU_COMMANDS.INIT },
      { label: "Set Auth Mode", command: MENU_COMMANDS.AUTH_MODE },
      { label: "Set GitHub PAT", command: MENU_COMMANDS.SET_PAT },
      { label: "Show Required Permissions", command: MENU_COMMANDS.PERMS }
    ],
    { placeHolder: "Shissues actions" }
  );
  if (pick) {
    await vscode.commands.executeCommand(pick.command);
  }
}

async function updateStatusBarText(statusBar) {
  const repo = await getActiveRepo();
  statusBar.text = repo ? `$(issues) Shissues: ${repo}` : "$(issues) Shissues: no repo";
  statusBar.tooltip = repo
    ? `Active repository: ${repo}\nClick to open Shissues menu`
    : "No active repository. Click to initialize Shissues.";
  statusBar.show();
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function initRepo(context) {
  const configured = getConfig().get("repo", "").trim();
  const detected = await detectRepoFromWorkspaceRemote();
  const picks = [];

  if (detected) {
    picks.push({
      label: `Use detected origin: ${detected}`,
      description: "Recommended",
      action: "useDetected"
    });
  }

  if (configured) {
    picks.push({
      label: `Keep configured repo: ${configured}`,
      action: "keepCurrent"
    });
  }

  picks.push({ label: "Enter repo manually (owner/repo)", action: "manual" });
  const choice = await vscode.window.showQuickPick(picks, {
    placeHolder: "Select target repository"
  });
  if (!choice) {
    return;
  }

  let targetRepo = configured;
  if (choice.action === "useDetected") {
    targetRepo = detected;
  } else if (choice.action === "manual") {
    const manual = await promptForRepo();
    if (!manual) {
      return;
    }
    targetRepo = manual;
  }

  if (!targetRepo) {
    throw new Error("No repository selected.");
  }

  await setConfigValue("repo", targetRepo);
  vscode.window.showInformationMessage(`Shissues repo set to ${targetRepo}`);

  if (!configured) {
    const setupAuth = await vscode.window.showInformationMessage(
      "Configure auth now?",
      "Yes",
      "Later"
    );
    if (setupAuth === "Yes") {
      await setAuthMode();
      const mode = getConfig().get("authMode", AUTH_VSCODE);
      if (mode === AUTH_PAT) {
        await setPat(context);
      }
    }
  }
}

async function promptForRepo() {
  const repo = await vscode.window.showInputBox({
    title: "Shissues repository",
    prompt: "Enter repository as owner/repo",
    placeHolder: "owner/repo",
    validateInput: (value) => {
      if (!value.trim()) {
        return "Repository is required.";
      }
      if (!isValidOwnerRepo(value.trim())) {
        return "Use owner/repo format (GitHub).";
      }
      return null;
    }
  });
  return repo ? repo.trim() : undefined;
}

function isValidOwnerRepo(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

async function setAuthMode() {
  const current = getConfig().get("authMode", AUTH_VSCODE);
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "VS Code GitHub session",
        description: current === AUTH_VSCODE ? "Current" : "",
        value: AUTH_VSCODE
      },
      { label: "Personal Access Token", description: current === AUTH_PAT ? "Current" : "", value: AUTH_PAT }
    ],
    { placeHolder: "Select auth mode" }
  );
  if (!pick) {
    return;
  }
  await setConfigValue("authMode", pick.value);
  vscode.window.showInformationMessage(`Shissues auth mode: ${pick.value}`);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function setPat(context) {
  const pat = await vscode.window.showInputBox({
    title: "Shissues GitHub PAT",
    prompt: "Paste a GitHub Personal Access Token",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "PAT cannot be empty")
  });
  if (!pat) {
    return;
  }
  await context.secrets.store(SECRET_PAT_KEY, pat.trim());
  vscode.window.showInformationMessage("Shissues PAT saved to VS Code SecretStorage.");
}

async function showPermissionsDoc() {
  const content = [
    "# Shissues: Required GitHub Permissions",
    "",
    "## If using VS Code GitHub auth provider",
    "- OAuth scope: `repo` (works for private + public repositories).",
    "- For public-only workflows, `public_repo` can be used instead.",
    "",
    "## If using a Fine-grained PAT",
    "Repository permissions:",
    "- Issues: **Read and write** (create/assign + list issues/labels).",
    "- Pull requests: **Read and write** (create pull requests).",
    "- Contents: **Read and write** (store uploaded issue images in repo).",
    "- Metadata: **Read-only** (usually implicit).",
    "",
    "## If using a Classic PAT",
    "- `repo` for private repositories.",
    "- `public_repo` for public repositories only.",
    "",
    "Note: GitHub still enforces repo-level role permissions. The token scope alone does not bypass missing repo rights."
  ].join("\n");

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {IssuesTreeProvider} issuesProvider
 */
async function listIssues(context, issuesProvider) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  const statePick = await vscode.window.showQuickPick(
    [
      { label: "Open", value: "open" },
      { label: "Closed", value: "closed" },
      { label: "All", value: "all" }
    ],
    { placeHolder: "Which issues do you want to list?" }
  );
  if (!statePick) {
    return;
  }

  await setIssueFilterState(context, statePick.value);
  await clearIssueSearchState(context);
  issuesProvider.refresh();

  const realIssues = await fetchIssues(repo, token, {
    filter: statePick.value,
    search: ""
  });
  if (!realIssues.length) {
    vscode.window.showInformationMessage(`No ${statePick.value} issues found.`);
    return;
  }

  const selected = await pickIssueFromCollection(realIssues, `Select ${statePick.value} issue`);
  if (!selected) {
    return;
  }
  await showIssueActions(selected);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {IssuesTreeProvider} issuesProvider
 */
async function searchIssues(context, issuesProvider) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  const query = await vscode.window.showInputBox({
    title: "Search issues",
    prompt: "Enter search text or qualifiers (for example: bug is:open label:frontend)",
    validateInput: (value) => (value.trim() ? null : "Search query is required.")
  });
  if (!query) {
    return;
  }

  await setIssueSearchState(context, query.trim());
  issuesProvider.refresh();

  const matches = await fetchIssues(repo, token, {
    filter: getIssueFilter(context),
    search: query.trim()
  });
  if (!matches.length) {
    vscode.window.showInformationMessage("No issues matched your query.");
    return;
  }

  const selected = await pickIssueFromCollection(matches, "Select search result");
  if (!selected) {
    return;
  }
  await showIssueActions(selected);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {IssuesTreeProvider} issuesProvider
 */
async function setIssueFilter(context, issuesProvider) {
  const current = getIssueFilter(context);
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Open", value: "open", description: current === "open" ? "Current" : "" },
      { label: "Closed", value: "closed", description: current === "closed" ? "Current" : "" },
      { label: "All", value: "all", description: current === "all" ? "Current" : "" }
    ],
    { placeHolder: "Issue filter for sidebar" }
  );
  if (!pick) {
    return;
  }
  await setIssueFilterState(context, pick.value);
  await clearIssueSearchState(context);
  issuesProvider.refresh();
  vscode.window.showInformationMessage(`Issue filter set to ${pick.value}.`);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {IssuesTreeProvider} issuesProvider
 */
async function clearIssueSearch(context, issuesProvider) {
  await clearIssueSearchState(context);
  issuesProvider.refresh();
  vscode.window.showInformationMessage("Issue search cleared.");
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function createIssue(context) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);

  const title = await vscode.window.showInputBox({
    title: "Create GitHub Issue",
    prompt: "Issue title",
    validateInput: (value) => (value.trim() ? null : "Title is required.")
  });
  if (!title) {
    return;
  }

  const body = await vscode.window.showInputBox({
    title: "Issue body",
    prompt: "Markdown body (optional)"
  });

  const labels = await maybePickLabels(repo, token);
  const assignees = await maybePickAssignees(repo, token);

  const created = await githubRequest(token, "POST", `/repos/${repo}/issues`, {
    title: title.trim(),
    body: body || "",
    labels,
    assignees
  });

  const openLabel = "Open in browser";
  const answer = await vscode.window.showInformationMessage(
    `Created issue #${created.number}: ${created.title}`,
    openLabel
  );
  if (answer === openLabel && created.html_url) {
    await vscode.env.openExternal(vscode.Uri.parse(created.html_url));
  }
}

async function createIssueInline(context, payload) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  const title = (payload.title || "").trim();
  if (!title) {
    throw new Error("Issue title is required.");
  }

  const body = payload.body || "";
  const labels = normalizeList(payload.labels);
  const assignees = normalizeList(payload.assignees);

  await githubRequest(token, "POST", `/repos/${repo}/issues`, {
    title,
    body,
    labels,
    assignees
  });
  vscode.window.showInformationMessage(`Created issue: ${title}`);
}

async function updateIssueInline(context, payload) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  if (!payload.number) {
    throw new Error("Issue number is required.");
  }

  const title = (payload.title || "").trim();
  if (!title) {
    throw new Error("Issue title is required.");
  }

  const body = payload.body || "";
  const labels = normalizeList(payload.labels);
  const assignees = normalizeList(payload.assignees);

  await githubRequest(token, "PATCH", `/repos/${repo}/issues/${payload.number}`, {
    title,
    body,
    labels,
    assignees
  });
  vscode.window.showInformationMessage(`Updated issue #${payload.number}`);
}

async function setIssueState(context, number, state) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  await githubRequest(token, "PATCH", `/repos/${repo}/issues/${number}`, {
    state
  });
  vscode.window.showInformationMessage(`Issue #${number} set to ${state}.`);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function assignIssue(context) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);

  const issue = await pickOpenIssue(repo, token);
  if (!issue) {
    return;
  }

  const assignees = await maybePickAssignees(repo, token);
  if (!assignees.length) {
    vscode.window.showInformationMessage("No assignees selected. Nothing changed.");
    return;
  }

  await githubRequest(token, "POST", `/repos/${repo}/issues/${issue.number}/assignees`, {
    assignees
  });

  vscode.window.showInformationMessage(
    `Assigned #${issue.number} to ${assignees.join(", ")}`
  );
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function createPullRequest(context) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);

  const title = await vscode.window.showInputBox({
    title: "Create Pull Request",
    prompt: "PR title",
    validateInput: (value) => (value.trim() ? null : "Title is required.")
  });
  if (!title) {
    return;
  }

  const defaultBase = getConfig().get("defaultBaseBranch", "main");
  const base = await vscode.window.showInputBox({
    title: "Base branch",
    prompt: "Base branch (target)",
    value: defaultBase,
    validateInput: (value) => (value.trim() ? null : "Base branch is required.")
  });
  if (!base) {
    return;
  }

  const head = await vscode.window.showInputBox({
    title: "Head branch",
    prompt: "Head branch (source) or owner:branch",
    validateInput: (value) => (value.trim() ? null : "Head branch is required.")
  });
  if (!head) {
    return;
  }

  const body = await vscode.window.showInputBox({
    title: "PR body",
    prompt: "Markdown body (optional)"
  });

  const draftPick = await vscode.window.showQuickPick(
    [
      { label: "No", value: false },
      { label: "Yes", value: true }
    ],
    { placeHolder: "Create as draft?" }
  );
  if (!draftPick) {
    return;
  }

  const created = await githubRequest(token, "POST", `/repos/${repo}/pulls`, {
    title: title.trim(),
    head: head.trim(),
    base: base.trim(),
    body: body || "",
    draft: draftPick.value
  });

  const openLabel = "Open in browser";
  const answer = await vscode.window.showInformationMessage(
    `Created PR #${created.number}: ${created.title}`,
    openLabel
  );
  if (answer === openLabel && created.html_url) {
    await vscode.env.openExternal(vscode.Uri.parse(created.html_url));
  }
}

async function maybePickLabels(repo, token) {
  let labels = [];
  try {
    const availableLabels = await githubRequest(token, "GET", `/repos/${repo}/labels?per_page=100`);
    if (Array.isArray(availableLabels) && availableLabels.length) {
      const pick = await vscode.window.showQuickPick(
        availableLabels.map((label) => ({ label: label.name })),
        { canPickMany: true, title: "Select labels (optional)" }
      );
      labels = pick ? pick.map((item) => item.label) : [];
    }
  } catch {
    const manual = await vscode.window.showInputBox({
      title: "Labels (optional)",
      prompt: "Comma-separated labels"
    });
    if (manual) {
      labels = manual
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return labels;
}

async function maybePickAssignees(repo, token) {
  try {
    const assignees = await githubRequest(token, "GET", `/repos/${repo}/assignees?per_page=100`);
    if (!Array.isArray(assignees) || assignees.length === 0) {
      return [];
    }
    const pick = await vscode.window.showQuickPick(
      assignees.map((user) => ({ label: user.login })),
      { canPickMany: true, title: "Select assignees (optional)" }
    );
    return pick ? pick.map((item) => item.label) : [];
  } catch {
    return [];
  }
}

async function pickOpenIssue(repo, token) {
  const issues = await githubRequest(
    token,
    "GET",
    `/repos/${repo}/issues?state=open&per_page=100`
  );
  const realIssues = Array.isArray(issues)
    ? issues.filter((item) => !item.pull_request)
    : [];
  if (!realIssues.length) {
    vscode.window.showInformationMessage("No open issues found.");
    return undefined;
  }

  return pickIssueFromCollection(realIssues, "Select issue to assign");
}

async function fetchIssues(repo, token, { filter, search }) {
  if (search) {
    const filterQualifier = filter === "open" ? " is:open" : filter === "closed" ? " is:closed" : "";
    const encoded = encodeURIComponent(`${search} repo:${repo} is:issue${filterQualifier}`);
    const response = await githubRequest(
      token,
      "GET",
      `/search/issues?q=${encoded}&per_page=50&sort=updated&order=desc`
    );
    return Array.isArray(response.items) ? response.items : [];
  }

  const issues = await githubRequest(
    token,
    "GET",
    `/repos/${repo}/issues?state=${filter}&per_page=100&sort=updated&direction=desc`
  );
  const realIssues = Array.isArray(issues) ? issues.filter((item) => !item.pull_request) : [];
  return realIssues;
}

async function fetchLabels(repo, token) {
  const labels = await githubRequest(token, "GET", `/repos/${repo}/labels?per_page=100`);
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => label.name)
    .filter(Boolean);
}

async function fetchAssignees(repo, token) {
  const assignees = await githubRequest(token, "GET", `/repos/${repo}/assignees?per_page=100`);
  if (!Array.isArray(assignees)) {
    return [];
  }
  return assignees
    .map((user) => user.login)
    .filter(Boolean);
}

async function pickIssueFromCollection(issues, placeHolder) {
  const pick = await vscode.window.showQuickPick(
    issues.map((issue) => ({
      label: `#${issue.number} ${issue.title}`,
      description: issue.user ? `@${issue.user.login}` : "",
      detail: `updated ${formatUpdatedAt(issue.updated_at)} | ${issue.state}`,
      issue
    })),
    { placeHolder }
  );
  return pick ? pick.issue : undefined;
}

async function showIssueActions(issue) {
  const action = await vscode.window.showQuickPick(
    [
      { label: "Open in browser", value: "browser" },
      { label: "Open markdown summary", value: "summary" },
      { label: "Copy issue URL", value: "copy" }
    ],
    { placeHolder: `Issue #${issue.number}` }
  );
  if (!action) {
    return;
  }

  if (action.value === "browser") {
    if (issue.html_url) {
      await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
    }
    return;
  }

  if (action.value === "copy") {
    if (issue.html_url) {
      await vscode.env.clipboard.writeText(issue.html_url);
      vscode.window.showInformationMessage(`Copied ${issue.html_url}`);
    }
    return;
  }

  await openIssueSummary(issue);
}

async function openIssueSummary(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(Boolean)
    : [];
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((assignee) => assignee.login).filter(Boolean)
    : [];
  const content = [
    `# #${issue.number} ${issue.title}`,
    "",
    `- State: ${issue.state || "unknown"}`,
    `- Author: ${issue.user ? `@${issue.user.login}` : "unknown"}`,
    `- Updated: ${issue.updated_at || "unknown"}`,
    `- Labels: ${labels.length ? labels.join(", ") : "none"}`,
    `- Assignees: ${assignees.length ? assignees.join(", ") : "none"}`,
    `- URL: ${issue.html_url || "n/a"}`,
    "",
    "---",
    "",
    issue.body || "_No description provided._"
  ].join("\n");

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function formatUpdatedAt(value) {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return date.toLocaleString();
}

function toIssueViewModel(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(Boolean)
    : [];
  return {
    number: issue.number,
    title: issue.title || "",
    state: issue.state || "unknown",
    user: issue.user ? issue.user.login : "",
    updatedAt: issue.updated_at ? formatUpdatedAt(issue.updated_at) : "unknown",
    labels,
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((assignee) => assignee.login).filter(Boolean)
      : [],
    htmlUrl: issue.html_url || ""
  };
}

function toIssueEditorModel(issue) {
  return {
    number: issue.number,
    title: issue.title || "",
    body: issue.body || "",
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => (typeof label === "string" ? label : label.name))
          .filter(Boolean)
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((assignee) => assignee.login).filter(Boolean)
      : []
  };
}

class IssuesWebviewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.issueCache = new Map();
    this.meta = {
      repo: "",
      labels: [],
      assignees: [],
      fetchedAt: 0
    };
  }

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.refresh();
  }

  async handleMessage(message) {
    try {
      switch (message.type) {
        case "ready":
          await this.refresh();
          return;
        case "search":
          await setIssueSearchState(this.context, (message.value || "").trim());
          await this.refresh();
          return;
        case "clearSearch":
          await clearIssueSearchState(this.context);
          await this.refresh();
          return;
        case "setFilter":
          if (message.value) {
            await setIssueFilterState(this.context, message.value);
          }
          await this.refresh();
          return;
        case "refresh":
          await this.refresh();
          return;
        case "createIssue": {
          const payload = getMessagePayload(message);
          await createIssueInline(this.context, payload);
          this.postMessage("issueSaved", { mode: "create" });
          await this.refresh();
          return;
        }
        case "updateIssue": {
          const payload = getMessagePayload(message);
          await updateIssueInline(this.context, payload);
          this.postMessage("issueSaved", { mode: "update" });
          await this.refresh();
          return;
        }
        case "setIssueState": {
          const payload = getMessagePayload(message);
          if (payload.number && payload.state) {
            await setIssueState(this.context, payload.number, payload.state);
            await this.refresh();
          }
          return;
        }
        case "requestMeta": {
          const meta = await this.ensureRepoMeta();
          if (meta) {
            this.postMessage("meta", meta);
          }
          return;
        }
        case "loadIssueForEdit": {
          const payload = getMessagePayload(message);
          if (payload.number) {
            const issue = await this.loadIssueForEdit(payload.number);
            if (issue) {
              const meta = await this.ensureRepoMeta();
              this.postMessage("editData", {
                issue: toIssueEditorModel(issue),
                meta
              });
            }
          }
          return;
        }
        case "openIssue":
          if (message.url) {
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          return;
        case "copyIssue":
          if (message.url) {
            await vscode.env.clipboard.writeText(message.url);
            vscode.window.showInformationMessage(`Copied ${message.url}`);
          }
          return;
        case "summaryIssue":
          if (message.number) {
            await this.openIssueSummaryByNumber(message.number);
          }
          return;
        case "initRepo":
          await initRepo(this.context);
          await this.refresh();
          return;
        case "setAuthMode":
          await setAuthMode();
          await this.refresh();
          return;
        case "setPat":
          await setPat(this.context);
          await this.refresh();
          return;
        case "setRepo": {
          const payload = getMessagePayload(message);
          await handleRepoSelection(this.context, payload);
          await this.refresh();
          return;
        }
        case "uploadImage": {
          const payload = getMessagePayload(message);
          try {
            const uploaded = await uploadIssueImage(this.context, payload);
            this.postMessage("imageUploaded", {
              requestId: payload.requestId,
              ...uploaded
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Shissues: ${messageText}`);
            this.postMessage("imageUploadError", {
              requestId: payload.requestId,
              message: messageText
            });
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Shissues: ${messageText}`);
      this.postMessage("error", { message: messageText });
    }
  }

  async refresh() {
    if (!this.view) {
      return;
    }
    try {
      const repo = await getActiveRepo();
      const repoCandidates = await getWorkspaceRepoCandidates();
      if (!repo) {
        this.postState({
          status: "noRepo",
          repo: "",
          repoCandidates,
          filter: getIssueFilter(this.context),
          search: getIssueSearch(this.context),
          issues: []
        });
        return;
      }

      let token = "";
      try {
        token = await getAuthToken(this.context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.postState({
          status: "noAuth",
          repo,
          repoCandidates,
          filter: getIssueFilter(this.context),
          search: getIssueSearch(this.context),
          issues: [],
          error: message
        });
        return;
      }

      const filter = getIssueFilter(this.context);
      const search = getIssueSearch(this.context);
      try {
        const issues = await fetchIssues(repo, token, { filter, search });
        this.issueCache = new Map(issues.map((issue) => [issue.number, issue]));
        this.postState({
          status: "ok",
          repo,
          repoCandidates,
          filter,
          search,
          issues: issues.map((issue) => toIssueViewModel(issue))
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.postState({
          status: "error",
          repo,
          repoCandidates,
          filter,
          search,
          issues: [],
          error: message
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postState({
        status: "error",
        repo: "",
        repoCandidates: [],
        filter: getIssueFilter(this.context),
        search: getIssueSearch(this.context),
        issues: [],
        error: message
      });
    }
  }

  postState(payload) {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "render", payload });
  }

  postMessage(type, payload) {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type, payload });
  }

  async openIssueSummaryByNumber(number) {
    const repo = await getActiveRepo();
    if (!repo) {
      return;
    }
    const token = await getAuthToken(this.context);
    const cached = this.issueCache.get(number);
    if (cached && cached.body !== undefined) {
      await openIssueSummary(cached);
      return;
    }
    const issue = await githubRequest(token, "GET", `/repos/${repo}/issues/${number}`);
    await openIssueSummary(issue);
  }

  async loadIssueForEdit(number) {
    const repo = await getActiveRepo();
    if (!repo) {
      return undefined;
    }
    const token = await getAuthToken(this.context);
    const cached = this.issueCache.get(number);
    if (cached && cached.body !== undefined) {
      return cached;
    }
    const issue = await githubRequest(token, "GET", `/repos/${repo}/issues/${number}`);
    this.issueCache.set(issue.number, issue);
    return issue;
  }

  async ensureRepoMeta() {
    const repo = await getActiveRepo();
    if (!repo) {
      return undefined;
    }
    const token = await getAuthToken(this.context);
    const now = Date.now();
    if (this.meta.repo === repo && now - this.meta.fetchedAt < 5 * 60 * 1000) {
      return this.meta;
    }

    const [labels, assignees] = await Promise.all([
      fetchLabels(repo, token),
      fetchAssignees(repo, token)
    ]);
    this.meta = {
      repo,
      labels,
      assignees,
      fetchedAt: now
    };
    return this.meta;
  }

  getHtml(webview) {
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`
    ].join("; ");
    const imageMaxMb = getImageMaxSizeMB();
    const imageMaxBytes = Math.round(imageMaxMb * 1024 * 1024);
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shissues</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        padding: 12px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-sideBar-foreground);
        background: var(--vscode-sideBar-background);
        box-sizing: border-box;
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
      }
      .repo-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .repo-select {
        max-width: 220px;
        padding: 4px 6px;
        border-radius: 4px;
        border: 1px solid var(--vscode-dropdown-border, transparent);
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        font-size: 11px;
        display: none;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .toolbar-right {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      input[type="text"] {
        width: 100%;
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        box-sizing: border-box;
        font-family: var(--vscode-font-family);
        font-size: 12px;
      }
      .search-input {
        flex: 1 1 220px;
        min-width: 140px;
        width: auto;
      }
      textarea {
        width: 100%;
        min-height: 90px;
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        resize: vertical;
        box-sizing: border-box;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        line-height: 1.4;
      }
      select {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-dropdown-border, transparent);
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
      }
      button {
        padding: 6px 10px;
        border-radius: 4px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: transparent;
        color: var(--vscode-button-foreground);
        border: 1px solid var(--vscode-button-background);
      }
      button.ghost {
        background: transparent;
        color: var(--vscode-descriptionForeground);
        border: 1px solid transparent;
      }
      .icon-button {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        line-height: 1;
      }
      .icon-button svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }
      .icon-button.spinning svg {
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .status {
        font-size: 12px;
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
      }
      .editor {
        border: 1px solid var(--vscode-sideBar-border, transparent);
        background: var(--vscode-editorWidget-background);
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 12px;
        display: none;
        gap: 8px;
        flex-direction: column;
        width: 100%;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .field input,
      .field textarea,
      .field .dropdown {
        width: 100%;
      }
      .field input[type="text"] {
        height: 30px;
        line-height: 1.2;
      }
      .image-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .image-input {
        display: none;
      }
      .image-status {
        min-height: 16px;
      }
      .dropdown {
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 4px;
        padding: 6px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        width: 100%;
      }
      .dropdown summary {
        cursor: pointer;
        list-style: none;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dropdown summary::-webkit-details-marker {
        display: none;
      }
      .dropdown-list {
        margin-top: 8px;
        max-height: 140px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 6px;
        border-top: 1px solid var(--vscode-sideBar-border, transparent);
      }
      .checkbox-item {
        display: grid;
        grid-template-columns: 16px 1fr;
        align-items: center;
        column-gap: 8px;
        font-size: 12px;
      }
      .checkbox-item input {
        margin: 0;
      }
      .muted {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .editor.visible {
        display: flex;
      }
      .editor-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
      .editor-buttons {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .issue {
        padding: 10px;
        border-radius: 6px;
        border: 1px solid var(--vscode-sideBar-border, transparent);
        background: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.08));
      }
      .issue-title {
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 4px;
        color: var(--vscode-sideBar-foreground);
      }
      .issue-meta {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
      }
      .labels {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
        margin-bottom: 6px;
      }
      .label {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .issue-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .empty {
        padding: 12px;
        border-radius: 6px;
        border: 1px dashed var(--vscode-sideBar-border, transparent);
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body data-image-max-mb="${imageMaxMb}" data-image-max-bytes="${imageMaxBytes}">
    <div class="header">
      <div class="repo-row">
        <div id="repoLabel">Repo: —</div>
        <select id="repoSelect" class="repo-select"></select>
      </div>
      <div id="summaryLabel"></div>
    </div>
    <div class="toolbar">
      <button id="refreshButton" class="icon-button secondary" title="Refresh">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4a8 8 0 0 1 7.53 5H18a1 1 0 1 0 0 2h4a1 1 0 0 0 1-1V6a1 1 0 1 0-2 0v2.2A10 10 0 1 0 22 12a1 1 0 1 0-2 0 8 8 0 1 1-8-8z"/>
        </svg>
      </button>
      <input id="searchInput" class="search-input" type="text" placeholder="Search issues..." />
      <button id="searchButton">Search</button>
      <button id="clearButton" class="ghost">Clear</button>
      <div class="toolbar-right">
        <select id="filterSelect">
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <button id="newIssueButton" class="icon-button" title="New Issue" aria-label="New Issue">+</button>
      </div>
    </div>
    <div class="editor" id="editor">
      <div class="editor-header">
        <div id="editorTitle">New Issue</div>
        <button id="editorClose" class="ghost">Hide</button>
      </div>
      <div class="field">
        <label for="issueTitle">Title</label>
        <input id="issueTitle" type="text" placeholder="Issue title" />
      </div>
      <div class="field">
        <label for="issueBody">Body</label>
        <textarea id="issueBody" placeholder="Markdown description"></textarea>
      </div>
      <div class="field">
        <div class="image-toolbar">
          <button id="attachImageButton" class="secondary" type="button">Attach image</button>
          <div class="muted" id="imageHelp"></div>
        </div>
        <input id="imageInput" class="image-input" type="file" accept="image/*" multiple />
        <div class="muted image-status" id="imageStatus"></div>
      </div>
      <div class="field">
        <label>Labels</label>
        <details class="dropdown" id="labelsDropdown">
          <summary>Select labels</summary>
          <div class="dropdown-list" id="labelsList"></div>
        </details>
      </div>
      <div class="field">
        <label>Assignees</label>
        <details class="dropdown" id="assigneesDropdown">
          <summary>Select assignees</summary>
          <div class="dropdown-list" id="assigneesList"></div>
        </details>
      </div>
      <div class="editor-buttons">
        <button id="saveIssueButton">Create Issue</button>
        <button id="cancelIssueButton" class="secondary">Cancel</button>
      </div>
    </div>
    <div class="status" id="status"></div>
    <div class="list" id="issueList"></div>

    <script src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function getAuthToken(context) {
  const mode = getConfig().get("authMode", AUTH_VSCODE);
  if (mode === AUTH_PAT) {
    const pat = await context.secrets.get(SECRET_PAT_KEY);
    if (!pat) {
      const action = await vscode.window.showWarningMessage(
        "PAT auth mode is active, but no PAT is saved.",
        "Set PAT",
        "Cancel"
      );
      if (action === "Set PAT") {
        await setPat(context);
        const retry = await context.secrets.get(SECRET_PAT_KEY);
        if (!retry) {
          throw new Error("PAT not configured.");
        }
        return retry;
      }
      throw new Error("PAT not configured.");
    }
    return pat;
  }

  const scopes = getConfig().get("vscodeAuthScopes", ["repo"]);
  const session = await vscode.authentication.getSession("github", scopes, {
    createIfNone: true
  });
  if (!session) {
    throw new Error("GitHub auth session was not granted.");
  }
  return session.accessToken;
}

async function requireRepo(context) {
  const repo = await getActiveRepo();
  if (repo) {
    return repo;
  }

  const action = await vscode.window.showWarningMessage(
    "No repo configured and no GitHub origin detected.",
    "Init Shissues",
    "Cancel"
  );
  if (action === "Init Shissues") {
    await initRepo(context);
    const retry = await getActiveRepo();
    if (retry) {
      return retry;
    }
  }
  throw new Error("Repository is required.");
}

async function getActiveRepo() {
  const configured = getConfig().get("repo", "").trim();
  if (configured) {
    return configured;
  }
  return detectRepoFromWorkspaceRemote();
}

async function getWorkspaceRepoCandidates() {
  const repos = new Set();
  const configured = getConfig().get("repo", "").trim();
  if (configured) {
    repos.add(configured);
  }
  const folders = vscode.workspace.workspaceFolders || [];
  await Promise.all(
    folders.map(async (folder) => {
      try {
        const candidates = await getRepoCandidatesFromFolder(folder.uri.fsPath);
        candidates.forEach((repo) => repos.add(repo));
      } catch {
        // Ignore folders without git remotes.
      }
    })
  );
  return Array.from(repos).sort();
}

async function handleRepoSelection(context, payload) {
  const value = payload && payload.value ? String(payload.value).trim() : "";
  if (!value) {
    return;
  }
  if (value === "__auto__") {
    await setConfigValue("repo", "");
    vscode.window.showInformationMessage("Shissues will auto-detect the repo.");
    return;
  }
  if (value === "__custom__") {
    const current = getConfig().get("repo", "").trim();
    const input = await vscode.window.showInputBox({
      title: "Set Shissues Repo",
      prompt: "owner/repo",
      value: current || "",
      validateInput: (text) => (text.trim() && text.includes("/") ? null : "Enter owner/repo")
    });
    if (!input) {
      return;
    }
    await setConfigValue("repo", input.trim());
    vscode.window.showInformationMessage(`Shissues repo set to ${input.trim()}`);
    return;
  }
  await setConfigValue("repo", value);
  vscode.window.showInformationMessage(`Shissues repo set to ${value}`);
}

function getConfig() {
  return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

async function setConfigValue(key, value) {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
  const target = hasWorkspace
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await getConfig().update(key, value, target);
}

async function detectRepoFromWorkspaceRemote() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    try {
      const candidates = await getRepoCandidatesFromFolder(folder.uri.fsPath);
      if (candidates.length) {
        return candidates[0];
      }
    } catch {
      // Ignore folders without git remotes.
    }
  }
  return undefined;
}

function parseRepoFromRemote(remote) {
  // Supports: git@github.com:owner/repo.git and https://github.com/owner/repo.git
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/\n]+?)(?:\.git)?\/?$/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

async function getRepoCandidatesFromFolder(folderPath) {
  const remotes = await listGitRemotes(folderPath);
  if (!remotes.length) {
    return [];
  }
  const ordered = remotes.includes("origin")
    ? ["origin", ...remotes.filter((name) => name !== "origin")]
    : remotes;
  const repos = [];
  for (const name of ordered) {
    try {
      const remote = await execFile("git", ["remote", "get-url", name], folderPath);
      const repo = parseRepoFromRemote(remote.trim());
      if (repo && !repos.includes(repo)) {
        repos.push(repo);
      }
    } catch {
      // Ignore invalid remotes.
    }
  }
  return repos;
}

async function listGitRemotes(folderPath) {
  const output = await execFile("git", ["remote"], folderPath);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function execFile(command, args, cwd) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr ? stderr.trim() : error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function githubRequest(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = https.request(
      {
        hostname: "api.github.com",
        path,
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "shissues-vscode-extension",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (rawBody) {
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              parsed = { message: rawBody };
            }
          }

          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            const msg = parsed && parsed.message ? parsed.message : "GitHub request failed";
            reject(new Error(`${msg} (${response.statusCode || "unknown"})`));
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function getIssueFilter(context) {
  return (
    context.workspaceState.get("issueFilter") ||
    getConfig().get("defaultIssueFilter", "open")
  );
}

function getIssueSearch(context) {
  return context.workspaceState.get("issueSearch", "");
}

async function setIssueFilterState(context, filter) {
  await context.workspaceState.update("issueFilter", filter);
}

async function setIssueSearchState(context, search) {
  await context.workspaceState.update("issueSearch", search);
}

async function clearIssueSearchState(context) {
  await context.workspaceState.update("issueSearch", "");
}

function getImageMaxSizeMB() {
  const raw = Number(getConfig().get("imageMaxSizeMB", DEFAULT_IMAGE_MAX_MB));
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMAGE_MAX_MB;
  }
  return raw;
}

function getImageMaxSizeBytes() {
  return Math.round(getImageMaxSizeMB() * 1024 * 1024);
}

function normalizeRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function getImageUploadPathPrefix() {
  const configured = getConfig().get("imageUploadPath", ".shissues/uploads");
  return normalizeRepoPath(configured);
}

function sanitizeFileStem(name) {
  const base = String(name || "")
    .trim()
    .replace(/\.[^/.]+$/, "");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "image";
}

function resolveImageExtension(name, mime) {
  const extFromMime = IMAGE_MIME_EXTENSIONS[mime] || "";
  const extFromName = path.extname(String(name || "")).replace(".", "").toLowerCase();
  const ext = extFromMime || extFromName || "png";
  return ext.replace(/[^a-z0-9]/g, "") || "png";
}

function buildImageRepoPath(name, mime) {
  const baseName = path.basename(String(name || ""));
  const stem = sanitizeFileStem(baseName);
  const ext = resolveImageExtension(baseName, mime);
  const stamp = formatTimestamp(new Date());
  const nonce = Math.random().toString(36).slice(2, 8);
  const filename = `${stamp}-${nonce}-${stem}.${ext}`;
  const prefix = getImageUploadPathPrefix();
  const repoPath = prefix ? `${prefix}/${filename}` : filename;
  return {
    repoPath,
    filename,
    alt: stem
  };
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function stripDataUrlPrefix(data) {
  const raw = String(data || "");
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma >= 0) {
    return raw.slice(comma + 1);
  }
  return raw;
}

async function resolveImageUploadBranch(repo, token) {
  const configured = String(getConfig().get("imageUploadBranch", "")).trim();
  if (configured) {
    return configured;
  }
  try {
    const repoInfo = await githubRequest(token, "GET", `/repos/${repo}`);
    if (repoInfo && repoInfo.default_branch) {
      return repoInfo.default_branch;
    }
  } catch {
    // Fall through to default branch setting.
  }
  return getConfig().get("defaultBaseBranch", "main");
}

async function uploadIssueImage(context, payload) {
  const repo = await requireRepo(context);
  const token = await getAuthToken(context);
  const data = stripDataUrlPrefix(payload && payload.data);
  const mime = payload && payload.mime ? String(payload.mime) : "";
  if (!data) {
    throw new Error("Image data is missing.");
  }
  if (!mime || !mime.startsWith("image/")) {
    throw new Error("Unsupported image type.");
  }

  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) {
    throw new Error("Image data is empty.");
  }
  const maxBytes = getImageMaxSizeBytes();
  if (buffer.length > maxBytes) {
    const maxMb = getImageMaxSizeMB();
    throw new Error(`Image exceeds ${maxMb} MB limit.`);
  }

  const { repoPath, filename, alt } = buildImageRepoPath(payload && payload.name, mime);
  const branch = await resolveImageUploadBranch(repo, token);
  const response = await githubRequest(token, "PUT", `/repos/${repo}/contents/${repoPath}`, {
    message: `Add issue image ${filename}`,
    content: buffer.toString("base64"),
    branch
  });
  const downloadUrl = response && response.content ? response.content.download_url : "";
  const url = downloadUrl || `https://raw.githubusercontent.com/${repo}/${branch}/${repoPath}`;
  return {
    url,
    markdown: `![${alt}](${url})`,
    path: repoPath,
    name: filename
  };
}

function parseCsvList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return parseCsvList(value);
}

function getMessagePayload(message) {
  if (!message || typeof message !== "object") {
    return {};
  }
  if (message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  const { type, ...rest } = message;
  return rest;
}

module.exports = {
  activate,
  deactivate
};
