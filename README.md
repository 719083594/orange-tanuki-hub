# 橙狸集 · OrangeTanuki Hub

收藏声音与影像，连接你的创作。

`orange-tanuki-hub` 是一个便携的个人素材目录与只读资源接口。基于 Node.js 原生 HTTP 服务，无第三方运行依赖，可在本机、Docker 或支持 Docker 的托管平台运行。

## 当前功能

- 浏览作品、角色、素材、模型及模型版本目录。
- 通过 JSON API 查询、筛选和分页，查看真实目录统计。
- 区分角色关联图片与独立图片，记录音频、完整文本及逐句情绪的对应关系。
- 提供网页、API 接入页面、OpenAPI 文档及健康检查。

这是**结构版**：随仓库提供的五个数据集合均为空，没有导入素材或模型。上传区域仅说明尚未实现的能力；`POST /api/v1/uploads` 返回 `503 storage_not_configured`，不会写入文件。当前没有素材存储、下载传输、数据库、账号登录或模型推理功能；模型目录不等于在线声音生成。

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
