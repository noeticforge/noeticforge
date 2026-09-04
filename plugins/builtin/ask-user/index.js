const chooseTool = {
  name: 'ask-user.choose',
  description: '【交互决策工具】当遇到技术选型、架构设计、多种可行实现方案、需要用户确认下一步走向或澄清不确定需求时，必须调用此工具。它会向用户弹出包含 A/B/C/D 选项卡片的交互对话框，支持快捷键选择与自由文本补充。',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '需要用户决策的核心问题或技术决策点（如：请选择接下来的重构技术方案）',
      },
      description: {
        type: 'string',
        description: '决策的背景说明、当前上下文或面临的权衡分析',
      },
      rationale: {
        type: 'string',
        description: 'AI 的专业推荐理由（例如：推荐选项 A，因为性能最高且向后兼容）',
      },
      options: {
        type: 'array',
        description: '提供给用户选择的选项列表（通常为 2-4 个，如 A/B/C/D）',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '选项标识符，如 A, B, C, D',
            },
            label: {
              type: 'string',
              description: '选项标题或方案简短名称',
            },
            description: {
              type: 'string',
              description: '该方案的详细优缺点、实现细节或影响说明',
            },
            recommended: {
              type: 'boolean',
              description: '是否为 AI 推荐的最佳选项（推荐项将在界面带有高亮徽章）',
            },
          },
          required: ['id', 'label'],
        },
      },
    },
    required: ['question', 'options'],
  },
  permissions: [],
  requiresApproval: true,

  async execute(args) {
    const selectedId = args?.selectedId || 'A';
    const selectedLabel = args?.selectedLabel || '';
    const feedback = args?.userFeedback ? `\n用户补充说明：${args.userFeedback}` : '';
    const output = `用户已完成决策，选择了选项【${selectedId}】${selectedLabel ? `（${selectedLabel}）` : ''}。${feedback}\n请严格按照用户的该项决策继续执行后续任务。`;
    return {
      ok: true,
      output,
      render: {
        type: 'markdown',
        content: `> **💡 用户决策结果：** 选择了 **${selectedId} - ${selectedLabel}**${feedback ? `\n> 补充意见：*${args.userFeedback}*` : ''}`,
      },
    };
  },
};

export const plugin = {
  tools: [chooseTool],
};
