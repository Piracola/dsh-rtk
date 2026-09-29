# dsh-rtk

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**薄** RTK 集成：执行前把简单命令改写成 `rtk <cmd>`，其余语义（工作目录、超时、环境变量、沙箱约束、结果格式）全部继承原执行器。

## 为什么自己写

现成的 dsh RTK 插件都 `extends` 了 harness 内部执行器类（`PwshLocalExecutor` / `SandboxPwshExecutor`），或把 peer 依赖钉在某个 rc 版本上，DSH 迭代时容易失效。本插件**不 import 任何 DSH 内部模块**，只注入 `shell` 服务并包装它的 `resolve()`，换执行器、换平台都不用改代码；最坏情况是改写静默不生效，命令照常执行。

## 依赖的三个外部契约

1. `ctx.shell` 暴露 `resolve(request) -> spec`，且 `spec.command` 是字符串。
2. `rtk rewrite <cmd>`：**改写成功返回非 0（实测 3，文档写的是 0）并输出改写后的命令；无可改写则 stdout 为空**。插件只认「stdout 非空且与原命令不同」，不依赖退出码。
3. 平台黑名单：Windows 上 `rtk ls/tree/pwd/wc/grep` 会去代理不存在的 Unix 同名程序而失败，所以默认不把命令改写进这些子命令。判定作用于**改写后**的子命令——rtk ≥ 0.50 会把 `cat x` 改写成原生的 `rtk read x`，这条依然允许。Linux/macOS 把 `denySubcommands` 设成 `[]` 即可放开。

## 安装

```bash
dsh plugin --profile <profile> add file:<本仓库绝对路径>
# 例：dsh plugin --profile web add file:I:/JBCode/Test/dsh-rtk
```

装完重启 dsh（插件在启动时加载）。

## 配置

```yaml
- insert:
    - id: rtk-thin
      name: dsh-rtk-thin
      config:
        rtkExe: C:\Users\you\.cargo\bin\rtk.exe    # 默认：RTK_EXE 环境变量 → PATH
        denySubcommands: [ls, tree, pwd, wc, grep]   # 默认值，仅 win32 生效
```

## 实测行为（rtk 0.49.0 / 0.50.0，Windows）

| 输入 | 结果 |
|---|---|
| `git status` / `cargo test` / `npm run build` | `rtk git status` / `rtk cargo test` / `rtk npm run build` |
| `cat package.json` | `rtk read package.json` |
| `find . -name *.md` | `rtk find . -name *.md` |
| `ls -la` / `pwd` / `wc -l x` / `grep -rn foo .` / `tree .` | 原样不动（这些 rtk 子命令在 Windows 上会失败） |
| `git status \| grep x` / `a && b` | 原样不动（含 shell 元字符，避免改变管道语义） |
| `echo hello` | 原样不动（rtk 无等价形式） |

自测（不需要 dsh 在跑）：

```bash
node -e "import('file:///<仓库路径>/index.js').then(m=>console.log(m.rewriteWithRtk('git status')))"
```

## License

MIT
