import { readFile, writeFile, appendFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const MAX_READ_CHARS = 200_000;

function getDesktopPath() {
  const home = os.homedir();
  const winDesktop = path.join(home, 'Desktop');
  if (existsSync(winDesktop)) return winDesktop;
  const zhDesktop = path.join(home, '桌面');
  if (existsSync(zhDesktop)) return zhDesktop;
  return winDesktop;
}

// 1. 全盘文件读取与目录扫描
const fsReadTool = {
  name: 'system-master.fs_read',
  description: '读取电脑任意盘符（C盘、D盘、E盘等）的文件内容，或扫描任意目录的文件列表。支持绝对路径与相对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目标文件或文件夹的绝对路径（如 C:\\Users\\... 或 E:\\...）',
      },
      lineLimit: {
        type: 'number',
        description: '读取文本文件时的最大行数（默认不限，超过截断）',
      },
    },
    required: ['path'],
  },
  permissions: ['fs:read'],
  requiresApproval: false,

  async execute(args, ctx) {
    try {
      const rawPath = String(args.path || '').trim();
      if (!rawPath) return { ok: false, output: '错误：路径不能为空', error: 'empty-path' };
      const targetPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx?.workingDir || process.cwd(), rawPath);
      if (!existsSync(targetPath)) {
        return { ok: false, output: `错误：路径不存在 -> ${targetPath}`, error: 'not-found' };
      }

      const st = await stat(targetPath);
      if (st.isDirectory()) {
        const entries = await readdir(targetPath, { withFileTypes: true });
        const list = entries.map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`);
        return {
          ok: true,
          output: `目录列表 (${targetPath}) 共 ${list.length} 项：\n` + list.slice(0, 100).join('\n') + (list.length > 100 ? `\n...其余 ${list.length - 100} 项已折叠` : ''),
          render: {
            type: 'markdown',
            content: `📁 **目录扫描：** \`${targetPath}\` (共 ${list.length} 项)\n\`\`\`\n${list.slice(0, 50).join('\n')}${list.length > 50 ? '\n...(已截断)' : ''}\n\`\`\``,
          },
        };
      }

      const content = await readFile(targetPath, 'utf-8');
      const truncated = content.length > MAX_READ_CHARS ? content.slice(0, MAX_READ_CHARS) + `\n...（已截断，总长度 ${content.length} 字符）` : content;
      return {
        ok: true,
        output: truncated,
        render: {
          type: 'markdown',
          content: `📄 **文件读取完成：** \`${targetPath}\` (${content.length} 字符)\n\`\`\`\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}\n\`\`\``,
        },
      };
    } catch (err) {
      return { ok: false, output: `读取失败: ${err instanceof Error ? err.message : String(err)}`, error: 'read-error' };
    }
  },
};

// 2. 全盘文件写入与修改（自动建立父级目录）
const fsWriteTool = {
  name: 'system-master.fs_write',
  description: '在电脑的任意位置创建或修改文件（支持覆盖或追加模式）。若父级文件夹不存在，将自动递归创建。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要写入的完整文件路径（如 C:\\test\\data.txt）',
      },
      content: {
        type: 'string',
        description: '写入的文件内容',
      },
      append: {
        type: 'boolean',
        description: '是否为追加模式（默认 false 为覆盖写入，true 为追加到文件末尾）',
      },
    },
    required: ['path', 'content'],
  },
  permissions: ['fs:write'],
  requiresApproval: true, // 写入操作保障用户知情权

  async execute(args, ctx) {
    try {
      const rawPath = String(args.path || '').trim();
      const content = String(args.content ?? '');
      const append = Boolean(args.append);
      if (!rawPath) return { ok: false, output: '错误：目标路径不能为空', error: 'empty-path' };

      const targetPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx?.workingDir || process.cwd(), rawPath);
      const parentDir = path.dirname(targetPath);
      await mkdir(parentDir, { recursive: true });

      if (append) {
        await appendFile(targetPath, content, 'utf-8');
      } else {
        await writeFile(targetPath, content, 'utf-8');
      }

      return {
        ok: true,
        output: `成功写入文件 -> ${targetPath} (${content.length} 字符，模式: ${append ? '追加' : '覆盖'})`,
        render: {
          type: 'markdown',
          content: `✅ **文件保存成功**\n- **路径：** \`${targetPath}\`\n- **写入模式：** ${append ? '追加' : '覆盖'}\n- **大小：** ${content.length} 字符`,
        },
      };
    } catch (err) {
      return { ok: false, output: `写入失败: ${err instanceof Error ? err.message : String(err)}`, error: 'write-error' };
    }
  },
};

// 3. 桌面一键直投文件生成器
const desktopCreateTool = {
  name: 'system-master.desktop_create',
  description: '一键将文件/报告/生成结果直接放置到当前用户的 Windows 桌面上，支持多种格式（.txt, .md, .bat, .json, .html 等）。',
  parameters: {
    type: 'object',
    properties: {
      fileName: {
        type: 'string',
        description: '放置在桌面的文件名（例如：分析报告.md、备忘录.txt）',
      },
      content: {
        type: 'string',
        description: '文件的完整文本内容',
      },
    },
    required: ['fileName', 'content'],
  },
  permissions: ['fs:write'],
  requiresApproval: true,

  async execute(args) {
    try {
      const fileName = String(args.fileName || 'desktop-output.txt').trim();
      const content = String(args.content ?? '');
      const desktopDir = getDesktopPath();
      const targetPath = path.join(desktopDir, fileName);

      await writeFile(targetPath, content, 'utf-8');

      return {
        ok: true,
        output: `文件已成功生成并直投至桌面：${targetPath}`,
        render: {
          type: 'markdown',
          content: `🖥️ **桌面直投成功！**\n\n已为您在桌面创建文件：\n- **文件名：** \`${fileName}\`\n- **完整路径：** \`${targetPath}\`\n- **大小：** ${content.length} 字符`,
        },
      };
    } catch (err) {
      return { ok: false, output: `桌面投放失败: ${err instanceof Error ? err.message : String(err)}`, error: 'desktop-error' };
    }
  },
};

// 4. 全能终端命令指挥执行工具
const execCommandTool = {
  name: 'system-master.exec_command',
  description: '以系统权限在命令行终端中执行任意系统命令，支持 PowerShell、CMD 或 Bash 命令，适用于网络测试、环境诊断、自动化运维等。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '需要执行的命令行脚本或指令（例如：ipconfig /all、tasklist、dir 等）',
      },
      cwd: {
        type: 'string',
        description: '命令执行的工作目录（可选，默认当前项目目录）',
      },
      timeoutMs: {
        type: 'number',
        description: '最长执行等待毫秒数，默认 30000（30秒）',
      },
    },
    required: ['command'],
  },
  permissions: ['shell:exec'],
  requiresApproval: true, // 命令行执行强制审批保障安全

  async execute(args, ctx) {
    try {
      const cmd = String(args.command || '').trim();
      if (!cmd) return { ok: false, output: '命令不能为空', error: 'empty-command' };

      const execCwd = args.cwd ? (path.isAbsolute(args.cwd) ? args.cwd : path.resolve(ctx?.workingDir || process.cwd(), args.cwd)) : ctx?.workingDir || process.cwd();
      const timeout = Number(args.timeoutMs) || 30_000;

      // 在 Windows 优先使用 powershell 执行以支持丰富系统 cmdlet
      const isWin = process.platform === 'win32';
      const shellCmd = isWin ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '\\"')}"` : cmd;

      const { stdout, stderr } = await execAsync(shellCmd, {
        cwd: execCwd,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      });

      const outputText = [stdout ? stdout.trim() : '', stderr ? `[STDERR]:\n${stderr.trim()}` : ''].filter(Boolean).join('\n\n') || '(执行完毕，无文本输出)';

      return {
        ok: true,
        output: outputText,
        render: {
          type: 'markdown',
          content: `💻 **终端执行成功：** \`${cmd}\`\n\`\`\`powershell\n${outputText.slice(0, 1000)}${outputText.length > 1000 ? '\n...(更多已截断)' : ''}\n\`\`\``,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        output: `命令执行失败/超时: ${msg}`,
        error: 'exec-error',
      };
    }
  },
};

// 5. 电脑整机状态与硬件信息一键全景扫描
const sysOverviewTool = {
  name: 'system-master.sys_overview',
  description: '扫描当前电脑的硬件资源、操作系统版本、CPU 型号与核心数、内存使用率、磁盘驱动器盘符清单与运行时间。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  permissions: [],
  requiresApproval: false,

  async execute() {
    try {
      const totalMemGb = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
      const freeMemGb = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
      const usedMemGb = (totalMemGb - freeMemGb).toFixed(2);
      const memUsagePercent = ((usedMemGb / totalMemGb) * 100).toFixed(1);
      const cpus = os.cpus();
      const cpuModel = cpus[0]?.model || '未知 CPU';
      const cpuCores = cpus.length;
      const uptimeHours = (os.uptime() / 3600).toFixed(1);
      const platform = `${os.type()} ${os.release()} (${os.arch()})`;
      const hostname = os.hostname();
      const desktop = getDesktopPath();

      let driveInfo = '无法检测';
      if (process.platform === 'win32') {
        try {
          const { stdout } = await execAsync('powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free, Root | ConvertTo-Json -Compress"');
          driveInfo = stdout.trim();
        } catch {}
      }

      const summary = [
        `主机名: ${hostname}`,
        `操作系统: ${platform}`,
        `处理器: ${cpuModel} (${cpuCores} 核心)`,
        `内存情况: 已用 ${usedMemGb} GB / 总共 ${totalMemGb} GB (使用率 ${memUsagePercent}%)`,
        `系统开机时间: ${uptimeHours} 小时`,
        `桌面路径: ${desktop}`,
      ].join('\n');

      return {
        ok: true,
        output: `系统全景信息：\n${summary}\n\n磁盘驱动器状态：\n${driveInfo}`,
        render: {
          type: 'markdown',
          content: `🖥️ **电脑状态全景扫描：**\n\n| 项目 | 详情 |\n|---|---|\n| **主机名** | \`${hostname}\` |\n| **操作系统** | \`${platform}\` |\n| **处理器** | ${cpuModel} (${cpuCores} 核) |\n| **内存** | 已用 **${usedMemGb} GB** / ${totalMemGb} GB (${memUsagePercent}%) |\n| **运行时间** | ${uptimeHours} 小时 |\n| **桌面路径** | \`${desktop}\` |`,
        },
      };
    } catch (err) {
      return { ok: false, output: `获取系统信息失败: ${err instanceof Error ? err.message : String(err)}`, error: 'sysinfo-error' };
    }
  },
};

export const plugin = {
  tools: [
    fsReadTool,
    fsWriteTool,
    desktopCreateTool,
    execCommandTool,
    sysOverviewTool,
  ],
};
