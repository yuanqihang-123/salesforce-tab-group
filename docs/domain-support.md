# 域名支持与核对依据

核对日期：2026-10-15。以下为 Salesforce 商业云增强域名的显式 allowlist；每一行的 4 种 surface 均已启用。`D` 表示完整有效 DNS label，`P` 表示对应分区；host 必须精确匹配，不允许额外子域。

| 分区            | My Domain                        | Lightning                          | Setup                                  | Experience Cloud           | 官方格式依据                                                                                                                                                         |
| --------------- | -------------------------------- | ---------------------------------- | -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unpartitioned` | `D.my.salesforce.com`            | `D.lightning.force.com`            | `D.my.salesforce-setup.com`            | `D.my.site.com`            | [My Domain URL Formats](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=sf.domain_name_url_formats.htm)                                           |
| `sandbox`       | `D.sandbox.my.salesforce.com`    | `D.sandbox.lightning.force.com`    | `D.sandbox.my.salesforce-setup.com`    | `D.sandbox.my.site.com`    | [Sandbox Partitioned Domains](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=xcloud.domain_name_partitioned_domains_sandbox.htm)                 |
| `develop`       | `D.develop.my.salesforce.com`    | `D.develop.lightning.force.com`    | `D.develop.my.salesforce-setup.com`    | `D.develop.my.site.com`    | [Developer Edition Partitioned Domains](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=xcloud.domain_name_partitioned_domains_de.htm)            |
| `demo`          | `D.demo.my.salesforce.com`       | `D.demo.lightning.force.com`       | `D.demo.my.salesforce-setup.com`       | `D.demo.my.site.com`       | [Demo Partitioned Domains](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=xcloud.domain_name_partitioned_domains_demo.htm)                       |
| `patch`         | `D.patch.my.salesforce.com`      | `D.patch.lightning.force.com`      | `D.patch.my.salesforce-setup.com`      | `D.patch.my.site.com`      | [Patch 分区域名](https://help.salesforce.com/s/articleView?id=sf.domain_name_partitioned_domains_patch.htm&language=zh_CN&type=5)                                    |
| `scratch`       | `D.scratch.my.salesforce.com`    | `D.scratch.lightning.force.com`    | `D.scratch.my.salesforce-setup.com`    | `D.scratch.my.site.com`    | [Scratch Org Partitioned Domains](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=xcloud.domain_name_partitioned_domains_scratch.htm)             |
| `trailblaze`    | `D.trailblaze.my.salesforce.com` | `D.trailblaze.lightning.force.com` | `D.trailblaze.my.salesforce-setup.com` | `D.trailblaze.my.site.com` | [Trailhead Playground Partitioned Domains](https://help.salesforce.com/s/articleView?language=en_US&type=5&id=xcloud.domain_name_partitioned_domains_playground.htm) |

分区总览见 [Partitioned Domains](https://help.salesforce.com/s/articleView?id=sf.domain_name_partitioned_domains.htm&language=en_US&type=5)。patch 使用已核对格式表的官方中文页面；英文 xcloud 路径读取失败不作为验证依据。

## 身份与限制

`tenantKey = sf:commercial:<partition>:<完整 D>`。同一 D 与分区的 4 个 surface 合组；不同分区、不同完整 D 始终分开。Experience Cloud 的站点路径不参与身份。

例如 `acme--pesdev.sandbox.lightning.force.com` 与 `acme--pesdev.sandbox.my.site.com/partners/s/` 都得到 `sf:commercial:sandbox:acme--pesdev`。`other--pesdev`、`acme--uatpes` 和 `unpartitioned:acme` 均为独立身份。不截断 `--` 后缀；sandbox 的 D 必须包含非空 `MyDomainName--SandboxName`。普通分区中包含 `--` 的含糊旧格式保守跳过。

只接受 HTTPS、无用户名/密码、无非默认端口的 URL。hostname 转小写并可移除单个末尾根域点；拒绝无效 label、IDN/punycode、未知分区和额外子域。path/query/hash 不用于 tenant 归因。没有 sandbox 分区不代表 production，也不证明页面已经登录。

以下不自动归因：共享入口 `login.salesforce.com` / `test.salesforce.com`、instance host、旧 sandbox 域、Visualforce/文件/CDN、旧 `*.force.com` 站点、自定义域、Government Cloud 及其他未列出云域。欺骗 host（如 `acme.my.site.com.evil.example`）、userinfo 和路径中出现 Salesforce 字样均不能进入支持范围。

## Fixtures 与变更要求

支持模板的 28 个正例及反例位于 [`tests/fixtures/urls.ts`](../tests/fixtures/urls.ts)，由 [`tests/parser.test.ts`](../tests/parser.test.ts) 校验。实现位于 [`src/shared/salesforce/urlParser.ts`](../src/shared/salesforce/urlParser.ts)，其中 `verifiedSurfaces` 明确列出各分区允许的 surface。

新增域名格式时先核对对应 Salesforce 官方格式表，再同时更新本表、正反 fixtures 和 parser allowlist；不能根据通用 suffix 或命名相似性自动扩展范围。这里验证的是 URL 格式，真实 Salesforce 登录、站点行为与浏览器恢复仍需独立验收。

## Inspector 页面按 host 归组（2026-10-16）

Salesforce Inspector / Inspector Reloaded 的 `chrome-extension://<extension-id>/<page>.html?host=<Salesforce hostname>` 页面按唯一的 `host` 参数归入对应 tenant，与 Lightning、Setup、My Domain 页面共用一个管理组。支持当前安装 ID `nobhcglociplekefjfpeaajecldpjlmn`、Inspector 商店 ID `aodjmnfhjibkcdimpodiifdjnnncaafh` 和 Reloaded 商店 ID `hpijlohoihegkfehhibggnkbjhoemldh`。工具页面不限定为 inspect 或 data-export；有效 HTML 工具页均可参与。

`host` 必须为单个裸 hostname，并通过现有 Salesforce 域名 allowlist 校验；缺失、重复、包含协议/路径/端口/凭据或未知域名的值不归因。普通网页和其他扩展的 `host` 参数不用于归组。只提取 tenant，不保存 Inspector 的查询、对象、record ID 或其他参数。此能力由 `parseTabTenant` 包装共享 Salesforce parser 实现，Inspector URL 不能成为 Org Switcher 的目标 origin，也不支持保留 Inspector 路径切换。

同 tenant 的 Inspector 成员不得触发 mixed-membership 释放归属；新增工具页应进入已有管理组，host 变更时按新 tenant 整理，worker 重启后仍可恢复。固定、手动排除和用户组保护规则继续生效。历史已释放或未知同名组不按名称自动接管；当前重复组由本次明确授权的修复合并。
