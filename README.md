# Laya 虚拟环境工坊（`laya-bridge` · TPI 2.0 全功能档）

按天枢官方 TPI 2.0 规范（`docs/developers/tpi2.md` & `manifest-v2.schema.json`）构建的隔离插件包：

- **极轻插件包（< 40 KiB）**：只打包桥接逻辑与天枢原生界面，不打包 `laya-env`、PyTorch 或模型权重。
- **车间层留在本地 `laya-env`**：通过宿主代跑的 `host.shell.run` 调起 `dsh-guard/optimizer/laya_artifact_worker.py`（Base64 安全传参），在本机完成 Laya 三问决策、项目结构简报、HTML 静态质检与虚拟环境 Python 脚本执行，把成品原子写入工作区 `.laya/artifacts/<job_id>/`。
- **主模型零噪声取货**：主模型既可直接拿工具返回的精简摘要，也可通过 `laya_fetch_artifact` 按 `job_id` 与文件名按需提取成品。
- **严格隔离合规**：生命周期阶段（`turnStart`/`toolEnd`/`sessionEnd`）与 UI 消息通道绝不调用 `shell.run`；所有 HTML/JS 视图严格通过无内联脚本、无外网请求、无 `localStorage` 的 CSP 审计。

## 打包与自检

```powershell
node dsh-guard/tianshu-plugin-v2/pack-xiaosi-v2.mjs --publisher-id <你的发布者ID>
```

生成的发行包位于 `dsh-guard/tianshu-plugin-v2/dist/laya-bridge-2.0.0.zip`，面向小思插件库「官方审核分区（`official_reviewed`）」提交。

## 注意事项

- 按官方 TPI 2.0 规则，本地 `.rivet/plugins/` 目录不会加载 TPI 2.0 插件，须经插件库签名分发；在正式上架前可继续与本地 TPI 1.0 `laya-guard` 及 `LayaStudio.exe` 并存使用。
- 含 `shell.run` 权限的插件每次工具调用均由天枢宿主弹出确认框，建议按「单次完整任务」粒度调用 `laya_venv_decide`（支持一次批量 32 条命令）和 `laya_venv_produce`。
