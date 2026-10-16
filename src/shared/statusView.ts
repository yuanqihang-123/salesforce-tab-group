import { t } from "./i18n";
import type { Status } from "./messaging/contracts";
import { el, renderStable } from "./ui";
export const reasonLabels: Record<string, string> = {
  "marker-removed": "已移除管理标记",
  "released-group": "已放弃管理的组",
  pinned: "已固定",
  "protected-group": "用户或未认领的组",
  "shared-group": "共享组",
  "split-view": "Split View",
  "manual-override": "已手动排除",
  "excluded-tenant": "已暂停的 tenant",
  recovering: "恢复中",
  "recovery-timeout": "恢复超过 60 秒，等待 URL",
  "pending-navigation": "导航尚未提交",
  "url-unavailable": "URL 暂不可读或内部页面",
  "transient-grace": "瞬态页面等待期",
  "unsupported-domain": "不支持的 Salesforce 域名",
  "unsafe-url": "不符合 HTTPS 安全规则",
  "ambiguous-legacy-sandbox": "旧 sandbox 格式有歧义",
  "unknown-partition-or-subdomain": "未知分区或额外子域",
  "unverified-domain-template": "域名模板未验证",
  "invalid-sandbox-label": "sandbox label 不完整",
  "invalid-domain-label": "域名 label 无效",
  "token-conflict": "管理标记重复",
  "mixed-membership": "成员身份冲突，已放弃管理",
  "manual-regroup": "手动移入其他组",
  "api-retry": "浏览器暂不可编辑，稍后重试",
  "ambiguous-journal": "中断操作无法唯一确认，保持保护",
  detached: "标签页正在移动",
  "excluded-window": "非普通或隐身窗口",
  "reconcile-budget": "待继续协调",
};
export function renderStatus(container: HTMLElement, status: Status) {
  const r = status.runtime,
    s = status.settings;
  const degraded =
    status.degraded ||
    r?.degraded ||
    r?.reasons["recovery-timeout"] ||
    r?.reasons["ambiguous-journal"];
  const recovering = r?.bindings.some((b) => b.status === "recovering");
  const label = degraded
    ? t("降级 · 部分操作已停止")
    : !s
      ? t("无法读取设置")
      : !s.autoGroupingEnabled
        ? t("自动分组已关闭")
        : recovering
          ? t("恢复中")
          : t("自动分组已开启");
  const groups = r?.bindings.filter((b) => b.status === "verified").length ?? 0;
  const overrides = Object.keys(r?.overrides ?? {}).length;
  const reasons = Object.entries(r?.reasons ?? {}).filter(([, count]) => count);
  renderStable(
    container,
    { label, groups, overrides, reasons },
    () => {
      const open = container.querySelector("details")?.open ?? false;
      container.replaceChildren();
      const badge = el(
        "div",
        label,
        "status " +
          (degraded ? "warning" : s?.autoGroupingEnabled ? "on" : "off"),
      );
      badge.setAttribute("role", "status");
      container.append(badge);
      container.append(
        el(
          "p",
          t("{p0} 个管理组 · {p1} 个手动排除", { p0: groups, p1: overrides }),
          "status-metrics",
        ),
      );
      if (degraded)
        container.append(
          el(
            "p",
            t(
              "存储、权限或恢复存在异常。已有用户状态受到保护；检查下方原因后再处理。",
            ),
            "notice",
          ),
        );
      if (reasons.length) {
        const details = el("details", undefined, "status-details");
        details.open = open;
        const summary = el("summary", t("查看处理详情"));
        summary.dataset.focusKey = "status-details";
        const list = el("dl");
        for (const [reason, count] of reasons) {
          list.append(
            el("dt", t(reasonLabels[reason] ?? reason)),
            el("dd", String(count)),
          );
        }
        details.append(summary, list);
        container.append(details);
      }
    },
    document.querySelector<HTMLElement>("#enabled") ?? undefined,
  );
}
