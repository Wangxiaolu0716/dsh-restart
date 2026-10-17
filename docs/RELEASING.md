# 发版流程

本仓库没有构建步骤，发版 = 改版本号 + 写发布说明 + 打 tgz + 推送 + 打 tag。整个流程约五分钟。

## 0. 前置

| 需要的东西 | 本机现状 |
| --- | --- |
| Node ≥ 20 | 用桌面版 bundled 运行时：`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| pnpm | 同上目录下的 `dependencies\pnpm\bin\pnpm.mjs` |
| git | **不需要**。推送走 `tools/push-to-github.mjs`（GitHub REST API） |
| npm CLI | **不需要**，也不发布到 npm（包名已被占用，见 [PACKAGING.md](../PACKAGING.md)） |

## 1. 改版本号

`package.json` 的 `version`。本插件目前只有一条产品线，不区分预发布通道。

同时检查这几处是否要跟着改：

- `catalog/dsh-plugin.json` 的 `version`
- `README.md` / `README_EN.md` 顶部徽章里的「适配内核」版本
- `docs/releases/v<版本>.md`（下一步创建）

## 2. 写发布说明

新建 `docs/releases/v<版本>.md`，固定六节，缺一节不算发版完成：

```markdown
# dsh-restart <版本>

## 本次更新      ← 改了什么、为什么改。每条都要说清动机，不只是「修复了 X」
## 安装          ← 完整可复制命令，路径用占位符并说明怎么替换
## 升级与重启    ← 从上一版升上来要做什么；是否需要手动重启一次
## 回退          ← 怎么退回上一版，以及哪些文件不会被回退碰到
## 验收          ← 表格：项目 / 结果。链接到 docs/verification/ 的详细记录
## 已知边界      ← 本版没做到的部分。诚实列出，不写「暂不支持」了事
```

「已知边界」是硬要求。这个插件的每一版都必须明确写出未验证的部署形态（非 Windows、非默认
profile 名、端口配成 0 等），否则用户会以为它到处都能跑。

## 3. 跑自测

```powershell
node client.test.cjs client.js
```

25 项检查，假 DOM，不需要浏览器，不出网。改动 `client.js` 后必须全绿。

同时人工核对两件容易忘的事：

```powershell
# restart.ps1 首三字节必须是 EF BB BF（PowerShell 5.1 否则按 ANSI 代码页解码）
Format-Hex restart.ps1 | Select-Object -First 1
```

```powershell
# 宿主端语法
node --check index.js
node --check client.js
```

## 4. 打 tgz 并验证

见 [PACKAGING.md 第二节](../PACKAGING.md)。要点：在**空 profile** 里装一次，确认逐文件
sameHash，且 `dsh.bundle.patch` / `dsh.client.platform` / `exports['./client']` 三项声明完整。

## 5. 推送到 GitHub

```powershell
node <工具目录>\push-to-github.mjs --token <PAT> --repo csuwzw/dsh-restart --dir <源码目录>
```

工具会逐文件比对内容，相同的跳过、不同的带 sha 更新，所以重复执行是安全的。首次推送会自动生成
MIT LICENSE（作者行取 token 的登录名）。

token 需要 fine-grained PAT，仓库权限 **Contents: Read and write**。用完可以 Revoke——插件本身
不需要任何 token。

## 6. 打 tag

工具目前不打 tag。若已装 git，在仓库里执行：

```powershell
git tag -a v1.0.0 -m "dsh-restart 1.0.0"
git push origin v1.0.0
```

没有 git 时用 GitHub 的 Release 页面手工创建 tag（`v<版本>`，与 `package.json` 一致），正文粘贴
`docs/releases/v<版本>.md`。用户可以用 `github:csuwzw/dsh-restart#v1.0.0` 装指定版本。

## 7. 回滚一次发布

插件是纯源码分发，回滚 = 推回旧文件 + 告诉用户重装：

1. 用旧版源码目录重跑 `push-to-github.mjs`
2. 在 GitHub 上把旧 tag 重新设为 latest
3. 已安装的用户重新执行 `add github:csuwzw/dsh-restart#<旧 tag>`，然后重启 DSH

不要在旧 tag 上原地改文件——`github:owner/repo#tag` 是按 tag 解析的，改了 tag 会让已经装好的
用户拿到不同内容。

## 版本号怎么定

| 改动 | 版本 |
| --- | --- |
| 修文案、修样式、内部重构 | patch |
| 新增用户可见能力（新的按钮状态、新的安装方式） | minor |
| 改路由路径、改日志格式、改 `dsh` 声明字段 | major |

`1.0.0` 是本插件第一次对外发布，所以之前的迭代都并入了它。
