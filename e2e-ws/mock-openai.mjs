// 本地 mock OpenAI 兼容服务器：流式 SSE + 按内容判定的脚本响应（无状态，可重复运行）
import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
    if (!hasToolResult) {
      // 尚未执行过工具 → 发起写文件工具调用（触发审批 + diff）；content 含转义换行（合规 JSON）
      const args1 = '{"path":"e2e.txt","content":"line1';
      const args2 = '\\nline2"}';
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e-1', function: { name: 'write-file.write', arguments: args1 } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args2 } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const piece of ['E2E ', '对话成功']) {
        send({ choices: [{ delta: { content: piece } }] });
      }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(18099, '127.0.0.1', () => console.log('mock openai on 18099'));
