# OpenCode Railway Template

[English](./README.md)

部署到 Railway 的 OpenCode 模板，默认补齐生产环境真正需要的几件事：同版本前后端、浏览器友好的认证方式、空闲高内存自动重启，以及插件自动刷新。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/opencode?referralCode=Se0h8C&utm_medium=integration&utm_source=template&utm_campaign=generic)

## 这个模板的特点

1. **从源码构建，保证 Web 与 Core 版本一致**
   `SOURCE_MODE=true` 时，镜像会基于 `OPENCODE_REF` 拉取 OpenCode 源码，并同时构建 `packages/app` 和 `packages/opencode`，避免本地 backend 搭配上游 hosted frontend 的“混版本”问题。

2. **内置监控脚本，空闲且高内存时自动重启**
   `monitor.sh` 会检查空闲时长和内存占用。只有在服务已空闲一段时间、且内存超过阈值时，才会触发 Railway restart / redeploy，用较低代价回收内存。

3. **支持 sleeping 模式，进一步降低成本**
   `railway.toml` 默认启用了 `serverless = true`。服务长时间无请求时可以休眠，新的请求到来后再由 Railway 拉起。

4. **默认安装 `oh-my-openagent@latest`，重新部署时自动刷新**
   启动时会确保 `oh-my-openagent@latest` 被写入 OpenCode 配置；当 Railway deployment id 变化时，会清理插件缓存并重新拉取最新版。同一 deployment 内重启不会重复清缓存，因此启动更快。

5. **基于 cookie 的浏览器认证，对 Chrome / Safari 更友好**
   浏览器通过 `/login` 登录后拿到安全 session cookie；CLI 和自动化脚本仍可继续使用 HTTP Basic Auth。相比直接依赖浏览器 Basic Auth，这种方式对 Web UI、PWA、WebSocket 的兼容性更稳定。

## 快速部署

1. 点击上方 Railway 按钮部署。
2. 给服务挂载持久化卷到 `/data`。
3. 配置必需环境变量。
4. 打开 Railway 分配的域名。
5. 使用用户名 `opencode` 和你设置的密码登录。

`/data` 会持久化工作区、OpenCode 配置和运行状态。

## 必需环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | 必填。浏览器登录和 CLI Basic Auth 共用的密码。 |

## 常用可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SOURCE_MODE` | `true` | 推荐保留默认值。`true` 表示从源码构建并提供本地 Web 静态资源；`false` 表示安装 `opencode-ai@latest`，并回到上游 hosted frontend 行为。 |
| `OPENCODE_REF` | `v1.3.0` | `SOURCE_MODE=true` 时要构建的 OpenCode git ref。 |
| `OPENCODE_MODEL` | - | OpenCode 默认模型。 |
| `OPENCODE_SESSION_SECRET` | `OPENCODE_SERVER_PASSWORD` | 浏览器 session cookie 的签名密钥。多实例部署时建议显式设置。 |
| `AUTH_REALM` | `opencode.tradao.xyz` | Basic Auth realm，通常无需修改。 |
| `ENABLE_OH_MY_OPENCODE` | `true` | 是否自动注入 `oh-my-openagent@latest`。 |
| `ENABLE_OMO_DEFAULT_CONFIG` | `false` | 为 `true` 时，启动时用仓库内置的 `oh-my-opencode.default.json` 覆盖 oh-my 默认配置文件。 |
| `ENABLE_OPENCLAW_PLUGIN` | `false` | 为 `true` 时，向 `/data/.config/opencode/opencode.json` 注入 `@laceletho/plugin-openclaw`。 |
| `ENABLE_OMO_REDEPLOY_REFRESH` | `true` | Railway deployment id 变化时是否刷新 oh-my 插件缓存。 |
| `ENABLE_MONITOR` | `false` | 是否启用内存监控和自动重启。 |
| `LOG_LEVEL` | `WARN` | Wrapper 日志级别。 |
| `LOG_SLEEP_BLOCKERS` | `true` | 记录哪些入站和出站请求让 Serverless 服务保持唤醒，方便排查。 |

## 监控相关环境变量

这些变量只在 `ENABLE_MONITOR=true` 时需要关注。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | - | 监控脚本真正触发 Railway restart / redeploy 所需的 token。 |
| `IDLE_TIME_MINUTES` | `10` | 允许触发重启前所需的空闲时长。 |
| `MEMORY_THRESHOLD_MB` | `2000` | 只有内存高于该阈值时才会触发重启。 |
| `CHECK_INTERVAL_SECONDS` | `60` | 监控检查周期。 |

`RAILWAY_PROJECT_ID`、`RAILWAY_ENVIRONMENT_ID`、`RAILWAY_SERVICE_ID` 会由 Railway 自动注入。

## 认证方式

- 浏览器：访问 `/login` 后，由代理层发放 `Secure + HttpOnly + SameSite=Lax` 的 session cookie。
- CLI / 脚本：继续使用 HTTP Basic Auth。

示例：

```bash
curl -u opencode:YOUR_PASSWORD https://your-app.up.railway.app/global/health
opencode attach https://your-app.up.railway.app/ -p YOUR_PASSWORD
```

## 休眠与成本控制

- Railway Serverless 默认开启，空闲服务可自动休眠。
- `server.js` 会记录常见唤醒来源，方便排查为什么服务没有进入 sleep。
- 配合 `ENABLE_MONITOR=true` 后，还可以在“长期空闲 + 内存过高”时自动触发一次重启，降低内存占用。

这两层机制分别解决不同问题：

- `Serverless sleep`：降低空闲成本。
- `Memory monitor`：降低长期运行后的内存膨胀。

## 插件行为

- 模板默认会向 `/data/.config/opencode/opencode.json` 注入 `oh-my-openagent@latest`。
- 如果你也想自动注入 `@laceletho/plugin-openclaw`，设置 `ENABLE_OPENCLAW_PLUGIN=true`。
- 如果你想在启动时用仓库内置模板重建 oh-my 配置，设置 `ENABLE_OMO_DEFAULT_CONFIG=true`。
- 检测到新的 Railway deployment id 时，会清理缓存并重新拉取最新版 oh-my 插件。
- 同一个 Railway deployment 内的重启会保留插件缓存，以保证启动更快、行为更稳定。

如果你不想启用这套行为，可以设置：

```bash
ENABLE_OH_MY_OPENCODE=false
```

## 手动升级插件

OpenCode 会把 npm 插件缓存到 `~/.cache/opencode/packages/<spec>`。执行 `opencode plugin <pkg> --force -g` 会更新配置里的插件 spec，但它本身不会主动失效已经存在的 `@latest` 缓存目录。

如果你需要强制把某个已安装插件刷新到 npm 上最新发布的版本，推荐先删除对应缓存目录，再重新执行插件安装命令：

```bash
rm -rf ~/.cache/opencode/packages/@laceletho/plugin-openclaw@latest
opencode plugin @laceletho/plugin-openclaw --force -g
```

当 `@latest` 缓存已经陈旧时，这是升级 npm 型 OpenCode 插件的推荐手动流程。

对于 `oh-my-openagent`，这个模板已经在 Railway redeploy 时自动实现了同样的“删缓存再重拉”思路：

- 配置里始终保持 `oh-my-openagent@latest`
- 检测到新的 Railway deployment id 时，删除缓存的 `oh-my-openagent@latest` 包
- 下一次启动时重新拉取当前 npm 上最新发布的版本

这套机制本身就是适合模板场景的实现，不需要改成手工执行 `opencode plugin ... --force -g`。如果你想在不 redeploy 的前提下强制刷新同一个 deployment 里的插件版本，再使用上面的手动删缓存流程。

## 本地运行

```bash
npm install
OPENCODE_SERVER_PASSWORD=your-password \
ANTHROPIC_API_KEY=xxx \
npm run start
```

## 测试

```bash
npm test
```
