# CPA 使用统计插件

[English](README.md)

`cpa-usage-statistics` 是一个独立的 CPA 原生插件。安装并启用后，CPA 管理中心左侧会自动出现 **「使用统计」**；页面、采集逻辑和 SQLite 存储均由插件提供。版本：`0.1.3`。

## 包含的功能

- 请求事件总览、成功/失败、耗时、RPM/TPM、趋势图和请求健康热图。
- 模型、客户端 API Key、已观测凭据维度的统计，以及请求明细筛选、CSV/JSON 导出。
- 请求事件明细右上角“显示列”可选择要显示的列，支持“显示全部”，当前浏览器自动记住选择；至少保留一列，导出仍包含全部字段。
- 输入、缓存读取、缓存写入、输出、推理与未分类 Token 的分类展示。
- 模型输入/输出/缓存单价和统计日界时区设置；按当前价格计算费用估算。
- 插件自有 SQLite 持久化、用量 JSON 备份导出和旧版用量 JSON 导入。
- 中文、英文、俄文，以及跟随管理中心的主题和语言。

这是一套独立的 Go 模块和 `web/` 前端工程，没有宿主 Go 源码依赖。前端构建为一个 HTML 并嵌入 `.so`，安装时不需要额外的前端服务器或 PostgreSQL。

## 宿主兼容条件

需要当前 CPA v7 后端的原生插件加载器，以及已接入插件页面通信桥的独立 CPA 管理中心。**仅安装插件文件不会给旧管理中心补上通信桥。** 本目录的 `integrations/` 保存宿主适配补丁，部署时应使用已经合入对应修改的后端和管理中心：

1. 后端通过公开的插件用量事件提供规范化 `TokenBreakdown`。
2. 管理中心为插件页面提供 `cpa-plugin-bridge` v1 通信，注册受限的接口调用，并跟随当前登录会话。插件 v0.1.3 还需要本版本集成补丁中的 `GET /client-keys` 显示目录支持。

首次版本提供 **Linux amd64** 原生动态库。宿主须启用原生插件支持；动态库的系统 C 运行库要求由实际构建环境决定。其他 CPU/操作系统和 CLIProxyAPIHome 页面入口未在此版本验证。

## 安装并在左侧打开

已配置下文插件商店源时，可在「插件商店」安装「使用统计」，随后到「插件管理」配置并启用。也可从本仓库的 `releases/0.1.3/` 取得 ZIP，核对 `checksums.txt`，将根目录的 `cpa-usage-statistics.so` 放入宿主的插件目录。

在宿主配置文件中合并以下配置。使用现有插件时保留原有 `configs` 条目；`data_dir` 建议填写宿主服务用户可写的持久化绝对路径。

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    cpa-usage-statistics:
      enabled: true
      data_dir: "/var/lib/cpa/cpa-usage-statistics"
      retention_days: 0
```

按宿主的加载流程重新加载配置，必要时重启服务，刷新管理中心。左侧新增 **「使用统计」** 后点击即可。发起一次模型调用并在页面刷新，验证统计开始累积。禁用插件后，侧栏入口会隐藏。

| 插件配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 在插件管理中启用；还须开启全局 `plugins.enabled` |
| `data_dir` | `data/cpa-usage-statistics` | 相对路径以宿主进程工作目录为基准；保持升级前后路径一致 |
| `retention_days` | `0` | `0` 不自动删除；正数按天删除过期事件，启动和每小时执行 |

数据库放在独立数据目录中。升级插件文件或停止插件不会主动删除这个目录。数据备份可使用页面导出；备份原始 SQLite 文件时应停止宿主或使用 SQLite 在线备份方式，避免遗漏 WAL 中的数据。

## 统计与历史导入的口径

统计单位是宿主发出的**用量事件**；重试或额外模型计量可能使一次 HTTP 请求产生多个事件。插件开始启用后采集新的事件，仓库源代码不包含旧系统的生产历史。

从旧系统导出 `/usage/export` 的版本 0/1 JSON，再在插件页面导入。导入按明细重建统计并去重。旧版导出不包含价格与时区时，需要在插件中另行设置；本插件的导出会带上自身的价格与时区。旧版未提供可靠规范分类时，保存原始字段并标记旧版口径；页面允许按旧字段近似展示 Token 与费用，并以 `≈` 标识。近似结果不能恢复缺失的缓存读写分类；实时事件的未知分类仍按未分类处理。

价格单位是每百万 Token，金额是按**当前配置价格重新估算历史事件**的结果。缺少模型价格、存在未分类 Token，或出现未配置独立价格的缓存写入时，页面会标记估算不完整。插件没有实现旧系统的 API Key 日消费限制或历史账单锁价。

API Key、来源和凭据标识在持久化前转换为稳定指纹。管理中心根据当前配置的客户端 Key 计算相同指纹，只向插件页面提供对应 Key 的掩码。API Key 详细统计和请求明细的客户端来源均显示真实 Key 的掩码，不再显示被再次遮罩的指纹。该映射同样适用于既有历史记录；当前配置中已删除或无法匹配的 Key 显示“未匹配 Key”及短指纹。完整 Key 不传给 iframe，也不写入插件数据库。凭据视图展示已经观测到的标识，不提供旧系统中人工备注的自动迁移。首次版本采用完整兼容快照和浏览器统计方式；请求表格按每页 100 条进行客户端分页，可翻页查看全部匹配事件，导出包含当前筛选匹配的事件。后端虽提供明细分页参数，页面尚未改为面向大数据量的服务端分页与聚合。

实时写入使用 4096 容量的内存队列与 SQLite 后台写入。`health` 接口提供队列、丢弃和写入错误信息。进程异常退出可能丢失尚未落库的事件，故费用用于统计估算。

## 页面认证

`/v0/resource/plugins/cpa-usage-statistics/index.html` 仅返回静态页面。统计接口位于 `/v0/management/plugins/cpa-usage-statistics/`，受宿主管理认证保护。

管理中心通过父页面代发受限的数据请求，不把管理密钥写进插件 URL 或交给 iframe。直接在浏览器打开资源 URL 会显示连接管理中心的提示，应从 CPA 左侧入口进入。

| 方法 | 相对接口 | 用途 |
| --- | --- | --- |
| `GET` | `usage` | 兼容用量快照；支持时间、API、模型、状态筛选，以及 `page`/`page_size`/`details` |
| `GET` | `usage/export` | 包含价格和时区的用量 JSON 导出 |
| `POST` | `usage/import` | 导入版本 0/1 用量 JSON |
| `GET` / `PUT` | `billing` | 读取/保存模型价格与日界时区 |
| `GET` | `sources` | 查询已观测标识 |
| `GET` | `health` | 查询插件写入与队列状态 |

`GET /client-keys` 是管理中心通信桥提供的只读显示目录，返回 `{keys:[{id,label}]}`。父页面使用当前管理会话读取客户端 Key，计算指纹与掩码后返回；它不是插件原生后端接口，不能通过拼接管理 API URL 调用。

## 独立构建和打包

要求：Linux amd64、Go **1.26 或更高**、可用的 C 编译器、Node.js **22.12 或更高**、npm、Python **3.10 或更高**。Go 的自动工具链选择也可满足版本要求。

在插件目录运行：

```bash
python3 scripts/build.py --test
python3 scripts/package_release.py
python3 scripts/generate_registry.py
```

构建执行 `web/` 下的 `npm ci`、`npm run build`，再以 `CGO_ENABLED=1 go build -buildmode=c-shared` 编译独立插件。`--test` 同时执行前端与 Go 测试。已有前端产物时可使用 `--skip-web`；指定 Go 可执行文件可使用 `--go /path/to/go`。也可运行 `make` 完成构建、打包和 registry 生成。

生成文件：

```text
dist/cpa-usage-statistics.so
dist/build-info.json
dist/THIRD_PARTY_LICENSES.txt
releases/0.1.3/cpa-usage-statistics_0.1.3_linux_amd64.zip
releases/0.1.3/checksums.txt
registry.json
```

ZIP 根目录包含唯一一个插件动态库、文档、构建信息和许可证。SHA256 依据实际 ZIP 生成；registry 只声明实际打包的 Linux amd64 平台。

## GitHub 上传与插件商店

插件独立仓库为 `Nerva05251228/cpa-usage-statistics`，源码、构建脚本与 registry 位于仓库根目录。源码、集成补丁、版本 ZIP、校验和与 registry 一起纳入 Git，使用固定标签 `v0.1.3`。该模式使用商店原生的 schema v2 `direct` 安装，不依赖 GitHub Release API。

默认生成的商店源地址：

```text
https://raw.githubusercontent.com/Nerva05251228/cpa-usage-statistics/v0.1.3/registry.json
```

在 CPA 的额外插件源中添加这个地址，或将以下字段合并到宿主 `plugins` 下：

```yaml
store-sources:
  - "https://raw.githubusercontent.com/Nerva05251228/cpa-usage-statistics/v0.1.3/registry.json"
store-auth:
  - match: "https://raw.githubusercontent.com/Nerva05251228/cpa-usage-statistics/"
    apply-to: ["registry", "artifact"]
    type: github-token
    token-env: "CPA_PLUGIN_STORE_TOKEN"
```

**此仓库为私有仓库。** SSH key 可用于 `git clone/push`，不会为插件商店的 HTTPS 下载提供认证。商店自动安装需要为宿主进程设置具有该仓库内容读取权限的 `CPA_PLUGIN_STORE_TOKEN`；将其置于部署环境，不写入源代码、registry 或下载 URL。没有 HTTP token 时，可以通过已授权的 Git SSH 取得已发布 ZIP 后手动安装，不影响插件运行。

发布到不同仓库/标签/路径时，使用生成脚本的 `--repository`、`--ref`、`--plugin-path` 参数。仅在仓库确实公开时使用 `--public`。更新后应新增版本和标签，重新生成校验和，并更新商店源，不覆盖已经发布标签指向的内容。

## 许可证

MIT。原 CPA 使用统计页面基于 Luis Pater、Router-For.ME 的 MIT 项目及 `Nerva05251228/CPA` 定制源码改造。完整原始声明保存在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，发布 ZIP 另附构建时收集的依赖许可证。
