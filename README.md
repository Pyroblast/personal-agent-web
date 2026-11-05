# Personal Agent Web

一个在本机运行的个人助理。用同一段对话创建目标、安排提醒、补充进展和接收主动反馈。3.0 使用 DeepSeek Harness、TypeScript、React 和 SQLite，包含对话、目标、记忆、关心、设置五个入口。

## 快速启动

已验证环境为 macOS、Node.js 22.22.1、npm 和 Python 3。准备自己的 DeepSeek API key。以下命令在终端执行。

```sh
git clone https://github.com/Pyroblast/personal-agent-web.git
cd personal-agent-web
# 使用 nvm 的开发者可运行 nvm install && nvm use
npm ci
npm run setup:runtime
npm run check:dsh
npm run build
python3 scripts/configure.py
npm run local:open
```

配置命令隐藏密钥输入并写入本机私有数据目录。执行 local:open 后在 Chrome 打开启动入口一次即可收藏 http://127.0.0.1:4310/ 。首次入口含本机访问令牌，请勿分享。端口冲突时用 `PA_MVP_PORT=4320 npm run local:open`。使用 `npm run local:stop` 停止服务。修改配置或源码后，停止服务、重新构建并启动。

## 体验 3.0

- “两分钟后提醒我喝水，只提醒一次。”到点发送提醒，无须模型再判断一次。
- “请持续跟进本周五晚从杭州飞北京、周日晚返回杭州的出行目标。先整理准备清单，不订票、不付款，实际返回由我确认。”在目标页查看执行安排、成果和通知设置。可继续在对话里改期。
- “从明天起每天八点半给我三条科技简报，提前十分钟准备，允许联网。”公开网页搜索、模型和后台工作会使用自己的 API 配置。关心开启后按半小时检查，有值得联系的内容时发到对话。

Mac 需要保持唤醒且后台运行。关闭浏览器后可以继续执行，重新打开能看到交付。消息、记忆、目标、访问令牌和运行记录只随本机数据目录生成。对话、授权的工作上下文和搜索请求会按功能发送到相应的模型或搜索服务。本项目面向单用户 localhost 使用。

## 二次开发

`src/server.ts` 提供本地 API，`src/engine.ts` 管理模型调用与后台执行，`src/work.ts` 和 `src/work-schema.ts` 负责目标、任务、成果和交付，`runtime/` 定义提示与受限工具，`ui/` 为 React 前端。运行 `npm test` 做回归，`npm run build` 检查类型并生成前后端产物。DSH 与 SDK 固定为 0.2.2-alpha.2，使用项目内独立 Node 24.11.1。请只提交源码和合成测试，避免提交数据库、密钥、运行日志和个人对话。

项目源码采用 MIT 许可证。第三方依赖通过 npm 安装，适用各自许可证。
