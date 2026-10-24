---
title: 橙狸集
emoji: 🍊
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
short_description: 收藏声音与影像，连接你的创作。
pinned: false
---

# 橙狸集 · OrangeTanuki Hub

收藏声音与影像，连接你的创作。

此文件是 **Hugging Face Docker Space 专用根 README 模板**。普通源码仓库根 README 保持平台无关；准备独立 Space 部署副本时，将本文件放到该副本根目录并命名为 `README.md`。

## 部署布局

部署副本保留项目根布局：`Dockerfile`、`package.json`、`config.mjs`、`server.mjs`、`public/`、`data/` 和 `docs/openapi.json`。Dockerfile 仍位于根目录，不要只上传本模板所在目录。其他文档与测试可一并保留。

平台使用 Docker SDK，依据根 Dockerfile 构建。镜像中的应用绑定 `0.0.0.0:7860`，与上方 `app_port` 一致，并以非 root 用户运行。修改端口时需同时调整应用与平台配置。

按需在平台设置 `PUBLIC_ORIGIN` 为实际对外 origin。不要把个人令牌写进 README、网页或目录 JSON。本模板不绑定账号、Space ID、硬件规格或私有存储，不包含许可声明；本地保存模板不会创建 Space、推送代码或改变远端权限。

## 功能范围

当前提供网页及只读目录 API：作品、角色、素材元数据、模型与版本、筛选和统计。默认集合全空。健康检查是 `/healthz`，接口说明是 `/docs/openapi.json`。

尚未实现素材存储、上传、文件下载传输、数据库或模型推理。`POST /api/v1/uploads` 返回 `503 storage_not_configured`；设置外部目录 JSON 不会启用这些能力。目录仅在启动时读取，修改后需重启。

运行磁盘不是本项目已实现的持久素材库。实际保存和传输文件需要另行实现并验证；本模板不提供存储适配器，也不承诺平台存储额度或费用。

## 私有访问与迁移

Space 的私有可见性及访问权限由 Hugging Face 平台控制，必须在平台单独设置。本程序自身没有登录或令牌校验功能。

迁往普通 Docker、其他平台或自有服务器时，Hugging Face 的私有鉴权**不会随源码或镜像迁移**。需由新平台或反向代理配置访问控制；`PUBLIC_ORIGIN` 仅用于同源预检，不提供鉴权。应用目前要求根路径部署，不支持 `/hub/` 子路径。
