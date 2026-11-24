# Laya 虚拟环境工坊（`laya-bridge` v2.0.1 · TPI 2.0 隔离插件）

在天枢 TPI 2.0 隔离沙箱中桥接用户本机 Python 虚拟环境（`laya-env`），让重计算与模型推理留在本机虚拟环境完成，主模型按需从 `.laya/artifacts/` 提取结构化成品。

## 首次使用配置

安装并启用插件后，首次调用工具前请打开天枢 **设置 → 插件界面 → Laya 虚拟环境**，填写并保存本机路径：

1. **Python 虚拟环境解释器路径（`pythonPath`）**：例如 `D:/laya-env/Scripts/python.exe`（仅允许字母、数字、`. _ / -` 及盘符前缀，不允许空白或 `%`/`^`/`~` 等特殊字符）。
2. **成品工坊脚本路径（`workerScript`）**：例如 `D:/laya-work/dsh-guard/optimizer/laya_artifact_worker.py`。
3. **热态守护进程地址（`daemonUrl`）**：默认 `http://127.0.0.1:8767`（仅限本机回环地址 `127.0.0.1` / `localhost`，端口 `1024..65535`）。

## 提供的工具

- `laya_venv_probe`：探测本机 `laya-env`、PyTorch、权重目录与 8767 热态服务状态。
- `laya_venv_decide`：对单条或批量（最多 32 条）Shell 命令执行 Laya 三问决策（`fast_path` / `parallel_safe` / `route`）。
- `laya_venv_produce`：在本地虚拟环境运行 `workspace_digest`（项目简报，自动跳过 `.env` 等敏感文件）、`html_audit`（HTML 静态质检）或 `py_script`（工作区 Python 脚本），成品落盘至 `.laya/artifacts/<job_id>/`。
- `laya_fetch_artifact`：只读读取成品索引或指定成品正文（超 512 KiB 自动按 UTF-8 字节边界安全截断）。

## 权限与安全说明

- 插件隔离进程不申请网络权限、不启子进程、不保存任何 API 密钥。
- `shell.run` 仅在用户逐次确认工具调用期间执行；生命周期钩子（`turnStart`/`toolEnd`/`sessionEnd`）与 UI 面板仅执行只读索引读取与纯内存轨迹监控。
- 重置配置需在设置页二次点击确认，清空路径后不会覆写为特定盘符路径。
