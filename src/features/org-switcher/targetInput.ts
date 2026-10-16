import {
  switchTargetSchema,
  type SwitchTarget,
} from "../../shared/models/settings";
import { parseSalesforceUrl } from "../../shared/salesforce/urlParser";

export interface TargetInput {
  id: string;
  label: string;
  origins: SwitchTarget["origins"];
}

export function parseTargetInput(input: TargetInput): SwitchTarget {
  const origins = Object.fromEntries(
    Object.entries(input.origins)
      .map(([surface, origin]) => [surface, origin?.trim() ?? ""] as const)
      .filter(([, origin]) => origin),
  );
  const first = Object.values(origins)[0];
  if (!first) throw new Error("请至少配置一个 origin。");
  const parsed = parseSalesforceUrl(first);
  const result = switchTargetSchema.safeParse({
    ...input,
    origins,
    tenantKey: parsed.kind === "supported" ? parsed.tenantKey : undefined,
  });
  if (!result.success) {
    const invalidOrigin = result.error.issues.some(
      (issue) =>
        issue.path.length === 0 ||
        ["tenantKey", "origins"].includes(String(issue.path[0])),
    );
    throw new Error(
      invalidOrigin
        ? "请填写同一个 tenant 的精确 HTTPS origin，不含路径或末尾斜线。"
        : "配置未通过校验，请检查 tenant、origin 和字段格式。",
    );
  }
  return result.data;
}
