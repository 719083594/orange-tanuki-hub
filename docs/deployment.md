# 部署说明

本项目不依赖特定云服务。以下命令在项目根目录执行，启动的是目录查询服务，不会导入素材、开通存储或上传文件。

## 本机运行

需要 Node.js 24 或更新版本及 npm，可用 `node --version` 核对。项目没有第三方运行依赖，无需 `npm install`。

Windows PowerShell：

```powershell
npm.cmd run check
npm.cmd test
npm.cmd start
```

Linux：

```sh
npm run check
npm test
npm start
```

默认访问 <http://127.0.0.1:7860>，终端按 `Ctrl+C` 停止。`npm start` 读取可选 `.env`，详见[配置说明](configuration.md)。本机默认只监听回环地址。

## Docker

需要可用的 Docker 引擎。Windows 与 Linux 均可使用：

```sh
docker build -t orange-tanuki-hub:local .
docker run --rm --name orange-tanuki-hub -p 127.0.0.1:7860:7860 orange-tanuki-hub:local
```

此例只向主机回环地址发布端口。镜像使用 Node.js 24，以非 root 用户运行；容器内绑定 `0.0.0.0:7860`。

需要后台运行时，用下面的命令替换第二条：

```sh
docker run -d --name orange-tanuki-hub -p 127.0.0.1:7860:7860 orange-tanuki-hub:local
docker logs --tail=50 orange-tanuki-hub
```

停止：

```sh
docker stop orange-tanuki-hub
```

### 只读外部目录

以下示例挂载已有的目录 JSON，不挂载整个素材库。替换源文件路径即可。

Windows PowerShell：

```powershell
$catalog = (Resolve-Path '.\data\catalog.json').Path
docker run --rm --name orange-tanuki-hub -p 127.0.0.1:7860:7860 --mount "type=bind,source=$catalog,target=/app/runtime/catalog.json,readonly" -e CATALOG_PATH=/app/runtime/catalog.json orange-tanuki-hub:local
```

Linux：

```sh
docker run --rm --name orange-tanuki-hub -p 127.0.0.1:7860:7860 --mount "type=bind,source=$(pwd)/data/catalog.json,target=/app/runtime/catalog.json,readonly" -e CATALOG_PATH=/app/runtime/catalog.json orange-tanuki-hub:local
```

容器用户须有文件读取权限。改变 JSON 后重启容器；应用不会写回目录。

## Docker Compose

需要 Docker Compose v2。默认服务名为 `hub`：

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50
```

默认端口映射为 `127.0.0.1:7860:7860`。主机端口改为 `8788`：

```powershell
$env:HOST_PORT = '8788'
docker compose up -d --build
```

Linux：

```sh
HOST_PORT=8788 docker compose up -d --build
```

也可在项目 `.env` 中设置 `HOST_PORT=8788`。用 `BIND_ADDRESS` 改变主机绑定地址，例如对外提供服务时设为 `0.0.0.0`，并配置访问控制。容器内部仍使用 `0.0.0.0:7860`。

### Compose 外部目录覆盖配置

Windows PowerShell：

```powershell
$env:CATALOG_FILE = (Resolve-Path '.\data\catalog.json').Path
docker compose -f compose.yaml -f compose.catalog.yaml up -d --build
```

Linux：

```sh
CATALOG_FILE="$(pwd)/data/catalog.json" docker compose -f compose.yaml -f compose.catalog.yaml up -d --build
```

`CATALOG_FILE` 是主机 JSON 文件路径。覆盖配置将它只读挂载到 `/app/runtime/catalog.json`，无需另设容器中的目录路径。后续 `logs`、`restart`、`down` 操作应使用相同的两个 `-f` 参数，并保持 `CATALOG_FILE` 设置可用。

默认配置停止命令：

```sh
docker compose down
```

外部目录配置停止命令：

```sh
docker compose -f compose.yaml -f compose.catalog.yaml down
```

## 反向代理与访问控制

部署在独立域名的**根路径**：网页及 `/api/v1/` 使用根绝对路径，当前没有实现 `/hub/` 等子路径部署。由反向代理或托管平台提供 HTTPS，并按需设置 `PUBLIC_ORIGIN` 为实际公开 origin。

应用没有内置登录。平台私有访问控制、代理鉴权及防火墙是独立部署配置；复制源码或镜像不会复制这些权限。浏览器同源策略及 `PUBLIC_ORIGIN` 都不能替代鉴权。

迁出 Hugging Face 私有 Space 后，先完成新环境的访问控制，再开放服务。新的 Space 使用[专用 README 模板](../deploy/huggingface/README.md)，并在平台独立设置可见性；不要把个人令牌放入源码。

## 启动后验证

PowerShell：

```powershell
Invoke-RestMethod 'http://127.0.0.1:7860/healthz'
Invoke-RestMethod 'http://127.0.0.1:7860/api/v1/info'
```

Linux：

```sh
curl --fail http://127.0.0.1:7860/healthz
curl --fail http://127.0.0.1:7860/api/v1/info
```

若改变主机端口，同步调整验证地址。预期健康检查返回 `status: "ok"`，默认统计为零，存储状态为 `configured: false`、`upload_enabled: false`。

这些是部署与验收命令，不代表已在当前机器实际运行 Docker。网页和查询接口成功也不表示已经具备素材存储、上传或下载功能。
