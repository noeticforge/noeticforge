import { Ajv, type ValidateFunction } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * 参数 Schema 校验：模型的原始参数、用户审批时修改过的参数，执行前都必须过这一关。
 * 返回 null 表示合法；返回字符串为可读的错误描述（会原样进 ToolResult.output 喂回模型）。
 */
export function validateArguments(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema || Object.keys(schema).length === 0) return null; // 无 schema = 不约束
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema) as ValidateFunction;
  } catch (err) {
    return `工具的 parameters Schema 本身无效: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (validate(args)) return null;
  const errors = (validate.errors ?? [])
    .map((e: { instancePath?: string; message?: string }) => `${e.instancePath || '(根)'} ${e.message ?? '校验失败'}`)
    .join('; ');
  return errors || '参数不符合 Schema';
}
