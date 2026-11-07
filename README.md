# Architecture

极简的架构图绘制工具。纯 HTML/CSS/JS 前端 + Python 标准库后端，零第三方依赖。

## 运行

```bash
python server.py        # 默认 8000，可传端口：python server.py 8123
```

打开 http://localhost:8000

## 用法

- 双击画布空白处：新建方框
- 拖动方框：移动位置
- 双击方框：改文字（Enter 确认，Esc 取消）
- 悬停方框右侧的圆点拖到另一个方框：连线
- 点击连线再按 Delete：删除连线
- 选中方框按 Delete：删除方框（连同它的连线）
- 顶部填名字 → 保存（或 Ctrl+S）；下拉框切换存档；删除按钮删当前存档
- 右上角按钮切换明暗（记在 localStorage）

## 存档

存在 `data/<名字>.json`，一个图一个文件，已在 `.gitignore` 里排除。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/diagrams` | 列出所有存档名 |
| GET | `/api/diagrams/<name>` | 读取存档 |
| PUT | `/api/diagrams/<name>` | 写入/覆盖 |
| DELETE | `/api/diagrams/<name>` | 删除 |

存档名只允许中英文、数字、下划线和短横线，长度 1–50。
