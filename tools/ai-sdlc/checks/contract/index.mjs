// Contract-test helpers for client tests (docs/TESTING.md#contract-tests).
//   Provider: assertResponse("contracts/openapi/invoices.yaml", "GET", "/invoices/42", 200, body)
//   Consumer: const body = exampleFor("contracts/openapi/invoices.yaml", "GET", "/invoices")
// Contract paths are relative to the repo root (found from the current directory upwards).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "yaml";
import Ajv2020Module from "ajv/dist/2020.js";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const cache = new Map();

function locate(path) {
  if (isAbsolute(path)) return path;
  let dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (;;) {
    const p = join(dir, path);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) throw new Error(`contract not found: ${path} (searched upwards from ${process.cwd()})`);
    dir = up;
  }
}

export function loadContract(path) {
  const full = locate(path);
  if (!cache.has(full)) {
    const doc = parse(readFileSync(full, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
    ajv.addFormat("date-time", (s) => !Number.isNaN(Date.parse(s)) && /T/.test(s));
    cache.set(full, { doc, ajv, validators: new Map() });
  }
  return cache.get(full);
}

/** Find the operation for a concrete or template path ("/invoices/42" or "/invoices/{id}"). */
export function operation(contractPath, method, path) {
  const { doc } = loadContract(contractPath);
  const m = method.toLowerCase();
  const clean = path.split("?")[0];
  for (const [tpl, item] of Object.entries(doc.paths ?? {})) {
    if (!item?.[m]) continue;
    if (tpl === clean) return { template: tpl, op: item[m] };
    const re = new RegExp("^" + tpl.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, "[^/]+") + "$");
    if (re.test(clean)) return { template: tpl, op: item[m] };
  }
  throw new Error(`${method.toUpperCase()} ${clean} is not in ${contractPath}`);
}

function resolveRef(doc, schema) {
  let s = schema;
  for (let i = 0; s && s.$ref && i < 20; i++) {
    s = s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  }
  return s;
}

function validator(contractPath, key, schema) {
  const c = loadContract(contractPath);
  if (!c.validators.has(key)) c.validators.set(key, c.ajv.compile({ ...schema, components: c.doc.components }));
  return c.validators.get(key);
}

function responseSchema(contractPath, method, path, status) {
  const { doc } = loadContract(contractPath);
  const { template, op } = operation(contractPath, method, path);
  const response = resolveRef(doc, op.responses?.[String(status)] ?? op.responses?.default);
  if (!response) return { template, error: `status ${status} is not documented for ${method.toUpperCase()} ${template} (documented: ${Object.keys(op.responses ?? {}).join(", ")})` };
  return { template, schema: response.content?.["application/json"]?.schema };
}

/** { valid, errors } for a response body. A status not in the contract is invalid. */
export function validateResponse(contractPath, method, path, status, body) {
  const r = responseSchema(contractPath, method, path, status);
  if (r.error) return { valid: false, errors: [r.error] };
  if (!r.schema) return body === undefined || body === null || body === "" ? { valid: true, errors: [] } : { valid: false, errors: [`status ${status} has no body in the contract`] };
  const v = validator(contractPath, `res ${method} ${r.template} ${status}`, r.schema);
  return v(body) ? { valid: true, errors: [] } : { valid: false, errors: v.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

export function assertResponse(contractPath, method, path, status, body) {
  const r = validateResponse(contractPath, method, path, status, body);
  if (!r.valid) throw new Error(`Response does not match ${contractPath} ${method.toUpperCase()} ${path} ${status}:\n  ${r.errors.join("\n  ")}`);
}

export function validateRequest(contractPath, method, path, body) {
  const { doc } = loadContract(contractPath);
  const { template, op } = operation(contractPath, method, path);
  const schema = resolveRef(doc, op.requestBody)?.content?.["application/json"]?.schema;
  if (!schema) return body === undefined ? { valid: true, errors: [] } : { valid: false, errors: ["operation takes no request body"] };
  const v = validator(contractPath, `req ${method} ${template}`, schema);
  return v(body) ? { valid: true, errors: [] } : { valid: false, errors: v.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

export function assertRequest(contractPath, method, path, body) {
  const r = validateRequest(contractPath, method, path, body);
  if (!r.valid) throw new Error(`Request does not match ${contractPath} ${method.toUpperCase()} ${path}:\n  ${r.errors.join("\n  ")}`);
}

/** A deterministic example body that satisfies the schema of the operation's success (or given) status. */
export function exampleFor(contractPath, method, path, status) {
  const { doc } = loadContract(contractPath);
  const { op } = operation(contractPath, method, path);
  const code = status ?? Object.keys(op.responses ?? {}).find((s) => /^2/.test(s));
  const response = resolveRef(doc, op.responses?.[String(code)]);
  const schema = response?.content?.["application/json"]?.schema;
  return schema ? sample(doc, schema, "") : undefined;
}

function sample(doc, schema, key, depth = 0) {
  const s = resolveRef(doc, schema);
  if (!s || depth > 8) return null;
  if ("const" in s) return s.const;
  if (s.enum) return s.enum[0];
  if (s.examples?.length) return s.examples[0];
  if (s.oneOf || s.anyOf) return sample(doc, (s.oneOf ?? s.anyOf)[0], key, depth + 1);
  switch (Array.isArray(s.type) ? s.type[0] : s.type) {
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = sample(doc, v, k, depth + 1);
      return out;
    }
    case "array": return [sample(doc, s.items ?? {}, key, depth + 1)];
    case "integer": return 1;
    case "number": return 1.5;
    case "boolean": return true;
    case "string":
      if (s.format === "date") return "2026-01-15";
      if (s.format === "date-time") return "2026-01-15T09:30:00.000Z";
      if (s.pattern && /\[0-9\]/.test(s.pattern)) return "10.00";
      return key === "id" || /_id$/.test(key) ? `${key}-1` : `example ${key}`.trim();
    default: return null;
  }
}

