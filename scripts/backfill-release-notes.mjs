// 给已发布的版本补上「本次更新内容」。
//
//   node scripts/backfill-release-notes.mjs --dry-run
//   node scripts/backfill-release-notes.mjs
//
// 为什么需要：发布说明机制是后加的，此前 v1.0.1–v1.0.8 的正文只有一段固定的附件
// 说明，用户看不到每个版本改了什么。内容按各版本之间的实际提交整理。
//
// 只改正文，不动标签、附件与发布时间。
import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')
const REPO = 'pucj0/deepseek-harness-desktop'

/** 固定尾注：附件清单与注意事项（与 CI 生成的正文一致）。 */
const FOOTER = `---

### 安装包

| 平台 | 文件 |
|---|---|
| Windows | \`dsh-desktop-x64.exe\`（NSIS 安装程序，**中文界面**）、\`.msi\` |
| Linux | \`dsh-desktop-x86_64.AppImage\`、\`-amd64.deb\` |
| macOS | \`dsh-desktop-x64.dmg\`、\`-arm64.dmg\` 及对应 \`.zip\`

文件名里不带版本号，版本体现在 Release 标签上。

**Windows 安装界面为简体中文**；\`.msi\` 仍是英文（electron-builder 的 MsiTarget 不提供语言选项，其 WiX 工具链不含本地化文件）。

macOS 产物未签名（未配置 Apple 开发者证书），首次打开请右键 → 打开。
`

/** 各版本的更新说明，按版本之间的实际提交整理。 */
const NOTES = {
  'v1.0.1': `## 新增

- **输入框工具栏的分支徽章**（在「选择工作区 / 标准模式」那一排、发送按钮左侧）。它以 dsh 插件的形式注册到 \`conversation.input.right\`，随应用内置、开箱可用。
- 分支徽章显示当前分支、未提交改动数与相对上游的领先/落后；点击可切换分支。

## 修复

- 应用外壳自更新此前必然失败：\`latest.yml\` 里的文件名与 GitHub 附件名不一致（空格分别被转成连字符与点），下载会 404。改用不含空格的 \`productName\`，两处逐字相同。
- 「更新」界面重做：两条更新轨道（智能体运行时 / 应用外壳）统一展示，窗口先打开再并行检查，有更新时给出操作按钮。
- 打包脚本每次自动递增版本号，并拒绝跳过补丁号的发布。

## 注意

- 因 \`productName\` 变更，安装目录由 \`…\\Programs\\DeepSeek Harness\\\` 改为 \`…\\Programs\\dsh-desktop\\\`。升级前请先卸载旧版本。`,

  'v1.0.2': `## 修复

- **分支列表此前只列本地分支**。团队协作时大部分分支只存在于远程，界面上看不到等于没有。现在本地在前、远程在后，远程条目带 \`R\` 标记；切换远程分支时 git 会自动创建同名跟踪分支。
- 修掉一个判断漏洞：远程的符号引用 \`origin\`（不带斜杠）曾被误判为本地分支，混进列表。改为按两个独立的 refname 空间查询并排除 \`*/HEAD\`。`,

  'v1.0.3': `## 修复

- **「文件 → 打开文件夹」选完之后应用重启了，但打开的还是老目录**。原因是 \`app.relaunch()\` 会沿用原来的命令行，重启后的命令行参数把刚选的新工作区盖掉了。现在切换意图写进一个一次性标记文件，启动时优先读取，只对紧接着的那一次生效。`,

  'v1.0.4': `## 新增

- 切换分支失败时新增「**暂存改动并切换到 X**」按钮。此前遇到未提交改动只能自己去终端 \`git stash\`。
- 暂存成功后界面会告知 stash 位置（\`git stash pop\` 可恢复），不会让人以为改动丢了。

## 修复

- **点分支没反应**。真实原因是工作区有未提交改动、git 拒绝覆盖，但错误只写在按钮的悬停提示里，而菜单照常关闭——用户看到的就是完全没反馈。现在保持菜单打开并显示 git 的原始报错。`,

  'v1.0.5': `## 修复

- **点击菜单外部或按 Esc 关闭分支菜单**。此前只能再点一次徽章才关，点页面其他地方菜单不消失。`,

  'v1.0.6': `## 变更

- Release 附件不再包含 \`.blockmap\` 文件。它是差分下载用的索引，对下载安装包的用户没有意义；去掉不影响自动更新，更新时会退回全量下载安装包。
- 历史版本里的同类文件也已一并清理。`,

  'v1.0.7': `## 变更

- **分支徽章的提示文案跟随语言设置**（中/英）。此前插件文案是硬编码中文，而 git 报错是英文，两种语言混在一起。
- 错误提示分两层：本地化短句说明原因与下一步，下方保留 git 的英文原文——它是权威信息，翻译反而失真。`,

  'v1.0.8': `## 修复

- **切换项目后分支徽章不变**。此前徽章固定查外壳启动时的工作区，而应用内可以为会话选择另一个项目，于是徽章一直显示上一个仓库的分支。现在跟随会话的工作区，换项目立即跟着变。
- 只有本应用登记过的工作区才会被查询（安全边界：否则任何能访问本机回环地址的页面都能让宿主进程对任意目录执行 git 命令）。
- 修正一处参数校验漏洞：查询参数缺失时抛错返回 500，现在返回 400 并说明原因。`,
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((line) => line.startsWith('password='))
  .slice('password='.length)
  .trim()

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-desktop-backfill',
}

const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers })).json()

let updated = 0
for (const release of releases) {
  const notes = NOTES[release.tag_name]
  if (notes === undefined) {
    console.log(`${release.tag_name}: 无对应说明，跳过`)
    continue
  }
  const body = `${notes}\n\n${FOOTER}`
  if (dryRun) {
    console.log(`${release.tag_name}: 将更新正文（${body.length} 字符）`)
    continue
  }
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  const ok = response.status === 200
  if (ok) updated += 1
  console.log(`${release.tag_name}: ${ok ? '已更新' : `失败(${response.status})`}`)
}

console.log('')
console.log(dryRun ? '[dry-run] 未做改动' : `共更新 ${updated} 个 Release`)
