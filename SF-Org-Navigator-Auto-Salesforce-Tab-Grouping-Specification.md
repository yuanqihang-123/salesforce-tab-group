# SF Org Navigator — Auto Salesforce Tab Grouping Specification

版本：1.0 · 规格基线  
日期：2026-10-15（Asia/Singapore）  
语言：中文；产品、类型及 API 名称保留英文  
状态：可用于实现与验收的产品及技术规格；本文不代表扩展已经实现或通过测试。

## 1. 产品目标与约束优先级

SF Org Navigator 在扩展启用且「自动分组」开关开启时，自动扫描当前 Chrome profile 内所有普通窗口中可访问的现存、恢复、新建和导航后的标签页，将可可靠解析的 Salesforce 标签页按 tenant 分组。无需打开 popup，无需点击分组按钮，也无需登录插件。

同一 tenant 在不同窗口各有独立管理组。Lightning、Setup、My Domain 和本规格安全支持的 Experience Cloud 域名，使用同一套 parser 解析为相同 tenant key。

自动化遵循以下优先级：**用户明确操作与保护规则 > 可靠的 tenant 身份和组归属 > 自动收敛与性能 > 视觉整齐**。因此，“所有 Salesforce tabs 自动分组”的准确范围是：受支持域名、普通窗口、非 pinned、未被用户自建组或手动排除规则保护的 tabs。无法可靠识别的页面保持原状，并可在设置页查看原因。

本文中的 MUST／必须是验收要求；SHOULD／应是实现建议，偏离时须记录原因。时间指标是受控测试目标，不是 Chrome 操作系统调度的实时保证。

## 2. 版本范围

| 功能 | V1 默认范围 | 后续版本／不在 V1 承诺内 |
| --- | --- | --- |
| 自动分组 | 默认开启；所有普通窗口；现存及延迟恢复 tabs；新建和导航增量处理 | 跨 profile、跨设备统一管理 |
| tenant 识别 | 第 4 节 allowlist 中增强域名格式 | 任意旧域名、instance 域名和自定义域名自动归因 |
| 用户组保护 | 默认强制保护；绝不按同名接管 | 用户显式授权接管指定组 |
| pinned tabs | 跳过，解除固定后重新评估 | 自动取消固定、强制分组 |
| Experience Cloud | 可唯一归因的标准增强域名 | 自定义站点域、旧 `*.force.com` 站点自动关联 |
| 开关和设置 | 自动分组开关、状态与原因、tenant 显示别名和环境标注、手动排除管理 | 企业策略、云同步、复杂颜色编辑器 |
| Org Switcher | 保留共享 parser、目标 org 配置和用户主动执行的基础切换；见第 12 节 | 自动登录、跨 org record ID 映射、任意 URL 无损迁移 |
| UI | Vanilla HTML/CSS/TypeScript；popup 只承载状态、设置入口及主动切换 | React/Vue、复杂工作台 |
| 后端和账号 | 无后端；无需插件账号；本地处理 | Salesforce API、OAuth、遥测、云端数据库 |
| 特殊窗口／分组 | 排除 incognito、非 normal 窗口、shared groups；Split View 保守跳过 | 隐身模式、共享组和 Split View 的完整兼容 |

不提供 `Group Salesforce Tabs` 手动主按钮。所有首次扫描和后续整理均由后台自动触发。

## 3. 术语与不变量

- **Tenant**：本插件的 URL 域身份，不等于已经通过 Salesforce API 验证的 Org ID。域名变更、域名重用及别名关联不自动推断。
- **TenantKey**：由规范化域标签、分区、命名空间构成的稳定键，不能仅用 sandbox 名或显示名。
- **Managed Group**：有可验证归属凭据、当前允许插件管理的原生 Chrome Tab Group。
- **Protected Group**：未被可靠认领的组，包括用户自建组、其他扩展组、未知来源恢复组、共享组及放弃管理的组。
- **Reconciliation**：读取浏览器当前事实，计算期望状态，仅执行必要差异，最终收敛。
- **Extension enabled**：Chrome 中扩展处于启用状态；**autoGroupingEnabled**：插件设置中的自动分组开关。二者都开启才执行自动变更。

必须保持：

1. 不因自动分组导航、刷新、关闭、复制或激活任何 tab；不聚焦窗口。
2. 不把 tab 自动搬到其他窗口；分组的连续布局可能改变同窗口标签位置，不保证全部 index 不变。
3. 不修改 protected group 的成员、标题、颜色、折叠状态和顺序。
4. 不取消 pinned，不为了完整分组唤醒 discarded 页面或触发网络请求。
5. 每个 `(windowId, tenantKey)` 最终至多一个可用管理组；protected groups 不受此唯一性约束。
6. 对已符合期望状态的重复事件，产生零分组／取消分组／视觉更新写调用。
7. URL、cookie、页面内容、record ID、token 和浏览记录不上传；分组只需 URL 的 host 部分。

## 4. URL 与 tenant 解析合同

### 4.1 解析流程

共享纯函数 `parseSalesforceUrl(input)` 使用标准 `URL`，返回 `supported`、`unsupported-salesforce`、`non-salesforce` 或 `unavailable`，不能用字符串 `includes('salesforce')` 或包含匹配判断。

V1 分组只接受 `https:`、无 username/password、无非默认端口、严格匹配 allowlist 的域名。hostname 小写；可规范化单个末尾根域点；拒绝异常标签、额外子域及未登记的 IDN/punycode 标签。path/query/hash 不参与 tenant 身份；不能从 `retURL`、`startURL`、页面标题或 referer 推断 tenant。

匹配顺序是更具体的 partition 格式优先，再匹配普通格式；前置域身份只允许一个有效 DNS label，不得贪婪捕获 `evil.acme`。不能剥离任意 `--xxx` 后缀来合并 org。

V1 的保守语法额外规定：sandbox 的完整 label 必须含非空 `MyDomainName--SandboxName`；unpartitioned 的 label 如含 `--`，视为可能的旧 sandbox 格式并返回 unsupported，不尝试与增强 sandbox 合并。即便这会排除某些特殊普通域，也优先避免含糊归因；其他 partition 使用官方模板校验，完整 label 原样保留。

### 4.2 默认支持矩阵

定义 `D` 为规范化后的完整 My Domain label；`P` 为显式 allowlist 分区。示例均为虚构域名。

| 页面类型 | 普通域格式 | sandbox 格式 | 解析结果 |
| --- | --- | --- | --- |
| My Domain／Classic／登录页 | `D.my.salesforce.com` | `D.sandbox.my.salesforce.com` | surface=`my-domain` |
| Lightning | `D.lightning.force.com` | `D.sandbox.lightning.force.com` | surface=`lightning` |
| Setup 独立域 | `D.my.salesforce-setup.com` | `D.sandbox.my.salesforce-setup.com` | surface=`setup` |
| Experience Cloud | `D.my.site.com` | `D.sandbox.my.site.com` | surface=`experience` |

标准增强域名的不同 surface 共享 D 和 partition，因而可安全合组。Setup 页面如仍位于 Lightning host，只改变 surface/path 分类，不改变 key。官方格式参考：[My Domain URL Formats](https://help.salesforce.com/s/articleView?id=sf.domain_name_url_formats.htm&language=en_US&type=5)、[Sandbox Partitioned Domains](https://help.salesforce.com/s/articleView?id=xcloud.domain_name_partitioned_domains_sandbox.htm&language=en_US&type=5)。

V1 还支持 `P ∈ {develop, demo, patch, scratch, trailblaze}` 的上述模板：在 `D` 后、surface 后缀前插入 `.P`。每个 surface/partition 组合必须有对应官方格式核对及测试 fixture；没有验证的组合返回 unsupported，不能通过通用正则自动扩展支持范围。分区值保留进 tenant key，绝不与普通域或其他分区合并。参考：[Partitioned Domains](https://help.salesforce.com/s/articleView?id=sf.domain_name_partitioned_domains.htm&language=en_US&type=5)。

### 4.3 Canonical key 与示例

```text
tenantKey = "sf:commercial:" + partition + ":" + domainLabel
partition = "unpartitioned" | "sandbox" | "develop" | "demo"
          | "patch" | "scratch" | "trailblaze"

acme--pesdev.sandbox.lightning.force.com
acme--pesdev.sandbox.my.salesforce-setup.com
acme--pesdev.sandbox.my.salesforce.com
acme--pesdev.sandbox.my.site.com/partners/s/
→ sf:commercial:sandbox:acme--pesdev

acme--uatpes.sandbox.lightning.force.com
→ sf:commercial:sandbox:acme--uatpes（独立）

acme.lightning.force.com
acme.my.salesforce.com
acme.my.site.com/customers/s/
→ sf:commercial:unpartitioned:acme

other--pesdev.sandbox.lightning.force.com
→ sf:commercial:sandbox:other--pesdev（不能与 acme--pesdev 合并）

acme.develop.my.salesforce.com
→ sf:commercial:develop:acme（不能与 unpartitioned:acme 合并）
```

`--pesdev` 等只能用于辅助显示，不用于截断身份。名称相同但 key 不同必须保持独立。Experience Cloud 同 tenant 下多个 site path 合入同组；site path 不代表独立 org，也不证明用户已认证。

### 4.4 Production 与未知情况

没有 `.sandbox` 不意味着 production。旧 Developer Edition 等也可能使用普通格式。默认环境标记为 `unknown`；只有显式分区可提供对应环境线索。用户可在设置中标注 `production`，这是用户配置而非身份验证；别名和环境标注均不改变 tenant key。

以下默认不分组，不猜测：`login.salesforce.com`、`test.salesforce.com`、`na123.salesforce.com` 等共享入口／instance host、旧 `D--sandbox.my.salesforce.com` 的含糊格式、Visualforce/文件/CDN 域、legacy Experience `*.force.com`、任意自定义站点域、Government Cloud 及其他未列出云域、未来未知 partition。尤其不能从公司名前缀将 custom site、legacy community 与 production 自动合并。

`acme.my.site.com.evil.example`、`salesforce.com.evil.example`、`https://salesforce.com@evil.example` 和 path 中包含 Salesforce 字样均不能进入支持范围。自定义域将来需要用户逐 host 显式映射并校验冲突；V1 无此能力。

## 5. 功能需求（FR）

| ID | 必须行为 | 关键约束 |
| --- | --- | --- |
| FR-01 | 安装后默认启用自动分组，自动扫描全部普通窗口 | 不依赖 popup、当前活动窗口或首次点击 |
| FR-02 | 扩展重新启用、reload 或 worker 新实例启动后初始化并自动协调 | 无通用“本扩展重新启用”专用事件假设；通过 worker 入口恢复 |
| FR-03 | profile startup 后扫描，持续接收晚到恢复 tabs | 单次 startup 快照不能视为恢复完成 |
| FR-04 | 新 tab 最终获得受支持 URL 后加入本窗口 tenant 管理组 | onCreated 没 URL 时延后，不能猜租户 |
| FR-05 | 普通页面导航至 Salesforce、Salesforce A→B 时自动协调 | 重新读取当前 tab，防止旧事件覆盖新导航 |
| FR-06 | 已管理 tab 导航至确定非目标网页时移出管理组 | 不动 protected group；瞬态 URL 按第 9 节处理 |
| FR-07 | 同窗口复用可靠认领的同 tenant 管理组 | 同名用户组不复用；新窗口单独创建 |
| FR-08 | 所有 protected group 内的 tab 保持原样 | 即使 tenant 不同或 URL 改变也不抢走 |
| FR-09 | 默认跳过 pinned；解除固定后评估 | 不自动 unpin；用户主动 pin 不应被抢回 |
| FR-10 | 保持 active tab 与窗口焦点 | 新组默认展开；已有组保留折叠状态；必要时只展开含 active tab 的目标组 |
| FR-11 | 人工更改标题／颜色／组顺序后尊重更改 | 不每轮重写颜色／标题；移除归属标记视为放弃管理 |
| FR-12 | 人工移出／取消分组时暂停该 tab 自动纳管 | 规则见第 7 节；worker 重启后仍有效 |
| FR-13 | 组和窗口移动、关闭、替换 tab 后重新验证索引 | 不使用失效 tabId/groupId/windowId 直接变更 |
| FR-14 | 关闭开关后停止发起新变更，保留现有 Chrome 组 | 每个副作用前检查设置 revision；已提交调用可能先完成 |
| FR-15 | 重开开关立即全量扫描，复用可确认组 | 不重置用户排除；需要时用户可单独恢复纳管 |
| FR-16 | 并发事件最终收敛，不重复建组、不反复跳组 | 串行副作用、事件合并、写前校验和幂等 |
| FR-17 | 状态页显示已开启／已关闭／恢复中／降级及跳过原因数量 | 不把 unsupported 显示为已整理成功 |
| FR-18 | 无网、未登录 Salesforce 仍可按受支持 host 分组 | 不校验登录态，不访问页面或 Salesforce API |
| FR-19 | 扩展禁用或卸载时停止运行 | Chrome 可保留既有组；不承诺自动清除或回滚 |
| FR-20 | 基础 Org Switcher 与分组共用 parser | 切换须由用户主动执行，不能由 grouper 调用 |

| FR-21 | Inspector 工具页按唯一有效 host 加入对应 tenant 管理组 | 同 tenant 工具页不得触发混合成员释放；host 切换跟随新 tenant；详见文末补充 |

## 6. 管理组归属、重启恢复与外观

### 6.1 API 限制与归属方案

Chrome Tab Groups API 没有扩展专属 owner/custom metadata 字段，group ID 仅在浏览器会话内唯一，不能存入 local 后作为跨重启归属凭据。见 [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)。

V1 采用**可见管理标记 + 本地登记表 + 会话绑定**：

1. 每个 tenant 生成随机 96-bit token，以 16 位 base64url 表示，先写入 `storage.local` 的登记表。
2. 创建管理组标题：`ACME / PESDEV [SFN:<token>]`；普通域默认 `acme [SFN:<token>]`。token 不含登录信息，不是安全凭证。显示别名须转义为文本；同名别名应附完整域身份区别。
3. `storage.session` 绑定本次会话的 groupId/windowId、tenantKey、token。组有效性每次变更前重新验证。
4. 冷启动不信任旧 ID；只对包含已登记精确 token、非 shared、非 protected 且当前成员可验证为同 tenant 的组重新绑定。
5. 标记被删除、复制产生冲突、成员身份冲突、数据丢失或无法验证时，保守视为 protected；禁止按标题相似、颜色、别名推断归属。

标记是兼顾自动恢复和用户组保护的明确 V1 产品取舍，必须在设置页解释。它不是防恶意伪造的认证机制。用户复制标记会触发冲突保护；丢失本地登记数据后旧组不自动接管。未来如 Chrome 提供可靠 owner metadata，可迁移为无可见标记方案。

### 6.2 恢复、冲突与创建中断

- 一个 token 在不同窗口各出现一个同 tenant 组是合法；每窗口独立绑定。
- 同窗口同 token 多组：若会话记录及创建 journal 证明全由插件产生，可合并到既有绑定组，否则全部转 protected，记录冲突，不反复尝试。
- 冷恢复时若成员含 URL 暂不可见者，标记为 `recovering`，暂不接纳新 tab；恢复事件或后续协调时复核。确定混合 tenant 或普通网页则转 protected，不清理用户可能加入的成员。
- 对仍在 `recovering` 的已知 tenant/window，暂缓创建另一个组；可见 URL 连续稳定 60 秒仍无法验证则记录降级，并保持相关 tabs 原状。后续有新事实仍可重新评估，不宣告恢复完成。
- 创建顺序：保存 local token → 保存 session journal（目标 tenant、window、tab IDs、操作意图）→ `tabs.group` → 保存返回 ID → 更新标题/颜色 → 保存绑定 → 清理 journal。
- worker 在调用后但返回前终止：下次通过 journal 和当前成员核对；仅在成员恰为原候选、当前 URL/位置未改变且候选唯一时完成标记。歧义组转 protected，不盲目重建。安全优先于追求无条件合并。

### 6.3 外观

首次颜色由 tenant key 的固定哈希映射到 Chrome 支持的颜色表，允许不同 tenant 撞色；身份永远看 key。用户标注 production 时首次可用 red，但颜色不是环境认证。新组只在创建时设标题、颜色和展开状态。

用户改色或改标题并保留 token 后，插件保留更改，不覆盖；组消失后再创建默认用 tenant 配置。用户删 token 后该组及其现有成员退出自动管理。用户改变折叠／位置时保留；把 active tab 加入折叠组前展开该目标组，避免活动页被隐藏，不调用 `tabs.update({active:true})` 或 `windows.update({focused:true})`。

## 7. 用户操作与防止反复变化

默认规则固定为 `respectUserGroups=true`、`skipPinnedTabs=true`，V1 不提供强制覆盖选项。

| 用户行为／当前状态 | 默认处理 |
| --- | --- |
| Salesforce tab 原本就在用户组 | 完全跳过，导航后仍受保护 |
| 用户把管理 tab 拖入用户组 | 立即以用户组为准；标记该 tab 手动排除 |
| 用户把管理 tab 取消分组 | 记录 manual override，不在下一轮抢回 |
| 用户把管理 tab 放进另一个 tenant 管理组 | 放弃该目标组的管理，将其作为用户改造的 protected group；不把 tab 拉回 |
| 用户把普通网页或其他 tenant 拖入管理组 | 若不是插件预期操作结果，放弃该组管理，保留成员，记录原因 |
| 用户把未分组的同 tenant tab 放入管理组 | 接纳当前状态，无需额外分组；若该 tab 有 manual override 则保持排除记录 |
| 用户整组移动到另一窗口 | 验证 token、成员与目标窗口，合法则重新绑定；不搬回原窗口 |
| 用户仅移动组／组内排序 | 保留，不做全局排序 |
| 用户固定 tab | 尊重固定，若离开管理组，不额外建立 manual override；解除固定后可分组 |
| 用户关闭整个组或全部 tabs | 清理会话绑定，不创建空组；不重新打开页面 |

manual override 以 tabId 记录在 `storage.session`，有效期覆盖本次扩展会话内的 URL 导航和跨窗口移动；worker 休眠／重启不清除。用户在设置页选择「恢复此标签页自动管理」可清除；tab 关闭后清除；`onReplaced` 时仅在确认是同一逻辑 tab 时迁移，无法确认则保守排除新 tab。

浏览器重启、扩展禁用再启用、更新或 reload 会清空 session；无稳定跨会话 tab 身份，V1 不承诺为未分组 tab 恢复 manual override。需要跨重启暂停时使用 local 存储的 tenant 排除列表；用户组仍按保护规则处理。此限制必须写入设置说明。storage 的实际生命周期见 [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。

事件不提供“用户／其他扩展／本扩展”可靠来源标志。必须在副作用调用前登记 expected mutation（目标成员关系、操作 ID、revision 和过期时间），用实际结果和后续快照确认；不能用全局 `ignoreEvents=true` 屏蔽监听。归因不明时采用保护，不能把 worker 恢复后的首次快照直接判为用户干预。

放弃管理持久化为 local token 的 `released` 状态；当前组不再接纳 tabs，其现有成员按 protected 规则处理。需要继续整理新 tabs 时为同 tenant 创建新的 active token；旧 token 永不自动复活。避免 released 记录删除后旧组被错误认领，保留轻量 tombstone。

## 8. 事件矩阵与 worker 生命周期

所有监听器在 service worker 模块顶层同步注册；不能等待 storage 初始化后才注册。监听器只标记 dirty 并调度，所有副作用经过统一协调器。worker 启动后通过单个 `bootstrapPromise` 读取状态、完成 migration、验证 alarm 和触发初次扫描。

| 事件／入口 | 处理 |
| --- | --- |
| worker 模块启动 | 注册监听器；bootstrap；全量只读盘点；开关开启时协调全部普通窗口 |
| `runtime.onInstalled` | 首次写默认值，升级做版本迁移，保留原开关；扫描；不把更新当重置 |
| `runtime.onStartup` | 全量扫描并进入恢复协调；不假设 tabs 已完全恢复 |
| `tabs.onCreated` | 标记所在窗口；URL 缺失／只有 pendingUrl 时等待后续事件 |
| `tabs.onUpdated` | URL、status、pinned、groupId 等影响条件变化时标记；标题/favicon 改变不触发写入 |
| `tabs.onAttached` / `onDetached` | 标记新旧窗口；detach 期间不操作该 tab；重新 get 验证位置 |
| `tabs.onMoved` | 更新快照或标记窗口；不强制恢复顺序；处理组移动伴随的 tab 事件 |
| `tabs.onRemoved` | 清除 override/journal 残留及快照；窗口关闭时不重建 |
| `tabs.onReplaced` | 清理旧 ID，重新读取新 ID，保守迁移排除和期望状态 |
| `tabs.onActivated` | 更新活动状态；只在必要时保障 active tab 所在管理组可见 |
| `tabGroups.onCreated` | 重新核对归属；不能因为新组同名就接管 |
| `tabGroups.onUpdated` | 处理用户标题／颜色／折叠及 token 删除；插件自身回声做幂等确认 |
| `tabGroups.onMoved` | 保留用户排序，重查组；跨窗口不能仅依赖此事件 |
| `tabGroups.onRemoved` | 删除会话绑定；区分仍存在的 tabs 和关闭，避免重建循环 |
| `windows.onCreated` / `onRemoved` | 新普通窗口扫描；删除窗口时清理 dirty/绑定/重试 |
| `storage.onChanged` | 仅设置 namespace 的有效变化更新 revision；开关 false→true 全量扫描；运行状态写回不触发全量循环 |
| `alarms.onAlarm` | 命名为 `sfn-reconcile` 的补偿扫描、journal 恢复及失败重试；遵守开关 |

组跨窗口移动可能表现为旧组移除、新组创建，并伴随 tab attach/detach；必须以查询结果为准。tabs 和 groups 事件依据 [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) 与 [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)。

worker 是可被终止的事件处理器：不能依赖内存 Map、计时器、全局锁永久存在，也不使用保活心跳。短 debounce 只优化当前 worker；durable dirty/journal 与 alarms 负责补偿。每次 worker 初始化只做一次 bootstrap，后续事件增量处理；不能每个事件重新启动全量扫描。参考 [Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。

开关开启时确保存在每 1 分钟的 reconciliation alarm，初始化检查并按需补建；关闭时清除该 alarm，保留设置事件监听。alarm 可能延迟，不能承诺整点执行或将 `setTimeout` 当可靠恢复机制。选用 Chrome 120+，不依赖更高版本才引入的 alarm 持久化字段。参考 [Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)。

## 9. 协调算法、竞态和幂等

### 9.1 输入事实与计划

启动扫描使用 `windows.getAll({populate:true, windowTypes:['normal']})` 或等效全 profile 查询，显式排除 incognito。恢复/discarded tab 如有可读的已提交 URL，可直接解析并分组，无需加载页面。

每个窗口聚合一次 tabs、groups、设置、ownership、overrides 快照；纯函数 planner 输出动作列表：`NOOP`、`DEFER`、`PROTECT`、`RELEASE_GROUP`、`UNGROUP_OWNED_TAB`、`JOIN_OWNED_GROUP`、`CREATE_GROUP`、`EXPAND_ACTIVE_TARGET`。受保护或未知事实优先产生 NOOP/DEFER。

处理顺序：

1. 检查设置、窗口类型、生命周期状态、pinned、shared/Split View、protected group 和 manual override。
2. 从当前 `tab.url` 解析 tenant，`pendingUrl` 只用于判断导航中，不用于提前变更归属。
3. `pendingUrl` 与已提交 URL 不一致时，等待提交，避免对旧 URL 做动作；新 tab 无 URL 或 `about:blank` 暂缓。
4. 对已管理 tab，确定的受支持新 tenant 提交后移入目标；确定非 Salesforce 的 HTTPS/HTTP 页面提交后移出原管理组。HTTP Salesforce 页也不属于 V1 支持范围。
5. 瞬态 `about:blank`、`chrome-error://`、URL 不可读或加载中的空 URL 不立即移出；后续事件重判。`about:blank` 在无 pending、非 loading 且连续 10 秒稳定时可移出；不可读／错误页保持并记录待确认，不猜身份。时间到了通过现有事件或 alarm 确认，不依赖单个 timer。
6. 登录重定向至共享 `login/test.salesforce.com` 时，允许 10 秒稳定期避免短暂跳组；明确停留后移出。最终回到可识别 host 时再加入。不能从共享登录页继承上次 tenant。
7. 查找本窗口同 key 的已验证组；不存在才创建。对同组成员不重复调用 `tabs.group`。
8. 移出只针对该 tab 自身导航导致失配且组仍属本插件的情形；若发现用户把未知成员拖入组，按第 7 节放弃组，不批量踢人。
9. 检查 active 可见性，仅对需要的目标组展开；其他视觉属性不写回。

### 9.2 执行器与状态版本

V1 所有 Chrome 副作用使用一个全局串行执行队列，按窗口合并工作；纯解析可以批量执行。这样同一 window/tenant 的创建以及跨窗口移动引发的冲突统一排序，避免在不同异步事件中并行建组。

- 每个窗口有递增 `generation`；设置有 `revision`。事件到来先置 dirty，正在协调时只合并下一轮，不重复并发协调。
- 每次副作用前重新读取目标 tab/group 及最新设置；校验 tab 仍存在、windowId/URL/tenant/groupId/pinned 与计划前置条件一致。
- 前置条件改变则丢弃旧动作、重算；await 返回后重新确认实际状态，不能把旧计划结果当事实覆盖新事件。
- 暂存 expected mutation 必须先于 API 调用；包括 group 创建、成员变更与 metadata 更新，处理回声早于 Promise 返回的顺序。
- 每个成功结果持久化前检查对应 generation；旧 generation 只能标记 dirty，不能撤销新 generation。
- API 与 storage 不构成事务；journal 保存操作意图和检查点，重启读取浏览器事实后完成或保守放弃。绝不承诺 exactly-once API 调用。
- 外部用户可在最后一次校验与 Chrome 调用之间操作，API 无原子条件变更能力；检测冲突后停止补偿性抢回，以用户当前状态为准。验收保证可控并发下收敛和不持续争抢，不承诺消除平台不可见的微小竞态窗口。

```text
event → markDirty(window) → persist/coalesce → ensureBootstrap
      → serialized reconcile(window)
          read current snapshot
          validate ownership and overrides
          plan minimal diff
          for each action:
              reread settings + affected browser facts
              if stale: mark dirty; skip
              persist expected mutation / creation intent
              execute one Chrome action
              reread actual result; persist checkpoint
          if new events arrived: rerun once with newest facts
          else mark clean
```

### 9.3 降噪、重试与恢复

建议每窗口 200ms trailing debounce，并设 1 秒最大等待，防止事件洪峰下饿死。计时器丢失时 dirty/journal 或下一次补偿扫描仍能恢复；不能在内存 pending 尚未落盘时清除 durable dirty。

关闭 tab／窗口、组消失：视为正常竞态，清理并重算，不弹错。Chrome 拖拽期间暂不可编辑：标记 dirty，有限重试。建议当前 worker 内最多 3 次重试，延迟 250ms／1s／3s；跨 worker 的 `attempts/nextEligibleAt` 存 session，超过次数交给 alarm，以最多 5 分钟的退避继续，只在有新事实时提前解除退避。

权限缺失、storage 不可写、未知 schema：进入降级并停止相关变更，不用空设置冒充首次安装；在 UI 说明原因。所有异步入口捕获错误，不能出现 unhandled rejection。关闭开关、用户排除、窗口关闭须使已排队任务失效。

## 10. 数据结构与存储

以下为领域合同示意，不是完整运行代码。所有存储对象均需运行时校验；禁止只依赖 TypeScript 类型断言。

```typescript
type Partition = 'unpartitioned' | 'sandbox' | 'develop' | 'demo'
  | 'patch' | 'scratch' | 'trailblaze';
type TenantKey = `sf:commercial:${Partition}:${string}`;
type Surface = 'my-domain' | 'lightning' | 'setup' | 'experience';

type ParsedSalesforceUrl =
  | { kind: 'supported'; tenantKey: TenantKey; domainLabel: string;
      partition: Partition; surface: Surface; hostname: string }
  | { kind: 'unsupported-salesforce'; reason: string }
  | { kind: 'non-salesforce' }
  | { kind: 'unavailable'; reason: string };

interface SettingsV1 {
  schemaVersion: 1;
  revision: number;
  autoGroupingEnabled: boolean; // default true
  respectUserGroups: true;
  skipPinnedTabs: true;
  excludedTenants: TenantKey[]; // default []
  tenantPreferences: Record<string, {
    alias?: string;
    environment?: 'production' | 'sandbox' | 'development' | 'unknown';
  }>;
  switchTargets: SwitchTarget[]; // default []
}

interface OwnershipRegistration {
  token: string; // random 96-bit, 16 base64url characters
  tenantKey: TenantKey;
  status: 'active' | 'released';
  createdAt: number;
}

interface ManagedGroupBinding {
  windowId: number;
  groupId: number;
  tenantKey: TenantKey;
  token: string;
  status: 'verified' | 'recovering';
}

interface ManualOverride {
  tabId: number;
  reason: 'manual-ungroup' | 'manual-regroup' | 'uncertain-replacement';
  createdAt: number;
}

interface MutationIntent {
  operationId: string;
  kind: 'create' | 'join' | 'ungroup' | 'metadata';
  windowId: number;
  tenantKey?: TenantKey;
  tabIds: number[];
  targetGroupId?: number;
  expectedBefore: Record<string, unknown>; // implementation: typed snapshot
  expectedAfter: Record<string, unknown>;
  settingsRevision: number;
  phase: 'prepared' | 'applied' | 'verified';
  expiresAt: number;
}

interface SwitchTarget {
  id: string;
  label: string;
  tenantKey: TenantKey;
  origins: Partial<Record<'my-domain' | 'lightning' | 'setup', string>>;
}
```

| 存储位置 | 内容 | 生命周期和写入规则 |
| --- | --- | --- |
| `storage.local` | settings、tenant 偏好、switchTargets、token 登记与 released tombstones | 跨浏览器重启；不存运行时 IDs；migration 失败保留原值 |
| `storage.session` | bindings、manual overrides、dirty windows、journals、短期重试与恢复状态 | 覆盖 worker 重启；扩展重载/禁用/更新/浏览器重启后可能清空 |
| worker 内存 | 当前快照、队列、短 debounce、解析缓存、bootstrapPromise | 可随时丢失，不能作为唯一事实 |

只有后台 repository 写 ownership/runtime；设置 UI 通过经过校验的消息向后台提交变更，后台串行写 settings 并递增 revision，避免多个 UI 页面覆盖。监听 `storage.onChanged` 时区分 settings 与 runtime；内容无变化不写入，不每个 URL/status 事件写完整 local 对象。操作意图优先可靠落盘，普通快照可批量。

不保存完整 path/query/hash、网页标题或访问历史。必要导航比较值仅短期保存在 session，优先使用 host/tenant 与 generation。调试日志默认关闭；只存计数、原因码和脱敏 ID，容量有界；不记录 URL 查询参数、认证跳转或凭证。

## 11. 架构与技术选型

| 层 | 技术／责任 |
| --- | --- |
| 语言和构建 | TypeScript strict、Vite、pnpm、MV3 |
| 后台 | Chrome extension service worker，ES module；事件入口与协调器 |
| 领域核心 | 纯 URL parser、tenant resolver、ownership policy、reconciliation planner |
| 浏览器适配 | `chrome.tabs`、`chrome.tabGroups`、`chrome.windows`、`chrome.alarms` |
| 存储 | typed repository + runtime validation + schema migration；local/session 分离 |
| UI | Vanilla HTML + CSS + TypeScript；popup、options；无前端框架 |
| 质量 | Vitest；Chrome adapter mocks；真实 Chrome 场景验收；ESLint/Prettier |

```text
src/
  background/
    index.ts                 # synchronous listener registration + bootstrap
    eventRouter.ts           # dirty marking; event normalization
    coordinator.ts           # serialized orchestration + generations
    executor.ts              # preconditions, journal, API effects, retries
    ownershipRegistry.ts     # claim/recover/release
  features/
    tab-grouper/
      planner.ts             # pure minimal-diff policy
      userOverrides.ts
      appearance.ts
    org-switcher/
      urlTransformer.ts      # explicit route/surface policy
      switcher.ts            # only user-triggered navigation
  shared/
    salesforce/urlParser.ts
    salesforce/tenantResolver.ts
    chrome/browserAdapter.ts
    storage/settingsStore.ts
    storage/runtimeStore.ts
    storage/migrations.ts
    types.ts
  popup/                     # status + explicit switch UI
  options/                   # settings + exclusions + target configuration
  tests/fixtures/            # URL and event traces, no real customer data
public/manifest.json
```

Vite 必须分别产出稳定入口 `background.js`、popup 和 options；不能把普通网站构建结果直接当作可加载扩展。构建不使用远程脚本或 eval，不把开发服务器/HMR 依赖带入发行包。

### 11.1 Manifest 基线

```json
{
  "manifest_version": 3,
  "name": "SF Org Navigator",
  "version": "1.0.0",
  "minimum_chrome_version": "120",
  "permissions": ["tabs", "tabGroups", "storage", "alarms"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup/index.html" },
  "options_ui": { "page": "options/index.html", "open_in_tab": true },
  "incognito": "not_allowed"
}
```

此处是最小产品权限基线，发行包仍需图标等资源。`tabs` 用于后台读取现存和未激活 tabs 的 URL，`activeTab` 无法覆盖该需求；`tabGroups` 用于原生组属性；`storage` 用于状态；`alarms` 用于 worker 休眠后的补偿。使用 windows 查询并不需要臆造 `windows` permission。无需 host_permissions、scripting、cookies、webRequest、history、identity 或 content script；读取页面 DOM 不属于本需求。权限依据见 [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)。

基础 Switcher 通过 popup 主动触发，故 V1 不申请 `contextMenus`。如未来加入右键菜单，再增加该权限与对应验收，不暗中扩大权限。

## 12. Org Switcher 保留合同

自动分组是主功能，Org Switcher 保留为用户主动操作的辅助功能。两者共用 `parseSalesforceUrl` 与 `TenantKey`，不得各写一套正则。

1. 目标 org 由用户配置经过 parser 校验的精确 HTTPS origins，禁止猜出一个 production host、只替换 sandbox 字符串或使用任意输入 URL 跳转。
2. 目标按 surface 保存 My Domain、Lightning、Setup origin；缺少对应 surface 时提示配置或由用户明确选择目标首页，不自动构造未知 host。
3. 默认保留受支持的相对 pathname；query 只保留经过测试的逐路由 allowlist 参数，hash 默认移除。不得跨 org 携带 sid、access_token、session、OAuth code、签名 URL、外部 retURL 等认证或跳转信息。
4. `frontdoor.jsp`、OAuth/SSO/login redirect、Experience Cloud、自定义域及 unsupported surface 默认不可直接路径切换；可显式选择打开目标首页。
5. Salesforce record ID、Flow/API 名称及权限可能跨 org 不存在。普通 record 路径可在提示此限制后由用户主动保留，但不承诺目标有效，不做 ID 映射，也不自动重试到别的 org。
6. 默认在当前 tab 导航，执行前显示目标 org、环境标注和最终 URL；目标标注 production 时要求本次点击确认。该确认只属于用户主动切换流程，自动分组不出现确认或弹窗。
7. 切换完成后的实际 URL 由自动 grouper 正常处理；受保护组中的 tab 依然留在用户组，manual override 不被切换自动清除。

## 13. 边界案例决策表

| 场景 | 预期结果 |
| --- | --- |
| 窗口 1、2 各有 PESDEV | 两个独立管理组，颜色可相同，tab 不跨窗口 |
| 启用时多个后台窗口已有 Salesforce tabs | 全部扫描，无需激活窗口 |
| startup 先触发，30 秒后才恢复新 tabs | 后续 created/updated 及 alarm 补齐，无需再次启动 |
| discarded 恢复 tab 已有 URL | 按 host 分组，不刷新、不主动加载 |
| onCreated 只有 pendingUrl，最终重定向另一个 org | 以最终提交 URL 分组，不预先加入错误组 |
| 快速 A→B→C，多次事件 Promise 乱序 | 旧动作失效，最终 C，稳定后不继续移动 |
| Lightning↔Setup↔My Domain | 同 key，保持原组，不删除重建 |
| 同 tenant 两个 Experience sites | 合到同组；path 不影响 key |
| custom Experience domain／legacy community | unsupported，原样保留，不猜关联 |
| 普通格式实际为 Developer Edition | unknown，禁止标记为已验证 PROD |
| 用户组名恰为 PESDEV 或仿照 SFN 标题 | 无有效 token 登记则 protected |
| 手动取消分组后 worker 被终止重启 | manual override 保持，不抢回 |
| 手动排除后整个 Chrome 重启 | session override 可能消失；tenant local 排除仍有效 |
| 用户删管理标记／混入其他 tenant | 放弃该组，保留当前状态，之后不反复纠正 |
| 最后一个 tab 导航出 Salesforce | 仅对合法受管 tab 取消分组，空组由 Chrome 移除，清理绑定 |
| 关闭空组、旧 groupId 再不可用 | 不抛未处理异常；下次需要才创建新组 |
| 跨窗口拖拽 tab 同时发生 URL 更新 | 完成 attach 后按最终窗口和 URL 处理，不拖回旧窗口 |
| 组整体移到另一窗口且已有同 tenant 管理组 | 只有双方归属可证实时合并，否则冲突保护；不搬回 |
| pinned Salesforce tab，随后 unpin | pinned 时跳过；unpin 后正常评估 |
| 向折叠管理组加入 active tab | 先展开目标，不激活别的 tab、不聚焦窗口 |
| 设置关闭时已有动作在 await 中 | 不再发起后续动作；已提交 API 允许结束，状态页反映关闭 |
| token 写入成功，创建后 worker 被终止 | journal+现状恢复；歧义则保护，不盲建第二组 |
| Chrome 保存／同步恢复组但 ID 改变 | 通过 token 与成员重新确认；不通过旧 ID 接管 |
| shared group、Split View、隐身或非普通窗口 | V1 跳过并给原因，不尝试改造布局 |
| storage 损坏或迁移失败 | 降级停止写浏览器，保留原始数据供恢复 |

## 14. 测试计划

### 14.1 Vitest：纯领域测试

- parser 表驱动：每个支持模板、分区、surface、大小写／根域点、production unknown、tenant key 相等与不等。
- 反例：host 后缀欺骗、userinfo、额外标签、非 HTTPS、非默认端口、无效 URL、IDN、未知分区、instance/shared login、legacy/custom site、Visualforce。
- identity：`acme--pesdev` 与 `other--pesdev` 不合并；sandbox 与 unpartitioned 不合并；同 tenant site paths 合并。
- planner：同窗口复用、跨窗口独立、protected/pinned/override 优先、退出 Salesforce、active 可见性、零差异零写调用。
- ownership：随机 token 登记、同名组不接管、标记删除、released tombstone、成员混杂、冷恢复 URL 未知、token 冲突、多个窗口合法复用 token。
- URL transformer：surface 对应、保留允许 path、剔除认证参数/hash、禁止外部目标与 frontdoor/SSO、目标缺失及 record 路径限制。

### 14.2 Mock Chrome：事件与故障注入

测试 fake Chrome adapter 必须模拟 group 连续布局、空组消失、事件回声和 API 前后快照变化，不能只断言“某个函数被调用”。

1. 同一 tenant 同时创建 30 tabs，只产生一个最终管理组；重复调用 reconcile 后零额外写调用。
2. 创建事件缺 URL，随后 pendingUrl、重定向、complete；无错误 tenant 短暂分组。
3. 快速导航与关闭、detach/attach、replaced 乱序；最终存活 tab 位于正确窗口与组。
4. 在每个 storage/API await 边界注入 worker 终止，清空内存但保留 session；重建 worker 后无错误接管或持续重复建组。
5. API mutation 事件早于 Promise 返回；自身回声不被判作用户取消分组。
6. 用户改组与后台计划交错；用户状态稳定后不再抢回；模糊来源保守保护。
7. 开关关闭、设置多页面更新、storage 失败、schema migration、API 拖拽错误、alarm 丢失和延迟。
8. 浏览器重启模拟：清空 session、重编号 tab/group/window，只保留 local 与恢复组标题；验证 token 恢复与 manual override 限制。
9. 无变化时重复 URL/status/group 事件 100 次，不更新外观，不触发 local 写入循环。
10. 模型属性测试：任意事件序列后，不动 protected、不跨窗口搬 tab、不 unpin、不导航；满足稳定前置条件时最终收敛。

### 14.3 真实 Chrome 手工／集成验收

以最低支持 Chrome 120 和发布时稳定版执行；在 Windows/macOS 至少各一次核心用例。涉及真实 Salesforce 时仅用授权测试 org；parser/UI 用例可用虚构 URL fixtures。

必须包含：首次安装不打开 popup、Chrome 设置页重新启用、浏览器 session restore、保存组恢复、多个普通窗口、worker DevTools 关闭后的自然休眠、手动终止 worker、固定／取消固定、拖拽中 API 错误、用户组及其他扩展组共存、active tab 加入折叠组、禁用与更新、权限／存储异常。

关闭 service worker DevTools 后再做休眠测试，避免调试器改变生命周期。真实组折叠、拖拽、恢复顺序和 API 错误不能只凭 mock 认定通过。

## 15. 验收标准（AC）

| ID | 可复现条件与通过标准 | 对应需求 |
| --- | --- | --- |
| AC-01 | 首次安装，3 个普通窗口预存 60 个受支持非 pinned、未分组 tabs，20 个其他网页；从未打开 popup，Salesforce tabs 最终按 window/tenant 分组，其他页不动 | FR-01/07 |
| AC-02 | Chrome 中禁用后重新启用扩展，保留默认开关；无需点击任何 UI 自动扫描 | FR-02 |
| AC-03 | 重启并恢复窗口，延迟创建/恢复 tabs 持续 60 秒；最后一批 URL 可见后自动补齐，不遗漏后台窗口 | FR-03 |
| AC-04 | 新建、普通页→Salesforce、tenant A→B、Lightning↔Setup↔My Domain 的最终组正确；最后一种转换不重建组 | FR-04/05 |
| AC-05 | managed tab 提交导航到普通网页后退出；用户组中的同类导航不改变组关系 | FR-06/08 |
| AC-06 | 同名用户组、未知恢复组、其他扩展组成员和外观均未改变；未分组目标 tabs 可建立独立管理组 | FR-07/08 |
| AC-07 | pin 全程不被取消；unpin 后正常处理；不会因为分组切换 active tab、聚焦或导航 | FR-09/10 |
| AC-08 | 用户改色、改标题、折叠、移动组后插件不反复写回；删除 token 后该组停止管理 | FR-11 |
| AC-09 | 手动 ungroup/regroup 后重复事件、alarm、worker 重启均不抢回；设置中的恢复管理生效 | FR-12 |
| AC-10 | group/tab/window 删除、tab 替换和跨窗口拖动不会产生失效绑定、跨窗口拉回或未处理异常 | FR-13 |
| AC-11 | 开关默认为 true；关闭后无新分组动作且保留现有组；重开全量整理并保留 local 排除 | FR-14/15 |
| AC-12 | 同窗口 30 个同 tenant 并发新 tab 最终只有一个管理组；稳定后 100 次重复事件分组与外观写调用均为 0 | FR-16 |
| AC-13 | unknown production、custom Experience、欺骗 host 和 shared login 不被误归 tenant；标准 Experience 与同 tenant 管理页合组 | FR-17/18 |
| AC-14 | worker 在创建前后中断、session 恢复、group ID 重编号时按 journal/token 处理；歧义时保护且给降级原因 | FR-02/13/16 |
| AC-15 | popup 关闭或从未打开不影响所有上述行为；基础 Switcher 主动切换使用同 parser、移除敏感 query，并遵守用户组保护 | FR-20 |
| AC-16 | 检查发行权限、包内资源与网络日志：无页面注入、无后端请求、无远程执行代码、无认证数据日志 | 隐私与架构 |

性能测量基线：在无拖拽、无恢复歧义、API/存储无错误的测试机上，普通单 tab 事件从最终 URL 可见到分组完成 P95 ≤ 2 秒；5 窗口 500 tabs 的初始扫描与必要分组目标 ≤ 10 秒。记录机器、Chrome 版本、测试次数和 API 写入数。浏览器休眠、恢复延迟、alarm 延迟与 API 拒绝单列报告，不用计时器伪造实时保证。

补偿目标：事件遗漏或短计时器失效后，在下一次实际执行的 reconciliation alarm 完成时收敛；alarm 名义周期 1 分钟，Chrome 可延迟，不能将“60 秒内一定完成”作为平台保证。

## 16. 实现顺序与完成定义

1. 先实现 parser、tenant key 与 fixture，确认所有默认支持的域模板，不从广泛 suffix 识别开始。
2. 实现 storage/schema、ownership token、protected policy、manual override 与纯 planner。
3. 接入串行 executor、expected mutations、journal、错误恢复及事件矩阵；再加入 startup 与 alarm 补偿。
4. 完成 Vanilla settings/popup 和主动 Switcher；UI 不承担后台初始化职责。
5. 完成 Vitest、故障注入、真实 Chrome 多窗口／重启／worker 休眠验收及权限审查。

V1 完成须满足全部 FR 与 AC、类型检查、构建可加载、测试通过，并附实际测试记录。对 API 归属限制、手动排除会话范围、unsupported 域与恢复歧义如实显示；不得以“识别所有 Salesforce URL”或“production 已验证”作为发布描述。

## 17. 官方依据与设计决策边界

本文整合《Chrome插件需求可行性》中 SF Org Navigator 的 Org Switcher、自动 tenant 分组和轻量技术选型，并以当前请求确定自动化范围与边界。此前“打开插件后”的含义在本版明确为 Chrome 扩展启用且自动开关开启，绝非打开 popup。

Chrome API、worker 与 storage 生命周期，以及 Salesforce 域名格式属于外部事实；对应官方资料已在相关章节链接，核对日期为 2026-10-15。归属 token、用户保护策略、延迟时间、数据模型、默认范围与验收阈值是本规格的产品/工程决策，不代表 Chrome 或 Salesforce 官方保证。未来官方域名或 API 变更，应先更新 fixture、明确兼容范围，再升级实现。


## Inspector 页面按 host 归组（2026-10-16）

Salesforce Inspector / Inspector Reloaded 的 `chrome-extension://<extension-id>/<page>.html?host=<Salesforce hostname>` 页面按唯一的 `host` 参数归入对应 tenant，与 Lightning、Setup、My Domain 页面共用一个管理组。支持当前安装 ID `nobhcglociplekefjfpeaajecldpjlmn`、Inspector 商店 ID `aodjmnfhjibkcdimpodiifdjnnncaafh` 和 Reloaded 商店 ID `hpijlohoihegkfehhibggnkbjhoemldh`。工具页面不限定为 inspect 或 data-export；有效 HTML 工具页均可参与。

`host` 必须为单个裸 hostname，并通过现有 Salesforce 域名 allowlist 校验；缺失、重复、包含协议/路径/端口/凭据或未知域名的值不归因。普通网页和其他扩展的 `host` 参数不用于归组。只提取 tenant，不保存 Inspector 的查询、对象、record ID 或其他参数。此能力由 `parseTabTenant` 包装共享 Salesforce parser 实现，Inspector URL 不能成为 Org Switcher 的目标 origin，也不支持保留 Inspector 路径切换。

同 tenant 的 Inspector 成员不得触发 mixed-membership 释放归属；新增工具页应进入已有管理组，host 变更时按新 tenant 整理，worker 重启后仍可恢复。固定、手动排除和用户组保护规则继续生效。历史已释放或未知同名组不按名称自动接管；当前重复组由本次明确授权的修复合并。
