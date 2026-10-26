# 橙狸集 · OrangeTanuki Hub

收藏声音与影像，连接你的创作。

`orange-tanuki-hub` 是一个便携的个人素材目录与只读资源接口。基于 Node.js 原生 HTTP 服务，无第三方运行依赖，可在本机、Docker 或支持 Docker 的托管平台运行。

## 当前功能

- 浏览作品、角色、素材、模型及模型版本目录。
- 通过 JSON API 查询、筛选和分页，查看真实目录统计。
- 可选接入私有 Hugging Face 音频数据集：索引浏览、角色筛选、在线试听与 WAV/TXT 按需读取；不调用生成模型。
- 区分角色关联图片与独立图片，记录音频、完整文本及逐句情绪的对应关系。
- 提供网页、API 接入页面、OpenAPI 文档及健康检查。

本仓库的五个本地数据集合默认仍为空。**未配置音频仓库时，首页数字为零是预期结果**；配置有效的只读音频数据集后，现有 WAV 索引会自动加入作品、角色、素材列表及首页统计，并支持在线播放和下载。上传区域仍不可用，`POST /api/v1/uploads` 返回 `503 storage_not_configured`；没有通用写入存储、账号登录或模型推理服务。音色模型目录不等于在线语音生成。

## 快速运行

需要 Node.js 24 或更新版本及随附的 npm。以下命令均在项目根目录运行，无需先执行 `npm install`。

Windows PowerShell：

```powershell
npm.cmd test
npm.cmd start
```

Linux：

```sh
npm test
npm start
```

访问 <http://127.0.0.1:7860>。`npm start` 会读取当前工作目录下可选的 `.env`；文件不存在也能启动。本机默认监听 `127.0.0.1:7860`。

Docker：

```sh
docker build -t orange-tanuki-hub:local .
docker run --rm --name orange-tanuki-hub -p 127.0.0.1:7860:7860 orange-tanuki-hub:local
```

Docker Compose：

```sh
docker compose up -d --build
docker compose logs --tail=50
```

Compose 默认把主机 `127.0.0.1:7860` 映射到容器；可用 `HOST_PORT` 和 `BIND_ADDRESS` 调整。容器以非 root 用户运行。详细启动、挂载与停止方法见[部署说明](docs/deployment.md)。

## 配置与接口

常用应用配置为 `HOST`、`PORT`、`PUBLIC_ORIGIN` 和 `CATALOG_PATH`。目录在启动时校验并读入内存，运行时不会写回；修改 JSON 后需重启。配置外部 JSON 只会更换目录数据，不会启用上传或存储。详见[配置说明](docs/configuration.md)。

| 入口 | 用途 |
| --- | --- |
| `GET /healthz` | 健康检查 |
| `GET /api/v1/info`、`/api/v1/stats` | 站点信息、能力状态与统计 |
| `GET /api/v1/works`、`/api/v1/characters` | 作品与角色 |
| `GET /api/v1/assets`、`/api/v1/assets/{id}` | 素材查询与详情 |
| `GET /api/v1/models`、`/api/v1/models/{id}/versions` | 模型及版本元数据 |
| `GET /docs/openapi.json` | 完整接口说明 |
| `GET /api/v1/audio/games` | 查询远程音频仓库加载状态与条目数量 |
| `GET /api/v1/audio/characters?game=...` | 查询指定作品的音频角色 |
| `GET /api/v1/audio/clips?game=...&character=...` | 查询指定角色音频，分页 |
| `GET /api/v1/audio/voice?game=...&character=...&clip_id=...` | 获取已有 WAV 音频（或 output=text 获取对应 TXT） |

例如，`/api/v1/assets?type=image&image_scope=standalone` 只查询独立图片。空目录正常返回空数组和零统计；不存在的详情资源返回 `404`，非法参数返回 `400`。

## 项目布局

```text
server.mjs                   HTTP 服务、只读 API 与静态文件入口
config.mjs                   环境变量校验与路径配置
public/                      页面、样式、脚本与品牌图形
data/catalog.json            默认空目录
docs/openapi.json            API 与目录数据结构
docs/configuration.md        环境变量与目录配置
docs/deployment.md           本机、Docker、Compose 部署
deploy/huggingface/README.md  Hugging Face 专用 README 模板
tests/                      接口、路径安全及配置测试
Dockerfile                  通用非 root 容器
compose.yaml                Compose 启动配置
compose.catalog.yaml        外部目录只读挂载覆盖配置
```

仓库根 README 不绑定特定平台。Hugging Face Docker Space 元数据放在[专用模板](deploy/huggingface/README.md)。源码、文档和配置均可独立使用，本地整理或打包不会自动创建仓库、推送代码或部署服务。

本程序没有内置鉴权；`package.json` 的 `private: true` 仅防止误发布 npm 包，不保护运行实例。迁出私有 Space 后，平台原有访问控制不会随源码迁移。对外部署前应由平台或反向代理提供所需鉴权；`PUBLIC_ORIGIN` 也不是鉴权开关。

不要将真实素材、私有目录、运行记录或凭据加入源码版本库。新增目录数据须遵循 [OpenAPI 数据结构](docs/openapi.json)，而不是把文件放进 `public/` 来模拟已实现存储。


## 私有仓库音频接入

此项目只有**通用读接口**，不包含用户的 Hugging Face 私有数据集清单、音频文件或 Token。

- 通过私有环境变量 `VOICE_HF_TOKEN` 提供只读权限，不要上传到 GitHub，也不要发送到聊天。
- 单一默认仓库使用 `VOICE_DATASET_ID` 和固定 40 位 `VOICE_DATASET_REVISION`。
- 多个仓库使用 `VOICE_DATASETS_JSON`（数组），参考 `voice-datasets.example.json`；或在私有运行环境提供未跟踪的 `voice-datasets.json`。
- 默认缓存位于临时目录，数据按需下载；浏览目录不需要下载全部 WAV，也不需要 GPU。
- 模型和 Dataset 仍为原始私有资源。部署为公开网站前必须配置服务端鉴权，否则接口会向访客提供可以检索和播放的内容。
- 如需更新数据集版本，应先验证新版 `api-index.jsonl`；仅修改 `revision` 不会自动产生有效索引。

首次部署请检查 `GET /api/v1/audio/games` 是否显示各作品 `ready` 及正确数量，再检查 `/api/v1/stats` 与页面在线试听。详细配置见 [配置说明](docs/configuration.md)。

部署前可按[私有音频验收](docs/private-audio-verification.md)运行隔离的只读检查，核对索引、统计、分页及每个作品的一组 WAV/TXT；脚本结果不代替电脑和手机试听。
