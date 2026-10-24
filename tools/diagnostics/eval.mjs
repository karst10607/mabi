// 一次性 CDP evaluate：node eval.mjs <ws-url> <expression>
// 用 Node 24（全域 WebSocket）；Node 20 會報 `WebSocket is not defined`。
import fs from 'node:fs';
const [WS_URL, EXPR] = process.argv.slice(2);
const ws = new WebSocket(WS_URL);
let done = false;
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPR, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== 1 || done) return;
  done = true;
  if (m.error) console.log('ERR', JSON.stringify(m.error));
  else console.log(JSON.stringify(m.result.result.value ?? m.result.exceptionDetails ?? null));
  ws.close();
  process.exit(0);
};
ws.onerror = () => { console.log('WS_ERROR'); process.exit(1); };
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
