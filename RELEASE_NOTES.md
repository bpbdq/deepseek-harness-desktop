# 1.2.10

本次不再随 Release 发布 Windows 的 `.msi`。

## 变更

- **Release 不再附带 `.msi`。** 它此前一直随每个版本发布，但价值与代价不成比例：

  * **安装界面只有英文**——electron-builder 的 MsiTarget 不提供语言选项，其 WiX 工具链只含 `WixUIExtension.dll`、不含本地化 `.wxl` 文件；中文 MSI 需要自建 WiX UI 扩展。
  * **构建需要很短的路径根**——这份应用的运行时树很深（`@opentelemetry` 等），WiX 的 `light.exe` 受 `MAX_PATH`(260) 限制，CI 的构建路径正好越线，必须绕 junction 才能生成，而越线时的报错是 `LGHT0103`「找不到文件」，完全看不出是路径长度问题。

  Windows 只保留 `dsh-desktop-x64.exe`（NSIS 安装程序，中文界面）。

- MSI 目标**仍然保留**在 `electron-builder.yml` 里，需要时可在本地生成：

  ```
  npx electron-builder --win msi --x64
  ```

## 说明

- 此前各版本的 Release 里已经上传的 `.msi` 附件**已一并清理**（共 27 个，覆盖 v1.0.1 起的全部历史版本），只删附件，不动标签与其它产物。
- 中英文 README 的下载表、安装界面语言、可构建性、打包命令与已知限制各节都已同步更新。

## 校验

- 工作流 YAML 校验通过：Windows 作业名改为「Windows (setup.exe)」，已无 MSI 构建步骤，产物收集与存在性检查也不再匹配 `*.msi`。
- 各 Release 现在均为 **10 个附件**且不含 `.msi`。
