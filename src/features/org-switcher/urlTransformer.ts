import {
  parseSalesforceUrl,
  type Surface,
} from "../../shared/salesforce/urlParser";
import {
  switchTargetSchema,
  type SwitchTarget,
} from "../../shared/models/settings";
export interface TransformResult {
  url: string;
  recordWarning: boolean;
  environment: string;
}
const blocked =
  /(?:^|\/)(?:frontdoor\.jsp|oauth2?|saml|sso|login|secur|idp)(?:\/|\.|$)/i;
export function transformUrl(
  source: string,
  target: SwitchTarget,
  home = false,
  homeSurface?: Exclude<Surface, "experience">,
): TransformResult {
  switchTargetSchema.parse(target);
  const parsed = parseSalesforceUrl(source);
  const current = new URL(source);
  if (
    !home &&
    (parsed.kind !== "supported" ||
      parsed.surface === "experience" ||
      blocked.test(current.pathname))
  )
    throw new Error("此页面不能直接保留路径，请明确选择目标首页。");
  const surface = home
    ? (homeSurface ?? "lightning")
    : parsed.kind === "supported"
      ? parsed.surface
      : "lightning";
  if (surface === "experience")
    throw new Error("Experience Cloud 不支持路径切换");
  const origin = target.origins[surface];
  if (!origin)
    throw new Error(`请先配置 ${surface} origin，或选择已配置的目标首页。`);
  const output = new URL(origin);
  if (!home) {
    // Only explicitly tested Salesforce application routes are portable.
    if (
      !/^\/(?:lightning\/(?:page\/home|o\/[A-Za-z0-9_]+\/(?:list|home)|r\/[A-Za-z0-9_]+\/[A-Za-z0-9]{15,18}\/view|setup\/[A-Za-z0-9_/]+)|[A-Za-z0-9]{15,18})\/?$/.test(
        current.pathname,
      ) &&
      current.pathname !== "/"
    )
      throw new Error("此路径尚未列入支持范围，请选择目标首页。");
    output.pathname = current.pathname;
    // V1 query allowlist: named list views only; no IDs or arbitrary values.
    if (/^\/lightning\/o\/[A-Za-z0-9_]+\/list\/?$/.test(current.pathname)) {
      const filter = current.searchParams.get("filterName");
      if (filter && /^(?:Recent|All|[A-Za-z][A-Za-z0-9_]{0,79})$/.test(filter))
        output.searchParams.set("filterName", filter);
    }
  }
  return {
    url: output.href,
    recordWarning:
      !home &&
      /^\/(?:lightning\/r\/|[A-Za-z0-9]{15,18}(?:\/|$))/.test(current.pathname),
    environment: "unknown",
  };
}
