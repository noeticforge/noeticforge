const THEMES_INFO = {
  'silver-glass': {
    name: '银渐层流光透明玻璃 (Silver Liquid Glass)',
    desc: '深蓝灰深邃暗底 + 银白流光反光微光 + 28px 高通透毛玻璃 + 极光银紫点缀。沉浸感拉满，通透明晰。',
    cssClass: 'theme-silver-glass',
    tone: '深邃高冷 / 银色流光 / 科技透明',
    contrast: '纯白文字 #f8fafd + 浅蓝次级字，黑白分明',
  },
  'parchment': {
    name: '古典羊皮卷米白色 (Parchment Vintage)',
    desc: '温润古籍羊皮纸米黄色底衬 + 深胡桃棕黑字 + 皮革印泥火漆金点缀。护眼温和，质感浓郁。',
    cssClass: 'theme-parchment',
    tone: '温润古典 / 暖米黄 / 复古书籍',
    contrast: '深胡桃黑 #271c10，极高对比度不累眼',
  },
  'handdrawn': {
    name: '素描手绘米白质感 (Hand-Drawn Sketch)',
    desc: '温暖素描纸米白质地 + 铅笔速写纯墨色线条与文字 + 铅笔蓝重点标注。手账画册风格，清晰整洁。',
    cssClass: 'theme-handdrawn',
    tone: '文创手绘 / 极简白卡 / 素描墨黑',
    contrast: '速写纯墨 #0f1115，极度清晰利落',
  },
  'pixel': {
    name: '复古赛博像素 8-Bit (Retro Pixel Cyber)',
    desc: '纯黑街机底色 + 经典 CRT 荧光像素电光绿 (#38ffaa) + 霓虹青蓝发光边框。高对比硬核极客风。',
    cssClass: 'theme-pixel',
    tone: '复古街机 / 纯黑暗底 / 荧光绿赛博',
    contrast: 'CRT 极光绿与深黑对比度达 18:1，暗光环境一目了然',
  },
};

const switchThemeTool = {
  name: 'theme-customizer.switch_theme',
  description: '查询或选择切换当前软件的主题风格。支持 4 款何惜专属主题：silver-glass (银渐层玻璃)、parchment (羊皮卷米白)、handdrawn (手绘米白)、pixel (复古像素)。',
  parameters: {
    type: 'object',
    properties: {
      themeKey: {
        type: 'string',
        enum: ['silver-glass', 'parchment', 'handdrawn', 'pixel', 'list'],
        description: '要切换的主题代码：silver-glass(银渐层玻璃), parchment(羊皮卷米白), handdrawn(手绘米白), pixel(复古像素), list(仅查看色卡列表)',
      },
    },
    required: ['themeKey'],
  },
  permissions: [],
  requiresApproval: false,

  async execute(args) {
    const key = String(args.themeKey || 'list').toLowerCase();
    if (key === 'list' || !THEMES_INFO[key]) {
      const items = Object.entries(THEMES_INFO).map(([k, v]) => `### 🎨 【${v.name}】(\`${k}\`)\n- **基调风格：** ${v.tone}\n- **可读性对比：** ${v.contrast}\n- **材质说明：** ${v.desc}\n- **切换方法：** 在软件「设置」->「外观」中点击该卡片，或直接回复我切换指令。`).join('\n\n');
      return {
        ok: true,
        output: '当前已加载 4 款专属艺术主题：\n' + Object.keys(THEMES_INFO).join(', '),
        render: {
          type: 'markdown',
          content: `# 🎨 何惜专属高质感艺术主题库\n\n${items}`,
        },
      };
    }

    const t = THEMES_INFO[key];
    return {
      ok: true,
      output: `已为您选中主题：${t.name} (class: ${t.cssClass})。\n您可以直接点击界面「设置」->「外观」选择该主题，页面会立即变换为该视觉质感！`,
      render: {
        type: 'markdown',
        content: `✨ **主题选择指引：**\n\n已定位到 **${t.name}**！\n- **基调：** ${t.tone}\n- **文字辨识度：** ${t.contrast}\n\n👉 **生效方式：** 打开「设置」->「外观」点击 **【${t.name.split(' ')[0]}】** 即可实时切换并永久持久化！`,
      },
    };
  },
};

export const plugin = {
  tools: [switchThemeTool],
};
