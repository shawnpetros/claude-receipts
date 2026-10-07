// hooks/hooks.json must carry both keys: `modules` for builds that run mods
// (2.1.287 and later) and an empty `hooks` that older builds read, so they
// load nothing instead of failing on an unknown manifest. The test kit
// imports only code, so this check runs as a script:
//
//   bun scripts/check-manifest.ts

import manifest from '../hooks/hooks.json'

const parsed = manifest as { description?: unknown; hooks?: unknown; modules?: unknown }
const problems: string[] = []
if (JSON.stringify(parsed.modules) !== JSON.stringify(['./register.ts'])) problems.push('modules is not ["./register.ts"]')
if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Object.keys(parsed.hooks).length !== 0) problems.push('hooks is not {}')
if (typeof parsed.description !== 'string' || !parsed.description.includes('2.1.287')) problems.push('description does not name 2.1.287')

if (problems.length > 0) {
  console.error(`hooks.json: ${problems.join('; ')}`)
  process.exit(1)
}
console.log('hooks.json: modules and hooks both present, description names 2.1.287')
