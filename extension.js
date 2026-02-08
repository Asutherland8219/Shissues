const cp = require("child_process");
const https = require("https");
const vscode = require("vscode");

const CONFIG_ROOT = "shissues";
const SECRET_PAT_KEY = "githubPat";
const AUTH_VSCODE = "vscode";
const AUTH_PAT = "pat";

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

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
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
      enableScripts: true
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

    const repo = await getActiveRepo();
    if (!repo) {
      this.postState({
        status: "noRepo",
        repo: "",
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
        filter,
        search,
        issues: issues.map((issue) => toIssueViewModel(issue))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postState({
        status: "error",
        repo,
        filter,
        search,
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
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

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
  <body>
    <div class="header">
      <div id="repoLabel">Repo: —</div>
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

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const repoLabel = document.getElementById("repoLabel");
      const summaryLabel = document.getElementById("summaryLabel");
      const status = document.getElementById("status");
      const issueList = document.getElementById("issueList");
      const searchInput = document.getElementById("searchInput");
      const searchButton = document.getElementById("searchButton");
      const clearButton = document.getElementById("clearButton");
      const filterSelect = document.getElementById("filterSelect");
      const refreshButton = document.getElementById("refreshButton");
      const newIssueButton = document.getElementById("newIssueButton");
      const editor = document.getElementById("editor");
      const editorTitle = document.getElementById("editorTitle");
      const editorClose = document.getElementById("editorClose");
      const issueTitle = document.getElementById("issueTitle");
      const issueBody = document.getElementById("issueBody");
      const labelsDropdown = document.getElementById("labelsDropdown");
      const assigneesDropdown = document.getElementById("assigneesDropdown");
      const labelsList = document.getElementById("labelsList");
      const assigneesList = document.getElementById("assigneesList");
      const saveIssueButton = document.getElementById("saveIssueButton");
      const cancelIssueButton = document.getElementById("cancelIssueButton");
      let editorMode = "create";
      let editorNumber = null;
      let meta = { labels: [], assignees: [], loaded: false };
      let pendingSelection = { labels: [], assignees: [] };
      let currentRepo = "";

      function post(type, payload = {}) {
        vscode.postMessage({ type, ...payload });
      }

      function render(payload) {
        currentRepo = payload.repo || "";
        repoLabel.textContent = payload.repo ? "Repo: " + payload.repo : "Repo: —";
        summaryLabel.textContent = payload.search
          ? 'Search: "' + payload.search + '"'
          : payload.filter
            ? "Filter: " + payload.filter
            : "";
        searchInput.value = payload.search || "";
        filterSelect.value = payload.filter || "open";
        issueList.innerHTML = "";
        refreshButton.classList.remove("spinning");

        if (payload.status === "noRepo") {
          status.textContent = "No repository configured.";
          issueList.appendChild(buildEmpty("Set a repo to load issues.", "Init Repo", "initRepo"));
          return;
        }

        if (payload.status === "noAuth") {
          status.textContent = payload.error || "Authentication required.";
          const container = document.createElement("div");
          container.className = "empty";
          container.textContent = "Configure auth to load issues.";
          const actions = document.createElement("div");
          actions.className = "issue-actions";
          actions.appendChild(buildAction("Set Auth Mode", "setAuthMode"));
          actions.appendChild(buildAction("Set PAT", "setPat"));
          container.appendChild(actions);
          issueList.appendChild(container);
          return;
        }

        if (payload.status === "error") {
          status.textContent = payload.error || "Failed to load issues.";
          issueList.appendChild(buildEmpty("Try refreshing the view.", "Refresh", "refresh"));
          return;
        }

        status.textContent = payload.issues.length
          ? payload.issues.length + " issue(s)"
          : "No issues found.";

        if (!payload.issues.length) {
          issueList.appendChild(buildEmpty("No issues match this view.", "Clear Search", "clearSearch"));
          return;
        }

        payload.issues.forEach((issue) => {
          issueList.appendChild(buildIssue(issue));
        });
      }

      function applyMeta(newMeta) {
        if (!newMeta) {
          return;
        }
        meta = {
          labels: Array.isArray(newMeta.labels) ? newMeta.labels : [],
          assignees: Array.isArray(newMeta.assignees) ? newMeta.assignees : [],
          repo: newMeta.repo || "",
          loaded: true
        };
        renderMetaLists();
      }

      function buildEmpty(text, buttonLabel, action) {
        const container = document.createElement("div");
        container.className = "empty";
        const label = document.createElement("div");
        label.textContent = text;
        container.appendChild(label);
        if (buttonLabel && action) {
          const actionButton = document.createElement("button");
          actionButton.textContent = buttonLabel;
          actionButton.className = "secondary";
          actionButton.addEventListener("click", () => post(action));
          container.appendChild(actionButton);
        }
        return container;
      }

      function buildAction(label, action, extra = {}) {
        const button = document.createElement("button");
        button.textContent = label;
        button.className = "secondary";
        button.addEventListener("click", () => post(action, extra));
        return button;
      }

      function buildIssue(issue) {
        const card = document.createElement("div");
        card.className = "issue";

        const title = document.createElement("div");
        title.className = "issue-title";
        title.textContent = "#" + issue.number + " " + issue.title;
        card.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "issue-meta";
        meta.textContent =
          (issue.state || "unknown") +
          " • @" +
          (issue.user || "unknown") +
          " • updated " +
          (issue.updatedAt || "unknown");
        card.appendChild(meta);

        if (issue.assignees && issue.assignees.length) {
          const assignees = document.createElement("div");
          assignees.className = "issue-meta";
          assignees.textContent = "Assignees: " + issue.assignees.join(", ");
          card.appendChild(assignees);
        }

        if (issue.labels && issue.labels.length) {
          const labels = document.createElement("div");
          labels.className = "labels";
          issue.labels.forEach((label) => {
            const pill = document.createElement("span");
            pill.className = "label";
            pill.textContent = label;
            labels.appendChild(pill);
          });
          card.appendChild(labels);
        }

        const actions = document.createElement("div");
        actions.className = "issue-actions";
        actions.appendChild(buildAction("Open", "openIssue", { url: issue.htmlUrl }));
        actions.appendChild(buildAction("Summary", "summaryIssue", { number: issue.number }));
        actions.appendChild(buildAction("Copy URL", "copyIssue", { url: issue.htmlUrl }));
        actions.appendChild(buildAction("Edit", "loadIssueForEdit", { number: issue.number }));
        if (issue.state === "open") {
          actions.appendChild(buildAction("Close", "setIssueState", { number: issue.number, state: "closed" }));
        } else {
          actions.appendChild(buildAction("Reopen", "setIssueState", { number: issue.number, state: "open" }));
        }
        card.appendChild(actions);

        return card;
      }

      function updateDropdownSummary(dropdown, label, selected) {
        const summary = dropdown.querySelector("summary");
        if (!summary) {
          return;
        }
        if (!selected.length) {
          summary.textContent = "Select " + label.toLowerCase();
          return;
        }
        const preview = selected.join(", ");
        summary.textContent = preview;
      }

      function renderCheckboxList(container, items, selectedValues) {
        container.innerHTML = "";
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "muted";
          empty.textContent = "No options available.";
          container.appendChild(empty);
          return;
        }
        items.forEach((item) => {
          const label = document.createElement("label");
          label.className = "checkbox-item";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = item;
          input.checked = selectedValues.has(item);
          label.appendChild(input);
          const text = document.createElement("span");
          text.textContent = item;
          label.appendChild(text);
          container.appendChild(label);
        });
      }

      function renderMetaLists() {
        const selectedLabels = new Set(pendingSelection.labels || []);
        const selectedAssignees = new Set(pendingSelection.assignees || []);
        renderCheckboxList(labelsList, meta.labels || [], selectedLabels);
        renderCheckboxList(assigneesList, meta.assignees || [], selectedAssignees);
        updateDropdownSummary(labelsDropdown, "Labels", Array.from(selectedLabels));
        updateDropdownSummary(assigneesDropdown, "Assignees", Array.from(selectedAssignees));
      }

      function getCheckedValues(container) {
        return Array.from(container.querySelectorAll("input[type='checkbox']:checked")).map(
          (input) => input.value
        );
      }

      function openEditor(mode, issue) {
        editorMode = mode;
        editorNumber = issue ? issue.number : null;
        editorTitle.textContent = mode === "edit" ? "Edit Issue" : "New Issue";
        saveIssueButton.textContent = mode === "edit" ? "Update Issue" : "Create Issue";
        issueTitle.value = issue ? issue.title || "" : "";
        issueBody.value = issue ? issue.body || "" : "";
        pendingSelection = {
          labels: issue && issue.labels ? issue.labels : [],
          assignees: issue && issue.assignees ? issue.assignees : []
        };
        renderMetaLists();
        if (!meta.loaded || (meta.repo && meta.repo !== currentRepo)) {
          post("requestMeta");
        }
        editor.classList.add("visible");
      }

      function closeEditor() {
        editor.classList.remove("visible");
        editorMode = "create";
        editorNumber = null;
        issueTitle.value = "";
        issueBody.value = "";
        pendingSelection = { labels: [], assignees: [] };
        renderMetaLists();
      }

      searchButton.addEventListener("click", () => post("search", { value: searchInput.value }));
      clearButton.addEventListener("click", () => post("clearSearch"));
      refreshButton.addEventListener("click", () => {
        refreshButton.classList.add("spinning");
        post("refresh");
      });
      newIssueButton.addEventListener("click", () => openEditor("create"));
      editorClose.addEventListener("click", () => closeEditor());
      cancelIssueButton.addEventListener("click", () => closeEditor());
      labelsList.addEventListener("change", () =>
        (() => {
          const selected = getCheckedValues(labelsList);
          pendingSelection.labels = selected;
          updateDropdownSummary(labelsDropdown, "Labels", selected);
        })()
      );
      assigneesList.addEventListener("change", () =>
        (() => {
          const selected = getCheckedValues(assigneesList);
          pendingSelection.assignees = selected;
          updateDropdownSummary(assigneesDropdown, "Assignees", selected);
        })()
      );
      saveIssueButton.addEventListener("click", () => {
        const payload = {
          title: issueTitle.value,
          body: issueBody.value,
          labels: getCheckedValues(labelsList),
          assignees: getCheckedValues(assigneesList)
        };
        if (editorMode === "edit" && editorNumber) {
          post("updateIssue", { number: editorNumber, ...payload });
        } else {
          post("createIssue", payload);
        }
      });
      filterSelect.addEventListener("change", () =>
        post("setFilter", { value: filterSelect.value })
      );
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          post("search", { value: searchInput.value });
        }
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "render") {
          render(message.payload);
          refreshButton.classList.remove("spinning");
        }
        if (message.type === "editData") {
          if (message.payload) {
            if (message.payload.meta) {
              applyMeta(message.payload.meta);
            }
            if (message.payload.issue) {
              openEditor("edit", message.payload.issue);
            }
          }
        }
        if (message.type === "meta") {
          applyMeta(message.payload);
        }
        if (message.type === "issueSaved") {
          closeEditor();
        }
        if (message.type === "error") {
          refreshButton.classList.remove("spinning");
        }
      });

      post("ready");
    </script>
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
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  try {
    const remote = await execFile("git", ["remote", "get-url", "origin"], folder.uri.fsPath);
    return parseRepoFromRemote(remote.trim());
  } catch {
    return undefined;
  }
}

function parseRepoFromRemote(remote) {
  // Supports: git@github.com:owner/repo.git and https://github.com/owner/repo.git
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/\n]+?)(?:\.git)?$/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
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
