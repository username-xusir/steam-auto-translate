import fs from 'node:fs'
const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8')
fs.writeFileSync(new URL('../src/agent.generated.mjs', import.meta.url), '// auto-generated from agent.js\nexport const AGENT_JS = ' + JSON.stringify(src) + '\n')
console.log('agent.generated.mjs written,', src.length, 'chars')
