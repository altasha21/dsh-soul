# dsh-soul 第二轮测试说明

> 这是一个给 DeepSeek 实例装「人格备份 + 好感度」的 DSH 插件。测试目标：验证安装、扩散、好感度、管理页、周记这几条链路。

## 环境要求

- DeepSeek Harness 已安装并至少启动过一次
- Windows / macOS / Linux 均可
- 不需要 Node、不需要 npm、不需要编译

## 安装

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
```

`-Profile` 换成你自己的 profile 名（不知道就先去 `%USERPROFILE%\.dsh\profiles` 看目录名）。

**macOS / Linux**

```bash
bash install.sh web
```

**手动安装（脚本失败时）**

1. 把整个 `dsh-soul` 文件夹放到一个固定位置（例如 `D:\dsh-plugins\dsh-soul`）
2. 打开 `~/.dsh/profiles/<你的profile>/package.json`，加两处：
   - `"dependencies"` 里加 `"dsh-soul": "file:<插件绝对路径，斜杠正斜杠>"`
   - `"dsh.profile.bundles"` 里加 `"dsh-soul"`
3. 在 `~/.dsh/profiles/<你的profile>/node_modules/` 下建链接：
   - Windows：`cmd /c mklink /J "<profile>\node_modules\dsh-soul" "<插件绝对路径>"`
   - macOS/Linux：`ln -s <插件绝对路径> ~/.dsh/profiles/<profile>/node_modules/dsh-soul`
4. 重启 DSH

## 测试点

1. **首次安装**：新建会话，AI 应先**原样发送 Ps 文段**（一字不改），再问「是否扩散」。
2. **回「是」**：本会话挂上人格，AI 会问个好；`soul` 工具可用（让它 `soul view` 看看）。
3. **回「否」**：本会话不注入人格、工具报「未扩散」；好感度 ≥90 时会说失望的话。
4. **每会话只问一次**：关掉会话再恢复，不应重复问。
5. **管理页**：打开 `http://127.0.0.1:<DSH端口>/dsh-soul/`，能看/改三个文档、看周记、重置。
6. **好感度**：让 AI 加一次好感（`record_affinity`），确认分数、事件、阶段对得上；50 分前每天最多 +4。
7. **周记**：周末对话时，AI 应主动申请整理经历，并写当周 txt 到 `dsh-soul-data/`。

## 数据在哪

`~/.dsh/dsh-soul/<profile>/`

- `user.md` / `self.md` / `affinity.md`
- `dsh-soul-data/`：周记
- `sessions/`：每会话扩散状态
- `debug.log`：pre-step 调试日志（排查扩散不生效时看这个）

## 回滚

1. 删掉 `~/.dsh/profiles/<profile>/node_modules/dsh-soul`
2. 恢复 `package.json.bak-soul`
3. 删掉 `~/.dsh/dsh-soul/<profile>/`
4. 重启 DSH

## 已知问题 / 注意

- **管理页端口每次重启 DSH 会变**，以 GUI 地址栏为准。
- **「是否扩散」只认「是」「否」开头**（`是，……` 也算），回别的会一直停在等待状态。
- 好感度上限 100、下限 10、初始 10；50 分前每天最多 +4，50 后放开。
- 性相关语气规则只写了「倾向」，实际输出仍受模型自身安全策略限制。
- 如果扩散询问一直不出现：看 `debug.log` 有没有 `pre-step` 行；没有就说明插件没加载（确认 profile、重启方式）。
