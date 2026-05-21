import { readFileSync, writeFileSync } from 'fs';

const serverPath = new URL('../src/vmix/server.js', import.meta.url).pathname;
const content = readFileSync(serverPath, 'utf-8');

// Find the start of renderControlHtml function
const startMarker = 'function renderControlHtml() {';
const startIdx = content.indexOf(startMarker);
if (startIdx === -1) {
  console.error('Could not find renderControlHtml function start');
  process.exit(1);
}

// Find the end - look for the closing of the function (}\n\nexport function registerVmixRoutes)
const endMarker = '\nexport function registerVmixRoutes';
const endIdx = content.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('Could not find registerVmixRoutes after renderControlHtml');
  process.exit(1);
}

// Walk backwards from endIdx to find the closing `}` of renderControlHtml
// The pattern is: ...html>`;\n}\n\nexport function...
let funcEnd = endIdx;
// Go back past any whitespace/newlines
while (funcEnd > startIdx && content[funcEnd - 1] === '\n') funcEnd--;
// Now funcEnd should point right after the closing `}`
// Verify
if (content[funcEnd - 1] !== '}') {
  console.error(
    'Expected } at position',
    funcEnd - 1,
    'got:',
    content[funcEnd - 1],
  );
  process.exit(1);
}

const before = content.slice(0, startIdx);
const after = content.slice(funcEnd);

// Read the new function
const newFuncPath = new URL(
  '../src/vmix/_new-control-panel.js',
  import.meta.url,
).pathname;
const newFunc = readFileSync(newFuncPath, 'utf-8');

const result = before + newFunc + after;
writeFileSync(serverPath, result, 'utf-8');
console.log('Successfully replaced renderControlHtml function');
console.log('Before length:', before.length);
console.log('New function length:', newFunc.length);
console.log('After length:', after.length);
console.log('Total length:', result.length);
