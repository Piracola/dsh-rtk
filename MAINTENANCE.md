# Maintenance

改 DSH 或 RTK 版本后，按下面三条复验；全都通过就不需要动代码。

## 1. 契约是否还在

```bash
# rtk rewrite：成功应输出改写后的命令（退出码实测 3，不要依赖它）
rtk rewrite "git status"      # => rtk git status
rtk rewrite "echo hi"         # => 无输出

# harness 侧：ctx.shell.resolve(request) 仍返回带 command 的 spec
# 在 dsh 里跑一条命令，看是否出现 rtk 前缀即可
```

## 2. 平台黑名单是否需要更新

```bash
# Windows：这些应当失败（失败才要留在黑名单里）
rtk ls . ; rtk pwd ; rtk wc -l x ; rtk grep -rn foo . ; rtk tree .
# 这些应当成功（可以被改写进来）
rtk find . -name "*.md" ; rtk read package.json
```

## 3. 自测

```bash
node -e "import('file:///<repo>/index.js').then(m=>{for(const c of ['git status','cat package.json','ls -la','git status | grep x'])console.log(c,'=>',m.rewriteWithRtk(c))})"
```

## 回滚

最坏情况（改写不生效）命令仍会原样执行，不会有副作用。
永久关闭：从 profile 移除本插件，或把 `denySubcommands` 设为 `['*']` 等价做法是直接卸载。
