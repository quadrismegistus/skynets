// Generates public/client-metadata.json for atproto OAuth from APP_URL.
// The client_id an atproto browser client presents *is* the URL this file is
// served from, so it must be generated to match the deploy URL exactly — no
// hand-maintained copy that can drift out of sync.
//
// Usage: APP_URL=https://ryanheuser.com/skynets/ node scripts/gen-client-metadata.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appUrl = process.env.APP_URL
if (!appUrl) {
  console.error('APP_URL env var is required, e.g. https://ryanheuser.com/skynets/')
  process.exit(1)
}
const base = appUrl.endsWith('/') ? appUrl : `${appUrl}/`

const metadata = {
  client_id: `${base}client-metadata.json`,
  client_name: 'Skynets',
  client_uri: base,
  application_type: 'web',
  dpop_bound_access_tokens: true,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  redirect_uris: [base],
  scope: 'atproto transition:generic',
  token_endpoint_auth_method: 'none',
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'client-metadata.json')
writeFileSync(outFile, `${JSON.stringify(metadata, null, 2)}\n`)
console.log(`wrote ${outFile}`)
console.log(`client_id  = ${metadata.client_id}`)
console.log(`redirect   = ${metadata.redirect_uris[0]}`)
