import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generate } from '../../scripts/openapi-to-ts.mjs'

// The generator that turns the Host's OpenAPI document into src/contracts.ts. The committed files are its golden example.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const doc = (schemas: object, paths: object = {}) => ({ openapi: '3.0.4', paths, components: { schemas } })

describe('openapi-to-ts', () => {
  it('turns the committed contracts/openapi.json into exactly the committed src/contracts.ts', () => {
    expect(generate(JSON.parse(read('../../../contracts/openapi.json')))).toBe(read('../../src/contracts.ts'))
  })

  it('makes a required property required, an optional one optional, and a nullable one allow null', () => {
    const out = generate(doc({
      Thing: { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'integer', format: 'int32' }, c: { type: 'string', nullable: true } } },
    }))
    expect(out).toContain('        Thing: {\n            a: string;\n            /** Format: int32 */\n            b?: number;\n            c?: string | null;\n        };')
  })

  it('writes arrays, references and enums', () => {
    const out = generate(doc({
      Colour: { type: 'string', enum: ['Red', 'Green'] },
      Box: { type: 'object', required: ['colours', 'items'], properties: { colours: { type: 'array', items: { $ref: '#/components/schemas/Colour' } }, items: { type: 'array', items: { type: 'string', nullable: true } } } },
    }))
    expect(out).toContain('        /** @enum {string} */\n        Colour: "Red" | "Green";')
    expect(out).toContain('colours: components["schemas"]["Colour"][];')
    expect(out).toContain('items: (string | null)[];')
  })

  it('writes operations with query, path and body parameters and a response without content', () => {
    const out = generate(doc({ Body: { type: 'object', properties: { x: { type: 'boolean' } } } }, {
      '/api/x/{id}': {
        post: {
          operationId: 'DoX',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'env', in: 'query', schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } },
          responses: { 200: { description: 'OK' } },
        },
      },
    }))
    expect(out).toContain('post: operations["DoX"];')
    expect(out).toContain('query?: {\n                env?: string;\n            };')
    expect(out).toContain('path: {\n                id: string;\n            };')
    expect(out).toContain('requestBody: {\n            content: {\n                "application/json": components["schemas"]["Body"];')
    expect(out).toContain('content?: never;')
  })

  it('refuses a construct it does not know, instead of guessing a type', () => {
    expect(() => generate(doc({ A: { oneOf: [{ type: 'string' }] } }))).toThrow(/oneOf/)
    expect(() => generate(doc({ A: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } }))).toThrow(/additionalProperties/)
    expect(() => generate(doc({ A: { type: 'object', properties: { p: { type: 'null' } } } }))).toThrow(/schema type/)
  })
})
