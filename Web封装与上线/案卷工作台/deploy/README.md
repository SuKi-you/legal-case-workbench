# 案卷工作台服务器部署

部署到一台有 Docker Engine 和 Docker Compose v2.17 以上版本的 Linux 主机，支持 x86-64 和 ARM64。入口可用稳定的公网 IPv4，也可用已指向该主机的域名。公网 TCP 80 用于 Let's Encrypt 签发及续期验证，TCP 443 用于用户访问。应用在容器内监听 `127.0.0.1:8787`，由 Caddy 提供 HTTPS。公网请求通过工作台账号认证，每个账号使用独立案卷目录。[Let's Encrypt 公网 IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)

已有反向代理时，把该域名接到现有 HTTPS 入口，保留请求的公开 Host，并由可信代理设置 `X-Forwarded-Proto: https`。Compose 自带的 Caddy 适合 80、443 空闲的专用服务器。[Caddy 反向代理说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 1. 生成并上传源码包

在本机的 `deploy` 目录运行：

```powershell
node pack.mjs './law-workbench-release.tar.gz'
```

脚本只打包 Web 服务和界面、底座源码和依赖锁、劳动法插件源码与本目录的部署配置。打印 SHA-256，可在服务器用 `sha256sum` 核对。上传发布包到目标服务器后，在服务目录下解压：

```bash
release=/srv/law-workbench/releases/release-01
sudo install -d -m 0755 "$release"
sudo tar -xzf law-workbench-release.tar.gz -C "$release"
cd "$release/Web封装与上线/案卷工作台/deploy"
```

## 2. 配置数据目录和账号

```bash
sudo install -d -m 0750 -o root -g 1000 /srv/law-workbench/config
sudo install -d -m 0700 -o 1000 -g 1000 /srv/law-workbench/data
sudo install -m 0640 -o root -g 1000 workbench.env.example /srv/law-workbench/config/workbench.env
sudo install -m 0600 compose.env.example /srv/law-workbench/compose.env
sudoedit /srv/law-workbench/compose.env
sudoedit /srv/law-workbench/config/workbench.env
```

将 `LAW_WEB_DOMAIN` 改成实际域名或公网 IPv4，省略协议和端口。Caddy 使用 Let's Encrypt 的短期证书并自动续期。启用接案模型时，在服务器的 `workbench.env` 填 DeepSeek 配置，文件由工作台容器只读挂载。示例文件复制仅用于首次安装。

在 Bash 中生成一个账号，输入 16 到 128 字节的密码，输入内容不会显示。示例使用服务器的 Node，也可用下方的容器命令代替：

```bash
read -rsp '工作台访问密码：' workbench_password; printf '\n'
printf '%s\n' "$workbench_password" | sudo node make-account.mjs /srv/law-workbench/config/accounts.json owner
unset workbench_password
sudo chown root:1000 /srv/law-workbench/config/accounts.json
sudo chmod 0640 /srv/law-workbench/config/accounts.json
```

若服务器只有 Docker，改用以下命令完成同一操作：

```bash
read -rsp '工作台访问密码：' workbench_password; printf '\n'
printf '%s\n' "$workbench_password" | sudo docker run --rm -i \
  -v "$PWD/make-account.mjs:/make-account.mjs:ro" \
  -v /srv/law-workbench/config:/account-config \
  node:24-bookworm-slim node /make-account.mjs /account-config/accounts.json owner
unset workbench_password
sudo chown root:1000 /srv/law-workbench/config/accounts.json
sudo chmod 0640 /srv/law-workbench/config/accounts.json
```

为不同用户分别创建账号。重复使用同一用户名会更新该账号的密码并继续使用其案卷。修改账号文件后重启 `workbench` 服务，使其读取新配置。

## 3. 上线和验证

```bash
sudo docker compose --env-file /srv/law-workbench/compose.env config --quiet
sudo docker compose --env-file /srv/law-workbench/compose.env up -d --build
sudo docker compose --env-file /srv/law-workbench/compose.env ps
```

从服务器之外访问 HTTPS 地址，未认证应收到登录要求。用两个测试账号分别新建虚构案件，再验证任一账号都看不到对方的案件或下载链接。确认 OCR、接案和底稿导出后再录入正式材料。

## 更新与恢复

每次将新版解压到新的发布目录，继续使用同一个 `compose.env` 和持久化数据目录。先构建，再短暂停服备份数据及配置并重建容器，让 Caddy 与新工作台容器共用同一个网络命名空间。

```bash
sudo docker compose --env-file /srv/law-workbench/compose.env build workbench
sudo docker compose --env-file /srv/law-workbench/compose.env down
# 此时备份 /srv/law-workbench/data 及服务器配置
sudo docker compose --env-file /srv/law-workbench/compose.env up -d
```

恢复先前程序版本时，在先前的发布目录执行同样的更新步骤。上述停止命令保留案件目录和证书卷。
