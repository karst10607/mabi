// 一次性 CDP 截圖：node shot.mjs <ws-url> <out.png>
// 截的是渲染端產出的畫面，不是螢幕——本機 `screencapture` 沒有「螢幕錄取」權限時
// 只會拿到純桌布，別拿它當證據。
import fs from 'node:fs';
const [WS_URL, OUT] = process.argv.slice(2);
const ws = new WebSocket(WS_URL);
let done = false;
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== 1 || done) return;
  done = true;
  if (m.error) console.log('ERR', JSON.stringify(m.error));
  else {
    fs.writeFileSync(OUT, Buffer.from(m.result.data, 'base64'));
    console.log('wrote', OUT);
  }
  ws.close();
  process.exit(0);
};
ws.onerror = () => { console.log('WS_ERROR'); process.exit(1); };
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
