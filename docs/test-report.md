# 实际测试记录

日期：2026-10-16（Asia/Singapore）。扩展版本：1.0.0。

本记录区分实现验证与发布验收：已生成可加载的 MV3 发行包，但尚未完成规格要求的全部真实 Chrome/跨平台验收，不宣称全部 FR/AC 已验收。

## 已执行的自动化验证

- TypeScript strict 类型检查、ESLint、Prettier、生产构建通过。
- Vitest 11 个测试文件、142 个测试场景通过，覆盖 28 个支持模板与欺骗/旧域名/IDN 等反例、最小差异 planner、token 归属与恢复、手动排除、主动切换及敏感参数移除。
- 结构重构新增 19 项运行时回归：消息发送方与严格字段校验、客户端错误传递、并发设置的原子更新、启动入队顺序、恢复管理与开关命令串行、跨窗口移动，以及共享规则下的目标表单解析。另有编译期断言验证请求与响应类型关联，拒绝无效字段和任意指定返回类型。
- 模拟 Chrome 会产生原生事件回声、标签连续布局及空组消失。验证 30 个同 tenant 并发标签页只建一个组，稳定后 100 次重复事件零分组/取消分组/外观写入，且无 local 写循环。
- 对创建路径实际经过的 storage/API 前后边界逐个注入 worker 中断，保留 session 重建后台，检查无重复创建、无错误接管。额外覆盖过期 journal、创建完成前用户改组/混入成员/shared 状态、最后一次 await 期间进入 Split View 等情况。
- 重试按 250ms/1s/3s 执行，重复无变化事件不重置退避，新事实可提前重试；空闲时停止定时器/快照写循环。存储损坏/不可写及 bootstrap 异常会停止自动变更并保留原始数据。
- 12 个固定种子的 420 步生成事件轨迹，检查用户组成员/外观、pinned、active 和窗口位置保持；5 窗口 500 tabs 的模拟场景最终形成 20 个管理组，重复协调零新增写入。这些结果不替代真实浏览器性能测量。

执行入口：`pnpm check`、`pnpm format:check`。源码测试位于 `tests/`。

## 真实 Chromium 集成

环境：macOS 26.7.1，arm64；Playwright Chromium 151.0.7922.34，headless，独立临时 profile。测试使用强制离线、禁用 DNS 和 HTTP(S) fixture 拦截，不连接 Salesforce，不使用真实客户 org。测试结束后删除临时 profile。

实际结果与耗时见 [结构化结果](chromium-result.json)。测试入口：`pnpm test:e2e`。

| 场景                                                              | 实际结果                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 3 个普通窗口，60 个 Salesforce tabs + 20 个其他网页，未打开 popup | 自动形成 9 个管理组，其他网页未分组；具体耗时与 API 次数见 JSON                                                  |
| Chrome 原生取消分组                                               | 写入 session 手动排除，不抢回                                                                                    |
| 设置页恢复管理、关闭/开启开关                                     | 恢复生效，关闭清除 alarm 且不分组新 tab，重开扫描生效                                                            |
| 稳定空闲状态                                                      | 分组、外观、local/session 写入均停止                                                                             |
| 10 次单 tab 增量                                                  | JSON 记录全部样本及 P95；计时包含创建与提交，以 100ms 轮询观察完成，属于当前离线测试环境的样本，不是平台实时保证 |
| popup/options                                                     | MV3 CSP 下正常呈现，目标配置及 tenant 偏好保存生效，无页面脚本错误                                               |
| 主动 production 切换                                              | 展示最终 URL 和 production 标注，确认前禁用执行按钮，确认后导航所选标签页                                        |
| 空闲后实际停止并重启 service worker                               | 手动排除保留，未抢回对应 tab                                                                                     |

测试使用 CDP 控制并观测 worker；手动停止不等于关闭 DevTools 后的自然休眠。此 Chromium 测试既不代表 Chrome 120，也不代表发布时 Chrome 稳定版或 Windows 已通过。

重构期间，一次中间构建在 worker 重启后的状态等待超时，根因未确认。最终源码重新构建后完整集成测试通过；重启用例补充等待待处理窗口和操作 journal 清空，并在失败时输出扩展页面的状态与提示，随后完整回归再次通过。操作途中中断的恢复仍由逐 storage/API 边界的故障注入测试验证。

截图在运行测试后生成于 `test-results/options.png` 和 `test-results/popup.png`；完整原始 JSON 同时生成于 `test-results/chromium.json`。

## 界面与键盘重构回归

2026-10-16 在同一 macOS / Chromium 151 离线环境完成。`pnpm check`、`pnpm format:check`、原有 8 组 Chromium 集成场景及新增 13 组界面回归全部通过，无扩展页面脚本错误。界面回归的保存与切换调用真实 MV3 worker；仅对部分真实响应延迟交付，用于稳定复现重复提交和过时预览。

- 原生 Enter 保存仅提交一次；编辑取消回到原按钮；后台刷新保留未保存输入与列表焦点；另一页面删除正在编辑的目标会退出失效编辑态。
- 下拉框的 Escape 保留原生菜单行为，不取消整张偏好表单；恢复手动排除后焦点移到相邻操作，最后一项恢复后移到本节；最后一个状态原因消失后焦点回到自动分组开关。
- 自动分组开关保持所选目标；首页类型仅列出已配置的 surface；迟到的旧预览不显示；设置更新使预览失效；Escape 取消预览并回到原按钮。
- production 必须通过 Space 勾选确认，再 Tab / Enter 明确执行；真实标签页导航到目标 origin。常规 URL 的核对步骤在 360 × 600 视窗内可见确认控件；长目标名及 URL 不产生横向溢出。
- 目视复核桌面浅色设置、360px 深色设置和深色核对步骤；检查可读层级、换行、焦点环与表单反馈。

执行入口：`pnpm test:ui`；`pnpm test:e2e` 同时执行原有后台集成与界面回归。完整结果见 [界面回归 JSON](ui-result.json)。截图在 `test-results/ui-options.png`、`ui-options-mobile.png`、`ui-popup.png`、`ui-popup-preview.png`。

测试将 popup 页面加载在浏览器标签页内，以获得稳定的真实键盘输入。尚未覆盖原生 action 弹窗框架、Chrome 120、Windows、真实输入法候选窗和 VoiceOver / NVDA；这些项目已列入手工验收，不将事件保护代码视为平台输入法验收。

## 发行包检查

`pnpm build` 自动执行 `scripts/audit.mjs`：共 13 个发行文件，入口为 `background.js`、`popup/index.html` 和 `options/index.html`；图标及引用资源存在。

权限严格为 tabs、tabGroups、storage、alarms；无 host permissions、content script、远程脚本、后端/遥测请求代码、eval/动态 Function 或开发服务器/HMR。使用 `zod/v3` 的解释执行验证器，避免运行时动态代码生成；Chrome 120 原生支持模块预加载，构建关闭其兼容 polyfill。

## 尚未执行的发布验收

- Chrome 120、发布时 Chrome 稳定版，以及 Windows/macOS 可见窗口的完整核心验收。
- 真正退出浏览器后的 session restore、保存/同步组恢复、持续 60 秒的延迟恢复。
- 关闭 DevTools 后的自然 worker 休眠、真实鼠标拖拽/折叠行为、其他扩展共存、真实权限撤销与存储配额故障。
- 真实 5 窗口 500 tabs 的 ≤10 秒目标，以及更大样本的性能分布。
- 授权 Salesforce 测试 org 中的实际登录跳转、record/Flow/权限差异。

逐项步骤和待验收标记见 [手工验收清单](manual-acceptance.md)。

## Inspector host 归组回归（2026-10-16）

`pnpm check` 通过，12 个测试文件、168 项测试；变更文件 Prettier 检查通过。新增 22 项 Inspector URL 校验，覆盖 inspect/export/import/API 工具页、3 个扩展 ID，以及缺失/重复/恶意 host、非工具页和无关扩展的拒绝。协调器回归复现现有管理组插入 Inspector 成员后仍保留归属、新工具与 Salesforce 页面继续复用同组、worker 重启恢复、重复扫描零写入、Inspector host 改变后转入对应环境组。

`pnpm test:e2e` 的 8 组后台集成和 14 组界面回归通过，无扩展脚本错误。沙箱内测试浏览器首次启动失败，获准在沙箱外以独立离线 profile 重跑后通过；这些集成场景验证既有行为，Inspector 特定路径由上述新增测试覆盖。

真实 Chrome 当前 profile 手工验收：用户确认旧同步组删除影响后，保留 6 个现存标签重建 `uatpes`，逐一恢复自动管理。界面确认仅 1 个 `uatpes` 组、含 6 个标签（含 4 个 Inspector 工具页），状态为 1 个管理组、0 个手动排除。新建同 host 的临时 Inspector Data Export 页自动进入该组（变为 7 个标签），关闭临时页后仍为同一组的原 6 个标签；未执行导出查询。
