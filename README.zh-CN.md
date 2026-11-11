# Session Sync for Claude Code

[English](README.md) · [Українська](README.uk.md) · [Español](README.es.md) · **简体中文**

> 非官方社区扩展，与 Anthropic 无关联，也未获其认可。“Claude”和“Claude Code”是 Anthropic 的商标。

在另一台设备上继续 Claude Code 会话。本扩展在你的电脑之间迁移会话历史，无需自建服务器：数据通过你已在使用的服务传输。

## 使用方法

命令位于命令面板：**Cmd+Shift+P**（Windows 和 Linux：Ctrl+Shift+P），然后输入“Claude Sync”。

### 在你工作的设备上

1. 在 VS Code 中打开项目。
2. 运行 **Claude Sync: Push sessions**。
3. 首次使用时选择会话的传输方式（见下文），其余由扩展完成。

### 在你要继续的设备上

1. 安装扩展并打开**同一个项目**（相同的 git remote）。
2. 运行 **Claude Sync: Pull sessions**，并选择相同的方式。
3. 会出现存储中的会话列表：标题、日期、大小和状态。勾选需要的会话，或点击“Select all”。
4. 运行 **Claude Sync: Resume a session**，选择一个会话，终端会打开并执行 `claude --resume`。

### 使用建议

- **离开设备前先 Push，在另一台设备开始前先 Pull。**
- 不要在两台设备上同时继续同一个会话：扩展会提示冲突，并且不会覆盖任何内容。
- 云服务不会立即送达文件：如果 Pull 没有找到内容，请等一分钟再试。
- 随时可更改方式：**Claude Sync: Choose sync method**。断开云存储：**Claude Sync: Disconnect storage**（不会删除存储或本机中的任何内容）。

## 同步方式

| 方式                | 你需要                                                                                      | 会发生什么                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **GitHub**          | 一个 GitHub 账号                                                                            | 通过 VS Code 一键登录，自动创建私有仓库 `claude-sessions`。同名公开仓库会被拒绝。   |
| **云存储**          | iCloud Drive、Dropbox、OneDrive、Google Drive、MEGA、pCloud、Box、Proton Drive 或 Nextcloud | 从列表中选择云服务，在其根目录创建“Claude Sessions”文件夹，文件由云客户端负责送达。 |
| **自己的 git 仓库** | 你可以访问的私有仓库（SSH 或 credential helper）                                            | 在 `claudeSessionSync.repoUrl` 中填写其地址。                                       |

## 设置

所有设置按机器生效：请在用户设置（User settings）中配置。

| 设置                                  | 默认值 | 作用                                                          |
| ------------------------------------- | ------ | ------------------------------------------------------------- |
| `claudeSessionSync.mode`              | 空     | `github`、`folder`（云存储）或 `git`。为空 = 首次使用时询问。 |
| `claudeSessionSync.repoUrl`           | 空     | “自己的 git”方式所用私有仓库的地址。                          |
| `claudeSessionSync.maxFileSizeMB`     | `90`   | 大于此值的会话不会被推送（并会给出提示）。                    |
| `claudeSessionSync.maxSessionAgeDays` | `30`   | 仅推送最近 N 天内修改过的会话。`0` = 不限制。                 |

## 安全

- 会话包含你的代码、命令输出，**可能还有机密信息**。请只发送到私有存储：私有仓库或你自己的云盘。首次 Push 前扩展会提醒你。
- GitHub 方式会请求 `repo` 权限（GitHub 没有更窄的私有仓库权限）。令牌保留在 VS Code 内，扩展代码是开源的。
- 如果在 iCloud 中开启了“优化 Mac 储存空间”，部分会话可能尚未下载到本机。扩展会告诉你数量以及该怎么做。

## 限制

- 同步的是当前项目（第一个打开的文件夹）的会话，而不是一次同步所有项目。
- 同步为手动，没有后台模式。

源代码与问题反馈：https://github.com/htar/claude-session-sync
