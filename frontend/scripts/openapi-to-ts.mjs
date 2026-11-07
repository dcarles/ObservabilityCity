// Turns the OpenAPI document of the snapshot API into TypeScript types (the same shape the openapi-typescript tool wrote: paths, components, operations).
// It only knows the parts of OpenAPI that the Host's document uses and throws on anything else, so a new kind of construct is a loud build error
// instead of a silently wrong type.
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
const PARAM_KINDS = ['query', 'header', 'path', 'cookie']
const unsupported = (what, where) => {
  throw new Error(`openapi-to-ts: ${what} is not supported (${where}). Teach scripts/openapi-to-ts.mjs about it, with a test in tests/unit/openapi-to-ts.test.ts.`)
}
const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name))
const ref = (r, where) => {
  const m = /^#\/components\/schemas\/([\w.-]+)$/.exec(r)
  if (!m) unsupported(`reference ${r}`, where)
  return `components["schemas"][${JSON.stringify(m[1])}]`
}

/** The TypeScript type of a schema, and the one-line comment that goes in front of a property of that type. */
function typeOf(schema, indent, where) {
  const known = new Set(['type', 'format', 'nullable', 'items', 'properties', 'required', 'enum', '$ref', 'additionalProperties'])
  for (const k of Object.keys(schema)) if (!known.has(k)) unsupported(`the schema keyword "${k}"`, where)
  let type
  let comment = null
  if (schema.$ref) type = ref(schema.$ref, where)
  else if (schema.enum) {
    if (schema.type !== 'string' || !schema.enum.every((m) => typeof m === 'string')) unsupported('an enum that is not made of strings', where)
    type = schema.enum.map((m) => JSON.stringify(m)).join(' | ')
    comment = '@enum {string}'
  } else if (schema.type === 'string') type = 'string'
  else if (schema.type === 'boolean') type = 'boolean'
  else if (schema.type === 'number' || schema.type === 'integer') type = 'number'
  else if (schema.type === 'array') {
    if (!schema.items) unsupported('an array without items', where)
    const item = typeOf(schema.items, indent, `${where}[]`).type
    type = `${/[|&]/.test(item) ? `(${item})` : item}[]`
  } else if (schema.type === 'object' && schema.properties) type = objectOf(schema, indent, where)
  else unsupported(`the schema type ${JSON.stringify(schema.type)}`, where)
  if (schema.format && !schema.enum && !schema.$ref) comment = `Format: ${schema.format}`
  if (schema.nullable) type = `${type} | null`
  return { type, comment }
}

function objectOf(schema, indent, where) {
  if (schema.additionalProperties) unsupported('additionalProperties', where)
  const required = new Set(schema.required ?? [])
  const pad = '    '.repeat(indent + 1)
  const lines = Object.entries(schema.properties).map(([name, prop]) => {
    const { type, comment } = typeOf(prop, indent + 1, `${where}.${name}`)
    return `${comment ? `${pad}/** ${comment} */\n` : ''}${pad}${key(name)}${required.has(name) ? '' : '?'}: ${type};`
  })
  return `{\n${lines.join('\n')}\n${'    '.repeat(indent)}}`
}

function jsonContent(content, indent, where) {
  const types = Object.keys(content)
  if (types.some((t) => t !== 'application/json')) unsupported(`the content type ${types.join(', ')}`, where)
  const pad = '    '.repeat(indent + 1)
  return `{\n${pad}"application/json": ${typeOf(content['application/json'].schema, indent + 1, where).type};\n${'    '.repeat(indent)}}`
}

function parameters(op, where) {
  const pad = '            '
  const lines = PARAM_KINDS.map((kind) => {
    const list = (op.parameters ?? []).filter((p) => p.in === kind)
    if (kind === 'header' || kind === 'cookie') {
      if (list.length) unsupported(`${kind} parameters`, where)
      return `${pad}${kind}?: never;`
    }
    if (list.length === 0) return `${pad}${kind}?: never;`
    const anyRequired = list.some((p) => p.required)
    const inner = list.map((p) => `${pad}    ${key(p.name)}${p.required ? '' : '?'}: ${typeOf(p.schema, 3, `${where}.${p.name}`).type};`)
    return `${pad}${kind}${anyRequired ? '' : '?'}: {\n${inner.join('\n')}\n${pad}};`
  })
  return `        parameters: {\n${lines.join('\n')}\n        };`
}

function operation(id, op, where) {
  for (const k of Object.keys(op)) if (!['tags', 'operationId', 'parameters', 'requestBody', 'responses'].includes(k)) unsupported(`the operation keyword "${k}"`, where)
  const body = op.requestBody
  const requestBody = !body ? '        requestBody?: never;' : `        requestBody${body.required ? '' : '?'}: {\n            content: ${jsonContent(body.content, 3, `${where}.requestBody`)};\n        };`
  const responses = Object.entries(op.responses).map(([code, r]) => {
    const content = r.content ? `content: ${jsonContent(r.content, 4, `${where}.${code}`)};` : 'content?: never;'
    return `            /** @description ${r.description} */\n            ${/^\d+$/.test(code) ? code : JSON.stringify(code)}: {\n                headers: {\n                    [name: string]: unknown;\n                };\n                ${content}\n            };`
  })
  return `    ${key(id)}: {\n${parameters(op, where)}\n${requestBody}\n        responses: {\n${responses.join('\n')}\n        };\n    };`
}

export function generate(doc) {
  const pathLines = []
  const operationLines = []
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const k of Object.keys(item)) if (!METHODS.includes(k)) unsupported(`the path item keyword "${k}"`, path)
    const methods = METHODS.map((m) => {
      if (!item[m]) return `        ${m}?: never;`
      operationLines.push(operation(item[m].operationId, item[m], `${m} ${path}`))
      return `        ${m}: operations[${JSON.stringify(item[m].operationId)}];`
    })
    pathLines.push(`    ${JSON.stringify(path)}: {\n        parameters: {\n            query?: never;\n            header?: never;\n            path?: never;\n            cookie?: never;\n        };\n${methods.join('\n')}\n    };`)
  }
  const schemas = Object.entries(doc.components?.schemas ?? {}).map(([name, schema]) => {
    const { type, comment } = typeOf(schema, 2, name)
    return `${comment ? `        /** ${comment} */\n` : ''}        ${key(name)}: ${type};`
  })
  return `/**
 * This file was auto-generated by scripts/openapi-to-ts.mjs.
 * Do not make direct changes to the file.
 */

export interface paths {
${pathLines.join('\n')}
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
${schemas.join('\n')}
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
${operationLines.join('\n')}
}
`
}
