# 法律案件整理助手

法律 Agent 3.0 优化版。面向接案材料整理与关键节点准备，使用通用底座和可插拔的劳动法插件。

[在线公开展示](https://legal-case-workbench.vercel.app/) · 仅使用虚构材料。

## 运行

需要 Node.js 24.12 或更新的 24.x 版本。在项目根目录的 PowerShell 中运行。

```powershell
npm.cmd --prefix './底座' ci
npm.cmd --prefix './Web封装与上线/案卷工作台' start
```

打开 [本地案卷工作台](http://127.0.0.1:8787/)。使用模型时，在底座目录根据环境变量模板配置自己的 DeepSeek 密钥。

## 项目入口

- [设计、架构与实现规划](项目规划/project-note.md)
- [底座使用与插件契约](底座/README.md)
- [劳动法插件](劳动法插件/README.md)
- [接案与材料整理](接案与材料整理/README.md)
- [关键节点审查](关键节点审查与准备/README.md)
- [Web 工作台](Web封装与上线/案卷工作台/README.md)
- [Vercel 部署](Web封装与上线/案卷工作台/vercel/README.md)
