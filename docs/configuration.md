# 配置说明

## 环境变量

`npm start` 使用 Node.js 24+ 的可选环境文件支持，读取**进程当前工作目录**中的 `.env`。文件不存在时使用环境变量或默认值；进程已有的同名变量优先。直接执行 `node server.mjs` 不会自动加载 `.env`，需自行传入环境变量。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本机监听地址；Dockerfile/Compose 在容器内显式设为 `0.0.0.0` |
| `PORT` | `7860` | 应用监听端口，整数 `1`–`65535` |
| `PUBLIC_ORIGIN` | 未设置 | 可选对外 HTTP(S) origin，用于同源预检判断 |
| `CATALOG_PATH` | 项目内 `data/catalog.json` | 可选外部目录 JSON；相对路径以进程当前工作目录为基准 |
| `HOST_PORT` | `7860` | 仅 Compose 使用的主机映射端口 |
| `BIND_ADDRESS` | `127.0.0.1` | 仅 Compose 使用的主机端口绑定地址 |
| `CATALOG_FILE` | 由使用者提供 | 启用 `compose.catalog.yaml` 时，要只读挂载的主机 JSON 文件 |

可将根目录的 `.env.example` 复制为 `.env` 后修改。一个最小配置为：

```dotenv
HOST=127.0.0.1
PORT=7860
PUBLIC_ORIGIN=
CATALOG_PATH=
```

`PUBLIC_ORIGIN` 和 `CATALOG_PATH` 留空表示使用默认行为。不要提交 `.env` 或私有数据。应用无需 API 密钥；不要将其他服务的凭据写入目录 JSON、网页或配置示例。

### 监听地址与对外 origin

`HOST` 决定绑定哪个网络接口，`PUBLIC_ORIGIN` 不改变监听地址或端口。后者必须是纯 HTTP(S) origin，例如 `https://hub.example.com` 或 `http://localhost:7860`，不包含用户名、密码、路径、查询参数或片段。

服务只接受匹配来源的跨域预检，不提供 `Access-Control-Allow-Origin: *`。反向代理终止 HTTPS 时，可将该变量设为浏览器实际使用的 HTTPS origin。它不验证用户身份，也不会阻止非浏览器客户端读取公开接口；私有部署需要平台或代理层鉴权。

本机临时换端口：

```powershell
$env:PORT = '8788'
npm.cmd start
```

Linux 等价写法：

```sh
PORT=8788 npm start
```

如需从其他设备访问，另行设置合适的监听地址、网络规则及访问控制。

## 目录数据

默认目录的 `schema_version` 为 `1.0`，包含 `hub`、`storage` 及五个集合：

| 集合 | 内容 |
| --- | --- |
| `works` | 作品 |
| `characters` | 角色及所属作品 |
| `assets` | 素材元数据 |
| `models` | 模型元数据 |
| `model_versions` | 版本、框架、依赖和文件元数据 |

启动时读取并校验整个 JSON，之后查询使用内存快照。文件不存在、JSON 无效、字段不支持或引用关系不合法时，启动失败；程序不会悄悄退回空目录，也不会修改原文件。更新数据后需重新启动，当前没有热加载或管理写入接口。

`CATALOG_PATH` 可以是绝对路径，也可以是相对当前工作目录的路径。它不改变网页或 OpenAPI 文件的位置，也不会开放任意磁盘文件的访问。

### 绑定约束

- 每个集合的 ID 唯一，角色引用的作品必须存在。
- 每张图片必须有 `image_scope`。`character` 图片引用有效角色和该角色所属作品；`standalone` 图片的 `work_id`、`character_id` 为空或不存在。非图片不能带此字段。
- 音频的 `audio_text` 可记录稳定来源 ID、完整文本和句子／发声单元。字符范围采用 Unicode 码点的左闭右开区间，须连续覆盖全文；待确认标签需明确标记，不能用空标签冒充完成。
- 模型版本引用现有模型，并记录框架、依赖、文件大小与 SHA-256。这里只描述元数据，不加载或运行模型。
- 当前 `storage.configured`、`storage.upload_enabled` 必须为 `false`，文件元数据的 `download_url` 必须为空。改成 `true` 或填入地址不会实现存储功能，而会被校验拒绝。

精确字段、查询参数、错误结构和分页约束见 [OpenAPI 文档](openapi.json)。真实音频、图片、模型文件的存储和传输不在本版实现范围内。

## 容器配置

直接 `docker run` 时，主机 `.env` 不会自动进入容器。使用 `-e` 传入所需变量，或提供仅含所需变量的 `--env-file`。不要把本机配置中的 `HOST=127.0.0.1` 原样用于容器；容器应用需绑定 `0.0.0.0` 才能通过端口映射访问。

Compose 使用项目 `.env` 做插值，但只有 `compose.yaml` 显式声明的变量会进入容器。`HOST_PORT`、`BIND_ADDRESS` 控制主机映射；容器内部固定使用 `0.0.0.0:7860`。

要使用外部目录，启用 `compose.catalog.yaml` 并设置 `CATALOG_FILE` 为主机文件路径。覆盖配置将文件只读挂载到 `/app/runtime/catalog.json`，并为容器设置 `CATALOG_PATH=/app/runtime/catalog.json`。不要把主机路径直接当成容器路径。完整命令见[部署说明](deployment.md)。


## 私有音频数据集（可选只读能力）

先前静态 `data/catalog.json` 的五个集合仍可使用；若配置成功加载远程音频数据集，作品、角色、素材接口及统计将合并对应的虚拟条目。页面只请求已建索引，实际音频在播放时才下载并缓存。

必备：`VOICE_HF_TOKEN`（仅授权访问指定私有 Dataset 的只读 Token）、`VOICE_DATASET_ID`、`VOICE_DATASET_REVISION`（40 位完整 SHA）。多作品需要将一个 JSON 数组放在私有环境变量 `VOICE_DATASETS_JSON` 中，或在运行时提供 `voice-datasets.json`；字段格式见 `voice-datasets.example.json`，不要把真实私有映射提交到公开 GitHub。

可选配置：`VOICE_CACHE_DIR`（默认系统临时目录）、`VOICE_CACHE_MAX_BYTES`（默认每个数据集 64 MiB）、`VOICE_MAX_FILE_BYTES`（默认 64 MiB）、`VOICE_MAX_INDEX_BYTES`（默认 256 MiB）、`VOICE_DOWNLOAD_TIMEOUT_MS`（默认 120000）、`VOICE_MAX_DOWNLOADS`（默认每个数据集最多 3 次并发下载）。

注意：缓存配额按数据集实例分别计算。Compose 的 `/tmp` 容量为 768 MiB，实际配置的仓库数量、缓存上限与运行内存必须一起核算；缓存不是永久存储。

每个运行进程必须使用独立的 `VOICE_CACHE_DIR`，不要让多个实例并发写同一目录。重启时会恢复当前数据集版本中已完成缓存文件的容量统计，并根据文件时间淘汰超额文件；符号链接、子目录、未识别文件及遗留 `.part` 文件不会被当作已完成缓存处理。异常终止留下的临时文件应由运行环境按临时文件策略清理，缓存配额不代替磁盘或容器容量上限。

读接口：`/api/v1/audio/games`、`/health?game=<id>`、`/characters?game=<id>`、`/clips?game=<id>&character=<角色>&page=1&limit=20`、`/voice?game=<id>&character=<角色>&language=zh&clip_id=<64位ID>`。绝不把 Token 放入浏览器链接中。若 Space 本身为私有，浏览器还必须有对应平台权限。

多数据集配置失败时 `configuration_error` 返回 `true`；单个数据集 `unavailable` 不会阻断其他数据集。只读查询无需上传音频。API 参数检验保持严格，URL 尾部不得随意添加 `utm_source` 等未知参数。

注意：公开 GitHub 代码**不等于**公开音频访问授权；如果将应用部署在公共域名，必须先配置独立鉴权层。对于 Space 生产环境，先从独立开发分支验证，再由仓库所有者决定是否替换当前运行版本。
