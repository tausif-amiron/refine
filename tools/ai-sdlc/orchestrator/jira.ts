// Minimal Jira Cloud REST v3 client for the deterministic scripts (extract fetch, escalation,
// ops tickets, verification). Agents use the Atlassian MCP server interactively; scripts use this.
export interface JiraIssue { key: string; summary: string; text: string; status: string; labels: string[]; created?: string; storyPoints?: number; estimateHours?: number }

type Adf = { type: string; text?: string; content?: Adf[]; attrs?: Record<string, unknown> };

export class Jira {
  constructor(private base: string, private email: string, private token: string, private fetchImpl: typeof fetch = fetch) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Jira | undefined {
    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = env;
    return JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN ? new Jira(JIRA_BASE_URL.replace(/\/$/, ""), JIRA_EMAIL, JIRA_API_TOKEN) : undefined;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from(`${this.email}:${this.token}`).toString("base64"),
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Jira ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private pointsField?: Promise<string | undefined>;
  /** The story points field: JIRA_STORY_POINTS_FIELD, else the field named "Story Points" / "Story point estimate". */
  storyPointsField(): Promise<string | undefined> {
    this.pointsField ??= process.env.JIRA_STORY_POINTS_FIELD
      ? Promise.resolve(process.env.JIRA_STORY_POINTS_FIELD)
      : this.req<{ id: string; name: string }[]>("GET", "/rest/api/3/field")
        .then((fs) => (fs.find((f) => /^story points?$/i.test(f.name)) ?? fs.find((f) => /^story point estimate$/i.test(f.name)))?.id)
        .catch(() => undefined);
    return this.pointsField;
  }

  private sizing(fields: any, pointsField?: string): Pick<JiraIssue, "storyPoints" | "estimateHours"> {
    const points = pointsField ? fields[pointsField] : undefined;
    const est = fields.timeoriginalestimate;
    return { ...(typeof points === "number" ? { storyPoints: points } : {}), ...(typeof est === "number" ? { estimateHours: est / 3600 } : {}) };
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const pf = await this.storyPointsField();
    const r = await this.req<any>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels,created,timeoriginalestimate${pf ? `,${pf}` : ""}`);
    return {
      key: r.key,
      summary: r.fields.summary ?? "",
      text: adfToText(r.fields.description),
      status: r.fields.status?.name ?? "",
      labels: r.fields.labels ?? [],
      created: r.fields.created,
      ...this.sizing(r.fields, pf),
    };
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
  }

  async search(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const pf = await this.storyPointsField();
    const r = await this.req<any>("POST", "/rest/api/3/search/jql", { jql, maxResults, fields: ["summary", "status", "labels", "created", "description", "timeoriginalestimate", ...(pf ? [pf] : [])] });
    return (r.issues ?? []).map((i: any) => ({ key: i.key, summary: i.fields.summary, text: adfToText(i.fields.description), status: i.fields.status?.name ?? "", labels: i.fields.labels ?? [], created: i.fields.created, ...this.sizing(i.fields, pf) }));
  }

  async createIssue(project: string, summary: string, description: string, labels: string[], issueType = "Bug"): Promise<string> {
    const r = await this.req<any>("POST", "/rest/api/3/issue", {
      fields: { project: { key: project }, summary: summary.slice(0, 250), description: textToAdf(description), labels, issuetype: { name: issueType } },
    });
    return r.key;
  }

  async transition(key: string, toStatus: string): Promise<boolean> {
    const r = await this.req<any>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const t = (r.transitions ?? []).find((x: any) => x.to?.name?.toLowerCase() === toStatus.toLowerCase() || x.name?.toLowerCase() === toStatus.toLowerCase());
    if (!t) return false;
    await this.req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }
}

/** Atlassian Document Format → plain text with markdown-ish headings and numbered lists. */
export function adfToText(adf: unknown): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  const lines: string[] = [];
  const inline = (n: Adf): string => {
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return String(n.attrs?.text ?? "");
    if (n.type === "inlineCard") return String(n.attrs?.url ?? "");
    return (n.content ?? []).map(inline).join("");
  };
  const block = (n: Adf, prefix = "") => {
    switch (n.type) {
      case "heading": lines.push(`${"#".repeat(Number(n.attrs?.level ?? 2))} ${inline(n)}`); break;
      case "paragraph": lines.push(prefix + inline(n)); break;
      case "orderedList": (n.content ?? []).forEach((li, i) => listItem(li, `${Number(n.attrs?.order ?? 1) + i}. `)); break;
      case "bulletList": (n.content ?? []).forEach((li) => listItem(li, "- ")); break;
      // A Jira checklist: its items hold their text directly (RT-3's acceptance criteria were lost without this).
      case "taskList": (n.content ?? []).forEach((it) => {
        if (it.type === "taskList") block(it, prefix);
        else lines.push(`${prefix}- [${it.attrs?.state === "DONE" ? "x" : " "}] ${inline(it)}`);
      }); break;
      case "codeBlock": lines.push("```", inline(n), "```"); break;
      case "blockquote": (n.content ?? []).forEach((c) => block(c, "> ")); break;
      case "rule": lines.push("---"); break;
      default: (n.content ?? []).forEach((c) => block(c, prefix));
    }
  };
  const listItem = (li: Adf, marker: string) => {
    const [first, ...rest] = li.content ?? [];
    if (first) lines.push(marker + inline(first));
    rest.forEach((c) => block(c, "   "));
  };
  ((adf as Adf).content ?? []).forEach((c) => block(c));
  return lines.join("\n");
}

/** Plain text → ADF. "## " lines become headings, ``` fences become code blocks, blank lines split paragraphs. */
export function textToAdf(text: string): Adf & { version: number } {
  const content: Adf[] = [];
  const blocks = text.split(/```/);
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) { content.push({ type: "codeBlock", content: [{ type: "text", text: chunk.replace(/^\w*\n/, "").trimEnd() || " " }] }); return; }
    for (const para of chunk.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      // A heading line becomes a heading; any lines after it in the same paragraph follow as a paragraph.
      const [first, ...rest] = t.split("\n");
      const h = first.match(/^(#{1,6})\s+(.+)$/);
      if (h) content.push({ type: "heading", attrs: { level: h[1].length }, content: [{ type: "text", text: h[2] }] });
      const lines = h ? rest : [first, ...rest];
      if (!lines.length) continue;
      const parts: Adf[] = [];
      lines.forEach((line, j) => { if (j) parts.push({ type: "hardBreak" }); if (line) parts.push({ type: "text", text: line }); });
      content.push({ type: "paragraph", content: parts });
    }
  });
  return { type: "doc", version: 1, content };
}
