// 用户旅程 mock OpenAI 服务器（v3，无状态）：按最后一条用户消息内容路由脚本响应；
// 同时支持流式（SSE）与非流式（JSON）两种响应模式（子代理内环为非流式）。
// LF 用 String.fromCharCode(10) 构造，避免转义歧义。
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const LF = String.fromCharCode(10);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    // 自动起标题请求是后台噪音，不写入捕获文件——否则会在下一轮读探针前覆盖
    // 正在被断言的请求（v0.5.7 起默认会话每轮循环都会触发一次起标题调用）。
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const preMessages = parsed.messages ?? [];
    const preLastUser = [...preMessages].reverse().find((m) => m.role === 'user');
    const isTitleCall = typeof preLastUser?.content === 'string' && preLastUser.content.includes('会话标题');
    if (!isTitleCall) writeFileSync(new URL('./last-request.json', import.meta.url), body);
    const messages = parsed.messages ?? [];
    const toolResults = messages.filter((m) => m.role === 'tool');
    const lastTool = [...toolResults].pop();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const isSubagent = messages.some((m) => m.role === 'system' && String(m.content).includes('你是子代理'));
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
    const toolAfterLastUser = messages.some((m, i) => m.role === 'tool' && i > lastUserIdx);

    // 路由：子代理内环 → 收尾；用户消息命中关键词 → 工具调用；有新工具结果 → 总结；否则普通聊天
    let reply;
    if (isSubagent) {
      reply = { type: 'text', text: 'SUB-FINAL: 子代理任务完成' };
    } else if (toolAfterLastUser) {
      reply = { type: 'text', text: 'TOOL-FINAL: ' + String(lastTool.content).slice(0, 60) };
    } else if (userText.includes('会话标题')) {
      // 自动起标题 prompt（内嵌用户首句，可能误命中下方关键词路由）→ 恒定返回原会话名。
      // v0.5.7 起默认会话也会被自动起标题；恒定回复使其不改名，J8 的「默认会话」断言保持有效。
      reply = { type: 'text', text: '默认会话' };
    } else if (userText.includes('委派')) {
      reply = { type: 'tool', id: 'j-sub', name: 'subagent.run', args: '{"task":"生成一句问候语"}' };
    } else if (userText.includes('读取')) {
      reply = { type: 'tool', id: 'j-read', name: 'read-file.read', args: '{"path":"README.md"}' };
    } else if (userText.includes('把 OK-MARK')) {
      reply = { type: 'tool', id: 'j-write', name: 'write-file.write', args: '{"path":"out.txt","content":"OK-MARK"}' };
    } else if (userText.includes('secret')) {
      reply = { type: 'tool', id: 'j-reject', name: 'write-file.write', args: '{"path":"reject.txt","content":"secret"}' };
    } else if (userText.includes('把计划')) {
      reply = { type: 'tool', id: 'j-plan', name: 'write-file.write', args: '{"path":"plan.txt","content":"plan"}' };
    } else if (userText.includes('命令')) {
      reply = { type: 'tool', id: 'j-shell', name: 'shell-exec.run', args: '{"command":"echo SHELL-OK"}' };
    } else if (userText.includes('echo')) {
      reply = { type: 'tool', id: 'j-mcp', name: 'mcp.mock.echo', args: '{"text":"hi"}' };
    } else {
      reply = { type: 'text', text: '收到：' + userText.slice(-30) };
    }

    if (parsed.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write('data: ' + JSON.stringify(obj) + LF + LF);
      if (reply.type === 'tool') {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: reply.id, function: { name: reply.name, arguments: reply.args } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        const text = reply.text;
        for (const piece of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
          if (piece) send({ choices: [{ delta: { content: piece } }] });
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]' + LF + LF);
      res.end();
      return;
    }

    // 非流式：标准 JSON 响应
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (reply.type === 'tool') {
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [{ id: reply.id, type: 'function', function: { name: reply.name, arguments: reply.args } }] },
          finish_reason: 'tool_calls',
        }],
      }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] }));
    }
  });
});
server.listen(18099, '127.0.0.1', () => console.log('journey mock on 18099'));
