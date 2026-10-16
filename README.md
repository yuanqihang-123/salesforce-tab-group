# Salesforce  Tab Group

Chrome Manifest V3 扩展：后台自动将受支持的 Salesforce 标签页按 tenant 分组。同一 tenant 在每个普通窗口建立独立管理组，无需打开 popup，也无需插件账号。产品与验收基线见 [规格文档](SF-Org-Navigator-Auto-Salesforce-Tab-Grouping-Specification.md)。

## 开发与加载

使用 `package.json` 指定的 pnpm 版本，在项目根目录执行：

```sh
pnpm install
pnpm check
pnpm build
```

`pnpm check` 包含类型检查、lint、Vitest 和生产构建；`pnpm build` 生成可加载的 `dist/`。`pnpm dev` 持续重新构建，修改后仍需在 Chrome 扩展页重新加载。`pnpm test:e2e` 构建后运行 Playwright Chromium 集成场景，需要可用的 Playwright Chromium（首次执行 `pnpm exec playwright install chromium`）。

`pnpm test:ui` 单独执行真实 Chromium 的界面和键盘回归；`pnpm test:e2e` 同时包含后台集成与界面回归。两者使用独立临时 profile 和离线 fixtures，不连接真实 Salesforce。界面截图及结构化结果输出至 `test-results/`。

在 Chrome 120 或更新版本打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择本项目的 `dist/` 目录。首次加载后会自动扫描全部普通窗口；popup 只显示状态、开关、设置入口和用户主动执行的 Org Switcher。

## 使用与边界

- 支持 My Domain、Lightning、Setup 和标准增强 Experience Cloud 域名；7 个分区的准确模板、官方依据及反例见 [域名支持表](docs/domain-support.md)。tenant 是 URL 域身份，不是经 Salesforce API 验证的 Org ID。
- 自动分组尊重用户组、手动排除、固定标签页和原窗口。隐身、非普通窗口、共享组、Split View 及未支持域名会跳过。组的连续排列可能改变同窗口标签位置。
- 分组标题只显示 tenant 名称（例如 `casecentral--dev` 显示为 `dev`），设置别名时直接显示别名，不显示 `[SFN:…]`。已确认归属的旧标记分组会自动改成新标题，保留颜色和折叠状态。
- 分组归属通过当前浏览器会话中的 group ID 绑定及本地登记识别，改名不影响管理，后台 worker 重启可恢复绑定。浏览器重启或扩展重新加载导致会话绑定丢失时，已有纯名称分组保持原状，不会仅凭名称接管；新建未分组标签页仍会自动分组。旧版带标记的分组可通过登记及成员验证迁移。
- 手动取消分组或拖入其他组后，该标签页在当前扩展会话中保持排除，可在设置中「恢复自动管理」。worker 休眠或重启不会清除此记录；浏览器重启、扩展 reload、更新或禁用再启用可能清空会话记录。需要跨重启暂停时，在设置中排除整个 tenant。
- 自动开关默认开启。关闭后保留现有 Chrome 组并停止发起新自动变更；已经提交的浏览器调用可能完成。重新开启会扫描，tenant 排除仍然保留。

## Org Switcher

在设置中添加目标名称及同一 tenant 的精确 HTTPS origin，例如 `https://acme.lightning.force.com`，不含路径或末尾斜线。按需分别配置 Lightning、My Domain、Setup；未配置的 surface 不会被猜测补全。

在 popup 选择目标并预览最终 URL，确认后导航当前标签页。标注为 `production` 的目标每次都需确认；环境标注来自用户配置，普通域默认 `unknown`。切换仅保留已支持的路径和逐路由允许的查询参数，移除 hash 和其他查询参数。认证跳转、Experience Cloud 和未知路径需明确选择目标首页；record ID 不会跨 org 映射，目标对象、记录或权限可能不存在。预览两分钟后失效，页面或配置变化需重新预览。

## 界面与键盘操作

- 设置页按语言、自动分组、切换目标、Org 偏好、手动排除及隐私分区，导航可直接定位；支持窄屏、系统深色外观和明显的键盘焦点。
- 默认使用简体中文，可在设置页「界面语言」选择 English。选择保存在当前浏览器，跨重启保留，并同步更新已打开的设置页和扩展面板；切换时保留未保存的表单内容。
- `Tab` / `Shift+Tab` 移动焦点；原生选择框保留方向键操作，复选框用 `Space` 勾选。名称和 URL 输入框中按 `Enter` 提交表单，保存期间阻止重复提交，错误在当前表单中提示。
- 编辑目标或偏好时，`Esc` 取消并回到原编辑按钮；输入法组合期间不会触发提交或取消。后台更新保留未保存的输入和列表焦点。
- 扩展面板中聚焦「预览切换」后按 `Enter` 进入独立核对步骤；「打开目标首页」只展示当前目标已配置的首页类型。`Esc` 或「取消」返回表单并保留选择。
- 预览不会直接切换。production 需先勾选本次确认，再聚焦确认按钮并执行；更改输入、更新设置或等待超过两分钟后，旧预览失效。

自动化覆盖 Chromium 中的扩展页面。原生扩展弹窗框架、操作系统快捷键、真实输入法候选窗和屏幕阅读器仍需按 [手工清单](docs/manual-acceptance.md) 验收。

## 架构与隐私

TypeScript strict + Vite + Vanilla HTML/CSS，使用 Chrome 原生 Tab Groups。事件入口标记待处理窗口，协调器串行读取事实，纯 planner 计算差异，executor 在每次变更前复核设置与浏览器状态，并通过操作 journal 恢复中断。共享 parser 同时服务 grouper 和 Switcher。

| 位置                         | 责任                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `src/background/`            | 入口组装、事件与消息适配、用例处理、协调、归属验证、执行与恢复 |
| `src/features/tab-grouper/`  | 分组计划、标签页观察、手动排除、初始外观                       |
| `src/features/org-switcher/` | URL 转换与主动切换                                             |
| `src/shared/messaging/`      | 请求校验、请求与响应类型契约、页面消息客户端                   |
| `src/shared/models/`         | 设置与运行时模型，各模型的 schema、推导类型和默认值            |
| `src/shared/chrome/`         | 浏览器快照类型与分组 API 适配                                  |
| `src/shared/storage/`        | Repository 持久化、数据校验与迁移                              |
| `src/shared/` 其他文件       | Salesforce URL 解析、DOM 工具、共享状态视图与样式              |
| `src/popup/`、`src/options/` | 页面事件装配与各设置区域的视图、表单控制                       |
| `tests/`                     | URL fixtures、领域测试、事件及故障测试、Chromium 集成场景      |

后台入口只组装依赖并同步注册监听器；消息适配层负责来源校验、请求校验和响应封装，用例层负责设置更新与主动切换。标签页附加、分离和恢复管理通过 Coordinator 命令修改状态，由协调器保持保存及重新协调的顺序。

页面通过共享消息客户端调用后台，由请求类型推导响应类型。`shared` 不依赖 `features` 或 `background`；纯 URL 转换、分组计划和观察值计算不执行浏览器或存储操作。设置页的目标表单与后台复用同一套目标校验规则，存储格式与 schema 版本保持兼容。

扩展无后端、遥测、Salesforce API、OAuth 或 content script；不读取 cookie 或页面内容。权限仅为 `tabs`、`tabGroups`、`storage`、`alarms`。分组身份只使用 host，不保存完整 path/query/hash、网页标题或浏览历史。用户配置、tenant 排除和 token 登记存于 `storage.local`；host 观察、绑定、手动排除及操作 journal 存于 `storage.session`。Switcher 的完整源 URL 仅短期保存在 worker 内存中，用于确认预览后页面未变化。

测试记录见 [实际测试报告](docs/test-report.md)；仍需在目标 Chrome/操作系统执行的发布验收见 [手工验收清单](docs/manual-acceptance.md)。自动化测试通过不代表所有真实浏览器场景均已通过。

## Inspector 页面按 host 归组

Salesforce Inspector / Inspector Reloaded 的工具页（例如 See All Data、Data Export、Data Import）按 URL 中唯一有效的 `host` 自动加入对应 Salesforce 环境组；同环境工具页不会再触发混合成员释放。支持当前安装及两个商店版本，仍尊重固定标签、手动排除和用户组。详细范围见 [域名支持](docs/domain-support.md#inspector-页面按-host-归组2026-10-16)。
