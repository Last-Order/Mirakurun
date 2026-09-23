# Windows 日志轮转与迁移

## 默认行为

通过 Windows 服务或 `npm run start.win32` / `npm run debug.win32` 启动时自动启用。
日志写到安装服务时用户的 `%LOCALAPPDATA%\Mirakurun\logs`：

```text
stdout.2026-09-24.log
stderr.2026-09-24.log
```

普通输出和警告/错误分开保存。按运行机器的本地日期切分，同日重启追加。
保留今天和之前 6 个自然日：9 月 24 日保留 9 月 18～24 日。
启动时和每分钟清理过期文件，即使没有新日志也清理；跨午夜后的清理延迟最多约一分钟
（事件循环繁忙时可能更长）。新日志按写入时日期直接选择文件，无须重启。
停机期间不会执行清理，下次启动补做。只清理本目录内匹配
`stdout.YYYY-MM-DD.log` / `stderr.YYYY-MM-DD.log` 的普通文件，不递归删除目录。

服务模式不把正常日志重复输出到 winser。原来的 `stdout` / `stderr` 保留作为应急输出：
日志文件不可写时，原始日志回退到那里，并最多每分钟输出一次日志模块故障说明。
因此发生持续磁盘故障时，应急文件仍可能增长，需要修复权限或磁盘问题。
初始化失败（例如目录不可创建、保留天数非法）会阻止启动，原因写入原 `stderr`。
Node 启动失败、原生代码直接写系统句柄的输出也仍由服务原有重定向处理。

手动启动时同时显示终端输出。直接运行 `npm start` / `node lib/server.js` 不经过 Windows
入口，不启用此功能。Linux、Docker 和 PM2 的行为不变。

写入使用同步追加，避免现有 `process.exit()` 路径丢失 JavaScript 写入缓冲；
高日志量或慢磁盘会增加主线程延迟，建议使用本地磁盘，避免长期启用 DEBUG。
不提供压缩或大小上限；7 天是时间限制，不是磁盘容量限制。
强制终止、断电以及写入故障仍可能丢失日志。一个日志目录供一个实例使用。

## 可选配置

可在实际安装目录的 `.env` 中设置以下变量，修改后重启服务；已有环境变量优先于 `.env`：

```dotenv
MIRAKURUN_LOG_DIR=C:\MirakurunLogs
MIRAKURUN_LOG_RETENTION_DAYS=7
```

不设置时使用默认路径和 7 天。保留天数必须为正整数，`1` 表示只保留今天。
目录建议使用绝对路径，服务运行账户必须具有创建、追加和删除文件的权限。
这些参数不是 `server.yml` 配置；`logLevel`、内存日志的 `maxLogHistory` 保持原含义。
不要让外部轮转工具同时操作新日志目录。

## 已有服务迁移（无需重装服务）

迁移会短暂停止 Mirakurun，安排在没有录制任务时进行。
本次日志功能仅依赖两个 JavaScript 文件，不需要编译，也不需要安装新的 npm 依赖。
迁移脚本只更新这两个文件，不升级其余业务代码。

1. 将包含本次修改的代码放在独立目录，例如 `D:\Git\Mirakurun`。
   不要先覆盖现有安装目录，以便保留旧文件用于回滚。
2. 打开**管理员 PowerShell**，查看服务实际安装位置和服务环境：

   ```powershell
   $serviceName = 'mirakurun'
   $parameters = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName\Parameters"
   $parameters | Select-Object Application, AppDirectory, AppParameters, AppStdout, AppStderr, AppEnvironmentExtra
   Get-Service -Name $serviceName
   ```

   确认这是目标 Mirakurun 服务，启动入口为 `bin\init.win32.js`。
   日志路径按服务保存的 `LOCALAPPDATA` 计算，未必是当前管理员账户的目录。
3. 执行迁移脚本（如服务名不同，替换参数）：

   ```powershell
   & 'D:\Git\Mirakurun\bin\migrate-windows-logs.ps1' -ServiceName 'mirakurun'
   ```

   脚本读取服务的 `AppDirectory`，在安装目录创建 `log-migration-backup-时间戳`，
   备份旧文件，停止服务，复制 `init.win32.js`、`daily-logs.js`，再恢复原来的运行状态。
   保存输出中的安装目录和备份目录。脚本不改注册表、服务账户、配置、数据库或旧日志。
   原来停止的服务会保持停止，需要手动 `Start-Service mirakurun`。
   若执行策略阻止脚本，按本机管理策略批准脚本，或手动完成上述备份、停止、复制、启动步骤。
4. 验证服务和日志（把示例目录替换为第 2 步确认的服务用户目录或自定义目录）：

   ```powershell
   Get-Service mirakurun
   $logDirectory = 'C:\Users\Sora\AppData\Local\Mirakurun\logs'
   Get-ChildItem -LiteralPath $logDirectory
   $today = Get-Date -Format 'yyyy-MM-dd'
   Get-Content -LiteralPath (Join-Path $logDirectory "stdout.$today.log") -Tail 50
   Invoke-RestMethod 'http://localhost:40772/api/status'
   ```

   自定义端口时修改 URL。服务显示 Running 不代表应用已成功就绪，必须同时确认 HTTP 响应
   和日志。`stderr` 当天没有输出时可能不存在，属于正常现象。还应检查原 `stderr`
   是否出现启动/写入故障；正常运行时旧 `stdout`、`stderr` 不应随普通业务日志增长。
5. 次日确认新的日期文件；第 8 天确认最早一天已清理。旧无日期日志不自动删除，
   验证迁移成功后按需要手动归档。不要修改系统时间来测试轮转。

迁移失败时脚本会报告备份目录，可能留下已停止的服务或部分更新的文件；按下节恢复，
不要把脚本成功退出或服务 Running 当作健康检查的替代。

## 回滚

在管理员 PowerShell 中，使用迁移输出中的真实路径：

```powershell
Stop-Service mirakurun
$installedBin = 'C:\实际安装目录\bin'
$backupDirectory = 'C:\实际安装目录\log-migration-backup-实际时间戳'
Copy-Item -LiteralPath (Join-Path $backupDirectory 'init.win32.js') -Destination (Join-Path $installedBin 'init.win32.js') -Force
if (Test-Path -LiteralPath (Join-Path $backupDirectory 'daily-logs.js')) {
    Copy-Item -LiteralPath (Join-Path $backupDirectory 'daily-logs.js') -Destination (Join-Path $installedBin 'daily-logs.js') -Force
}
Start-Service mirakurun
```

首次迁移的备份中没有 `daily-logs.js` 时，新增文件可以保留，旧入口不会加载它。
旧入口恢复后，日志重新写入原 `stdout` / `stderr`。日期日志保留，便于排查。
按迁移验证步骤重新确认 HTTP 可用。如果迁移前服务本来停止，可不执行最后的启动命令。

## 新部署

沿用项目原有 Windows 安装流程，部署时确保 `bin/daily-logs.js` 和
`bin/init.win32.js` 一起安装。服务仍使用原有 winser 设置，启动后自动创建日期日志。
无需额外计划任务或日志轮转服务。若手动运行源码，先完成原有依赖安装和构建，
再执行 `npm run start.win32`；此时也会保存日期日志。
