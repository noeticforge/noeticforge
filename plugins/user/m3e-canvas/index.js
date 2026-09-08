import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

function getDesktopPath() {
  const home = os.homedir();
  const winDesktop = path.join(home, 'Desktop');
  if (existsSync(winDesktop)) return winDesktop;
  const zhDesktop = path.join(home, '桌面');
  if (existsSync(zhDesktop)) return zhDesktop;
  return winDesktop;
}

/**
 * 将 JSON 字符串压缩成官方 M3E Canvas 支持的 #docz= base64url 哈希
 */
function encodeDocz(jsonString) {
  const buf = Buffer.from(jsonString, 'utf-8');
  const deflated = zlib.deflateRawSync(buf);
  return deflated
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 内置经典设计模板库
 */
const TEMPLATES = {
  ecommerce: {
    title: '潮流商城 (ShopPulse)',
    brief: 'Material 3 Expressive 风格的现代电商应用，包含商品浏览、筛选、详情与购物车',
    platform: 'android',
    paletteKey: 'coral',
    theme: { dark: false, bothModes: true, contrast: 'standard', shape: 'rounded', font: 'roboto', motion: 'expressive' },
    frames: [
      { id: 'home', name: '探索好物', x: 0, y: 0, note: '首页流式商品流与限时特惠' },
      { id: 'detail', name: '商品详情', x: 492, y: 0, note: '商品规格参数、图片大图与即刻下单' },
      { id: 'cart', name: '我的购物车', x: 984, y: 0, note: '结算与地址选择' },
    ],
    groups: [
      { id: 'g_bar', x: 0, y: 0, axis: 'x', items: [{ id: 'top_bar', kind: 'topAppBar', label: 'ShopPulse 优选', icon: 'menu', icon2: 'shopping_bag', variant: 'filled' }] },
      { id: 'g_search', x: 16, y: 96, axis: 'x', items: [{ id: 's_box', kind: 'searchBar', label: '搜索热销数码、潮牌服饰...', icon2: 'mic', variant: 'tonal' }] },
      { id: 'g_chips', x: 16, y: 164, axis: 'x', items: [
        { id: 'c1', kind: 'chip', label: '🔥 今日热卖', icon: 'local_fire_department', checked: true },
        { id: 'c2', kind: 'chip', label: '📱 旗舰手机', icon: 'smartphone', checked: false },
        { id: 'c3', kind: 'chip', label: '🎧 无线降噪', icon: 'headphones', checked: false },
      ]},
      { id: 'g_card1', x: 16, y: 212, axis: 'x', items: [
        { id: 'p_card1', kind: 'card', label: '极简降噪头戴耳机 Pro', supporting: '空间音频 · 45dB 深度降噪 · 60h 超长续航\n￥1,299', variant: 'elevated', size: 380, size2: 240, action: { to: 'detail', transition: 'slide' } },
      ]},
      { id: 'g_card2', x: 16, y: 470, axis: 'x', items: [
        { id: 'p_card2', kind: 'card', label: '柔光屏电纸书 Note', supporting: '类纸质感 · 300PPI · 支持手写批注\n￥2,199', variant: 'filled', size: 380, size2: 220 },
      ]},
      { id: 'g_fab', x: 340, y: 700, axis: 'x', items: [{ id: 'fab_cart', kind: 'fab', label: '', icon: 'shopping_cart', variant: 'filled', note: '悬浮购物车快捷结算', action: { to: 'cart', transition: 'fade' } }] },
      { id: 'g_nav', x: 0, y: 788, axis: 'x', items: [
        { id: 'b_nav', kind: 'bottomNav', label: '', icon: null, variant: 'filled', selected: 0,
          tabs: [
            { icon: 'home', label: '首页' },
            { icon: 'category', label: '分类' },
            { icon: 'shopping_cart', label: '购物车' },
            { icon: 'person', label: '我的' },
          ],
          actions: { 'tab:2': { to: 'cart', transition: 'fade' } }
        }
      ]},
      // Detail screen
      { id: 'd_bar', x: 492, y: 0, axis: 'x', items: [{ id: 'd_top', kind: 'topAppBar', label: '商品详情', icon: 'arrow_back', icon2: 'share', variant: 'tonal', action: { to: 'home', transition: 'slide' } }] },
      { id: 'd_hero', x: 508, y: 96, axis: 'x', items: [{ id: 'd_card', kind: 'card', label: '极简降噪头戴耳机 Pro', supporting: '全新自研 H2 芯片架构，配合动态头部追踪提供剧场级音频沉浸感。高强度轻量铝合金转轴，佩戴如若无物。', size: 380, size2: 320, variant: 'elevated' }] },
      { id: 'd_btn', x: 508, y: 796, axis: 'x', items: [{ id: 'btn_buy', kind: 'button', label: '立即购买 (￥1,299)', icon: 'flash_on', variant: 'filled', size: 380, action: { to: 'cart', transition: 'slide' } }] },
    ],
  },
  dashboard: {
    title: '运维监控大屏 (CloudPulse)',
    brief: '服务器指标集群监控面板与告警中枢',
    platform: 'web',
    paletteKey: 'teal',
    theme: { dark: true, bothModes: true, contrast: 'standard', shape: 'rounded', font: 'roboto', motion: 'expressive' },
    frames: [
      { id: 'overview', name: '集群全景', x: 0, y: 0, w: 1280, h: 800, note: '各节点 CPU、内存与负载监控' },
    ],
    groups: [
      { id: 'w_rail', x: 0, y: 0, axis: 'y', items: [{ id: 'rail', kind: 'navRail', label: '', icon: null, variant: 'tonal', selected: 0,
        tabs: [{ icon: 'dashboard', label: '概览' }, { icon: 'dns', label: '节点' }, { icon: 'warning', label: '告警' }, { icon: 'settings', label: '配置' }]
      }]},
      { id: 'w_bar', x: 80, y: 0, axis: 'x', items: [{ id: 'w_top', kind: 'topAppBar', label: 'CloudPulse 生产集群监控', icon: 'cloud', icon2: 'notifications', variant: 'filled' }] },
      { id: 'w_c1', x: 104, y: 104, axis: 'x', items: [{ id: 'card_k8s', kind: 'card', label: 'Kubernetes 生产集群', supporting: '运行中 Pod: 148/148\n集群健康度: 100% 正常\n平均响应延迟: 14.2ms', size: 360, size2: 210, variant: 'elevated' }] },
      { id: 'w_c2', x: 480, y: 104, axis: 'x', items: [{ id: 'card_db', kind: 'card', label: 'MySQL 主从数据库', supporting: '主节点 QPS: 4,820\n从库同步复制延迟: 0ms\n连接池占用: 32%', size: 360, size2: 210, variant: 'filled' }] },
      { id: 'w_c3', x: 856, y: 104, axis: 'x', items: [{ id: 'card_redis', kind: 'card', label: 'Redis 缓存集群', supporting: '内存占用: 6.4 GB / 32 GB\n命中率: 98.6%\n阻塞客户端: 0', size: 360, size2: 210, variant: 'tonal' }] },
    ],
  },
  chat: {
    title: '智能助手 (NextAI Chat)',
    brief: '优雅流式对话与多模态交互界面',
    platform: 'android',
    paletteKey: 'purple',
    theme: { dark: false, bothModes: true, contrast: 'standard', shape: 'full', font: 'roboto', motion: 'expressive' },
    frames: [
      { id: 'chat_main', name: '对话主屏', x: 0, y: 0, note: '主对话历史流' },
    ],
    groups: [
      { id: 'm_bar', x: 0, y: 0, axis: 'x', items: [{ id: 'c_top', kind: 'topAppBar', label: 'NextAI 智能助手', icon: 'smart_toy', icon2: 'more_vert', variant: 'filled' }] },
      { id: 'm_msg1', x: 16, y: 112, axis: 'y', items: [
        { id: 'it_ai1', kind: 'listItem', label: '你好！我是你的专属 AI 助手。', supporting: '有什么我可以协助你的吗？支持代码重构、技术设计与知识问答。', icon: 'assistant', variant: 'filled' },
        { id: 'it_user1', kind: 'listItem', label: '帮我设计一个 Material 3 原型！', supporting: '希望能快速导出并在手机上预览。', icon: 'person', variant: 'tonal' },
        { id: 'it_ai2', kind: 'listItem', label: '没问题！已为你生成完整设计方案。', supporting: '包含流式卡片与悬浮操作栏，随时可转成代码。', icon: 'verified', variant: 'elevated' },
      ]},
      { id: 'm_input', x: 16, y: 720, axis: 'x', items: [{ id: 'input_field', kind: 'textField', label: '输入您的问题或指令...', icon: 'send', variant: 'outlined', size: 380 }] },
      { id: 'm_chips', x: 16, y: 788, axis: 'x', items: [
        { id: 'cp1', kind: 'chip', label: '代码生成', icon: 'code', checked: false },
        { id: 'cp2', kind: 'chip', label: '架构评审', icon: 'architecture', checked: false },
        { id: 'cp3', kind: 'chip', label: '原型导出', icon: 'palette', checked: false },
      ]},
    ],
  },
};

// 1. 生成 M3E Canvas 设计项目
const createDesignTool = {
  name: 'm3e-canvas.create_design',
  description: '根据传入的应用标题、描述、平台及组件结构，生成符合 M3E Canvas 标准规范的完整工程设计 JSON 文档。',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '应用名称（如：美食小记、健身计划）',
      },
      brief: {
        type: 'string',
        description: '应用的一两句功能摘要',
      },
      platform: {
        type: 'string',
        enum: ['android', 'web'],
        description: '设计目标平台：android（手机 412x892）或 web（桌面 1280x800）',
      },
      paletteKey: {
        type: 'string',
        enum: ['purple', 'blue', 'green', 'coral', 'amber', 'teal', 'mono'],
        description: 'Material 3 调色板基色',
      },
      screens: {
        type: 'array',
        description: '包含的屏幕列表，例如 [{ id: "home", name: "首页", note: "展示列表" }]',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['id', 'name'],
        },
      },
      templateKey: {
        type: 'string',
        enum: ['ecommerce', 'dashboard', 'chat'],
        description: '可选快速起步模版：ecommerce (电商)、dashboard (大屏监控)、chat (智能对话)',
      },
    },
    required: ['title'],
  },
  permissions: [],
  requiresApproval: false,

  async execute(args) {
    try {
      let doc;
      if (args.templateKey && TEMPLATES[args.templateKey]) {
        doc = JSON.parse(JSON.stringify(TEMPLATES[args.templateKey]));
        if (args.title) doc.title = args.title;
        if (args.brief) doc.brief = args.brief;
        if (args.platform) doc.platform = args.platform;
        if (args.paletteKey) doc.paletteKey = args.paletteKey;
      } else {
        const platform = args.platform || 'android';
        const isWeb = platform === 'web';
        const screens = Array.isArray(args.screens) && args.screens.length ? args.screens : [{ id: 'home', name: '主屏幕', note: '核心界面' }];
        const frames = screens.map((s, idx) => ({
          id: s.id,
          name: s.name,
          x: idx * (isWeb ? 1360 : 492),
          y: 0,
          w: isWeb ? 1280 : 412,
          h: isWeb ? 800 : 892,
          note: s.note || '',
        }));
        doc = {
          title: args.title || 'M3E 设计工程',
          brief: args.brief || '基于 Material 3 Expressive 的设计原型',
          frame: 'phone',
          platform,
          paletteKey: args.paletteKey || 'purple',
          theme: { dark: false, bothModes: true, contrast: 'standard', shape: 'rounded', font: 'roboto', motion: 'expressive' },
          frames,
          groups: [
            {
              id: 'g_topbar',
              x: 0,
              y: 0,
              axis: 'x',
              items: [{ id: 'bar', kind: 'topAppBar', label: args.title || '主页', icon: 'menu', icon2: 'more_vert', variant: 'filled' }],
            },
            {
              id: 'g_card',
              x: 16,
              y: 104,
              axis: 'x',
              items: [{ id: 'card_main', kind: 'card', label: '欢迎使用', supporting: args.brief || '这里是内容卡片', size: 380, size2: 200, variant: 'elevated' }],
            },
            {
              id: 'g_nav',
              x: 0,
              y: isWeb ? 700 : 788,
              axis: 'x',
              items: [
                {
                  id: 'nav',
                  kind: isWeb ? 'navRail' : 'bottomNav',
                  label: '',
                  icon: null,
                  variant: 'filled',
                  selected: 0,
                  tabs: [{ icon: 'home', label: '首页' }, { icon: 'search', label: '发现' }, { icon: 'person', label: '我的' }],
                },
              ],
            },
          ],
        };
      }

      const jsonStr = JSON.stringify(doc, null, 2);
      const shareHash = encodeDocz(jsonStr);
      const shareUrl = `https://lnkiai.github.io/m3e-canvas/#docz=${shareHash}`;

      return {
        ok: true,
        output: `设计工程【${doc.title}】已生成！\n在线交互画板直达链接：${shareUrl}`,
        data: { doc, shareUrl },
        render: {
          type: 'markdown',
          content: `🎨 **M3E Canvas 原型生成成功！**\n\n- **应用名称：** \`${doc.title}\`\n- **平台模式：** ${doc.platform} · ${doc.paletteKey} 调色板\n- **屏幕数量：** ${doc.frames.length} 个页面\n- **交互画板链接：** [👉 点击立即在浏览器画板打开](${shareUrl})\n\n*(复制链接后可在任意浏览器直接拖拽编辑，支持转为 AI Coding 提示词)*`,
        },
      };
    } catch (err) {
      return { ok: false, output: `创建设计失败: ${err instanceof Error ? err.message : String(err)}`, error: 'create-error' };
    }
  },
};

// 2. 生成在线互动分享链接
const generateShareLinkTool = {
  name: 'm3e-canvas.generate_share_link',
  description: '将任意 M3E Canvas 设计文档 JSON，利用高效无头 deflateRaw 压缩算法编码为可直接打开并交互体验的在线官方画板网址（https://lnkiai.github.io/m3e-canvas/#docz=...）。',
  parameters: {
    type: 'object',
    properties: {
      docJson: {
        type: 'string',
        description: '设计工程的完整 JSON 字符串或对象',
      },
    },
    required: ['docJson'],
  },
  permissions: [],
  requiresApproval: false,

  async execute(args) {
    try {
      const raw = typeof args.docJson === 'string' ? args.docJson.trim() : JSON.stringify(args.docJson);
      const doc = JSON.parse(raw);
      const docz = encodeDocz(JSON.stringify(doc));
      const url = `https://lnkiai.github.io/m3e-canvas/#docz=${docz}`;
      return {
        ok: true,
        output: url,
        render: {
          type: 'markdown',
          content: `🔗 **在线画板链接已生成：**\n\n[${url}](${url})\n\n可在浏览器直接打开进行多屏交互、主题换色与拖拽调整！`,
        },
      };
    } catch (err) {
      return { ok: false, output: `生成链接失败: ${err instanceof Error ? err.message : String(err)}`, error: 'encode-error' };
    }
  },
};

// 3. 一键将设计原型工程、AI 编码提示词与快速启动入口直接投放至用户桌面
const exportToDesktopTool = {
  name: 'm3e-canvas.export_to_desktop',
  description: '【桌面一键直投】将当前 M3E 设计原型以 JSON 工程文件、一键浏览器直达 HTML 启动页，以及用于 Cursor/Claude Code/Codex 编程的 AI 提示词（Markdown）直接投放到当前 Windows 桌面上！',
  parameters: {
    type: 'object',
    properties: {
      templateKey: {
        type: 'string',
        enum: ['ecommerce', 'dashboard', 'chat'],
        description: '选择内置优质模版导出：ecommerce (商城)、dashboard (运维大屏)、chat (智能对话)',
      },
      customDocJson: {
        type: 'string',
        description: '可选：如果传入自定义设计文档 JSON，将优先导出该自定义设计',
      },
      subDirName: {
        type: 'string',
        description: '桌面存放文件夹名称，默认 "M3E-设计原型"',
      },
    },
  },
  permissions: ['fs:write'],
  requiresApproval: true,

  async execute(args) {
    try {
      let doc;
      if (args.customDocJson) {
        doc = typeof args.customDocJson === 'string' ? JSON.parse(args.customDocJson) : args.customDocJson;
      } else {
        const key = args.templateKey || 'ecommerce';
        doc = JSON.parse(JSON.stringify(TEMPLATES[key] || TEMPLATES.ecommerce));
      }

      const desktopDir = getDesktopPath();
      const folderName = String(args.subDirName || `${doc.title || 'M3E设计'}-原型产物`).replace(/[\\/:*?"<>|]+/g, '_');
      const outDir = path.join(desktopDir, folderName);
      await mkdir(outDir, { recursive: true });

      const jsonContent = JSON.stringify(doc, null, 2);
      const shareUrl = `https://lnkiai.github.io/m3e-canvas/#docz=${encodeDocz(jsonContent)}`;

      // 1. 保存 JSON 工程文件
      const jsonFile = path.join(outDir, 'project.json');
      await writeFile(jsonFile, jsonContent, 'utf-8');

      // 2. 保存一键跳转在线画板的 HTML 入口
      const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${doc.title} - M3E 在线画板</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; padding: 36px 40px; text-align: center; max-width: 480px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); backdrop-filter: blur(20px); }
    h1 { font-size: 24px; margin-bottom: 12px; color: #a855f7; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: 600; font-size: 15px; box-shadow: 0 8px 24px rgba(168, 85, 247, 0.4); transition: transform 0.2s; }
    .btn:hover { transform: translateY(-2px); }
    .tip { font-size: 12px; color: #64748b; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎨 ${doc.title}</h1>
    <p>${doc.brief || '基于 Google Material 3 Expressive 的高保真可交互原型'}</p>
    <a class="btn" href="${shareUrl}" target="_blank">🚀 立即在浏览器中打开原型</a>
    <div class="tip">💡 原型无需安装任何软件，包含多屏联动、平滑转场及 AI Prompt 提取</div>
  </div>
</body>
</html>`;
      const htmlFile = path.join(outDir, '一键打开在线画板.html');
      await writeFile(htmlFile, htmlContent, 'utf-8');

      // 3. 生成可直接喂给 AI 的 Vibe Coding 提示词 Markdown
      const promptMd = `# AI 编程提示词：${doc.title}

> 本提示词由 M3E Canvas 智能提取，可直接复制提供给 Claude Code / Cursor / Codex 等 AI 工具进行自动编码。

## 应用定位与目标
- **应用名称**：${doc.title}
- **核心功能简述**：${doc.brief}
- **目标平台**：${doc.platform} (${doc.platform === 'web' ? '1280x800 响应式网页' : '412x892 现代移动端 App'})
- **视觉风格**：Material 3 Expressive（${doc.paletteKey} 调色板，${doc.theme?.shape || 'rounded'} 圆角规范，开启动态弹簧手势动画）

## 屏幕结构与交互逻辑清单
${doc.frames.map((f, i) => `${i + 1}. **【${f.name}】**(ID: \`${f.id}\`): ${f.note || '核心业务展示'}`).join('\n')}

## 在线可交互原型直达体验
[点击在浏览器打开 M3E 原型](${shareUrl})

## 编码技术栈建议
- **移动端**：Flutter / Jetpack Compose / React Native + Material 3 组件库
- **Web 端**：Next.js / React + Tailwind CSS + Radix UI / Material UI
`;
      const promptFile = path.join(outDir, 'AI编程提示词(VibeCoding).md');
      await writeFile(promptFile, promptMd, 'utf-8');

      return {
        ok: true,
        output: `已成功在桌面生成设计全套资产目录：${outDir}`,
        render: {
          type: 'markdown',
          content: `🎉 **M3E 原型全套资产已成功投放至桌面！**\n\n- **桌面文件夹：** \`${outDir}\`\n- **包含产物：**\n  1. \`一键打开在线画板.html\` (双击直接在浏览器里玩原型交互)\n  2. \`AI编程提示词(VibeCoding).md\` (包含结构化 Prompt，可直接丢给 AI 写代码)\n  3. \`project.json\` (M3E 原始工程数据，随时可二次导入)\n- **在线画板直达：** [👉 立即体验在线画板](${shareUrl})`,
        },
      };
    } catch (err) {
      return { ok: false, output: `导出桌面失败: ${err instanceof Error ? err.message : String(err)}`, error: 'export-error' };
    }
  },
};

// 4. 原型模板库清单查询工具
const designTemplateTool = {
  name: 'm3e-canvas.design_template',
  description: '查询并获取 M3E Canvas 内置的精选场景模版列表（电商、运维大屏、AI对话助手等）。',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'ecommerce', 'dashboard', 'chat'],
        description: '查询分类，默认 all',
      },
    },
    required: [],
  },
  permissions: [],
  requiresApproval: false,

  async execute(args) {
    const list = Object.entries(TEMPLATES).map(([key, t]) => ({
      key,
      title: t.title,
      brief: t.brief,
      platform: t.platform,
      screens: t.frames.map((f) => f.name).join(' -> '),
    }));
    return {
      ok: true,
      output: JSON.stringify(list, null, 2),
      render: {
        type: 'markdown',
        content: `📋 **M3E Canvas 精选模版库：**\n\n` + list.map((item) => `- **${item.title}** (\`${item.key}\`)\n  - 说明：${item.brief}\n  - 平台：\`${item.platform}\` | 屏幕流：${item.screens}`).join('\n\n'),
      },
    };
  },
};

export const plugin = {
  tools: [
    createDesignTool,
    generateShareLinkTool,
    exportToDesktopTool,
    designTemplateTool,
  ],
};
