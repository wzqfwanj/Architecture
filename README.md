# Architecture

极简的架构图绘制工具。纯 HTML/CSS/JS 前端 + Python 标准库后端，零第三方依赖。

在线版：https://wkeeli.cn/arch/ （需登录）

## 运行

```bash
ARCH_PASSWORD=你的密码 python server.py        # 默认 8000
python server.py 8123                          # 指定端口；不设密码时不校验（仅本机调试）
```

打开 http://localhost:8000 ，浏览器会弹登录框。

## 用法

- 双击画布空白处：新建方框
- 拖动方框：移动位置
- 双击方框：改文字（Enter 确认，Esc 取消）
- 从方框右侧圆点拖到另一个方框：连线
- 点中连线或方框后按 Delete：删除（删方框会连带删掉它的连线）
- 顶部填名字 → 保存（或 Ctrl+S）；下拉框切换存档；删除按钮删当前存档
- 右上角切换明暗，黑白配色，选择记在 localStorage

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `ARCH_USER` | `admin` | 登录用户名 |
| `ARCH_PASSWORD` | 空 | 登录密码；留空则不校验，只适合本机调试 |
| `ARCH_DATA` | `./data` | 存档目录 |

存档是 `data/<名字>.json`，一图一文件，已在 `.gitignore` 里排除。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `api/diagrams` | 列出所有存档名 |
| GET | `api/diagrams/<name>` | 读取存档 |
| PUT | `api/diagrams/<name>` | 写入/覆盖 |
| DELETE | `api/diagrams/<name>` | 删除 |

所有接口都要 HTTP Basic 认证。存档名只允许中英文、数字、下划线和短横线，长度 1–50。

## 部署（本项目的实际做法）

- 代码在 dev 主机 `/opt/architecture`，由 `architecture.service` 跑在 8060 端口
- 存档目录 `/var/lib/architecture`，运行用户 `architecture`
- 密码在 `/etc/architecture.env`（权限 600，不进仓库）
- aliyun 跳板机上的 Caddy 把 `wkeeli.cn/arch/*` 反代到 `180.76.180.249:8060`

## 许可

MIT
