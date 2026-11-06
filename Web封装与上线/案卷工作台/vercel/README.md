# Vercel 部署

这套入口供个人内测和公开展示使用。Vercel Functions 运行底座和劳动法插件，私有 Vercel Blob 持久保存案卷。私有模式按账号隔离，每个工作区上限为 64 MiB，单份材料上限为 15 MiB。公开展示模式无需登录，以签名 Cookie 隔离浏览器，仅用于虚构材料。每个展示工作区上限为 8 MiB，单份材料上限为 2 MiB，展示实例最多接受 20 个可写浏览器，全站每天最多发出 24 次模型调用。Vercel Hobby 限于个人非商业用途。模型调用按模型账户计费。

## 准备发布目录

在本目录用 Node.js 24 运行以下命令。发布目录必须是新目录。

```powershell
node prepare.mjs '<尚不存在的发布目录>'
```

脚本根据白名单拷贝底座、插件、网页和云入口。部署时的案卷空间由新 Blob 存储提供。发布目录不含本机案件、语言缓存、密钥和历史构建产物。

## 关联 Vercel 项目

在发布目录运行。

```powershell
npx.cmd --yes vercel login
npx.cmd --yes vercel link
npx.cmd --yes vercel blob create-store legal-case-workbench-data --access private --region hkg1
```

创建或选择个人 Hobby 项目，并将私有 Blob 关联至该项目的 Production 环境，使服务获得存储凭据。函数默认运行在香港。生产 URL 需要在实际访客网络验收。

在 Production 环境设置以下服务端变量。

| 变量 | 用途 |
| --- | --- |
| `LAW_WEB_ACCOUNTS_JSON` | 登录账号的 JSON 密码散列，格式同 [服务器部署的账号文件](../deploy/README.md) |
| `LAW_WEB_PUBLIC_DEMO_SECRET` | 公开展示模式的签名密钥，至少 32 字节。配置后访客无需登录 |
| `LAW_WEB_PUBLIC_ORIGIN` | 使用自定义域名时填写 HTTPS 源地址。省略时使用 Vercel 提供的正式项目域名 |
| `BLOB_STORE_ID` | 新项目关联私有 Blob 时自动提供，SDK 使用 Vercel 托管的 OIDC 凭据 |
| `BLOB_READ_WRITE_TOKEN` | 旧存储连接使用的读写凭据，有 OIDC 连接时可省略 |
| `DEEPSEEK_API_KEY` | 模型密钥，启用接案核对时使用 |
| `DEEPSEEK_MODEL` | 可选，覆盖项目默认的模型名称 |

账号文件可用 `../deploy/make-account.mjs` 在本地生成。将散列配置从本地安全地录入 Vercel 的环境变量，把明文密码单独交给该账号的使用人。个人案卷与密钥均由服务器处理。

```powershell
npx.cmd --yes vercel deploy --prod
```

部署后用两个账号或两个浏览器做隔离验收，再用虚构案件检查上传、OCR、底稿和整案回滚。

[Vercel Hobby](https://vercel.com/docs/plans/hobby) · [私有 Blob](https://vercel.com/docs/vercel-blob/private-storage) · [函数限制](https://vercel.com/docs/functions/limitations)
