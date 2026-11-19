# 本机持久安装适配

- 安装身份固定为 @local/dsh-prompt-enhance，loader id 固定为 prompt-enhance。
- 源码属于用户 DSH_HOME，不放 C:/APPS/DSH；desktop 与 web 共享此目录。
- 公开基线：sun04222/dsh-prompt-enhance@1707eba40ed8b84e16bc91c54f901056cc27fbb4。
- 本地差异：保留旧包名/客户端 id/bundle name，移除空 config，新增宿主测试。
- 不直接 git pull 覆盖本机差异；先审计上游，再重新运行 node --test。
- 原始 C:/APPS/DSH 源码无法逐字恢复；此处是可审计替代实现。
- 常规 DSH 应用目录升级不会再删除此源码；未来 DSH 不兼容接口仍需按实际错误适配，不能作无限版本保证。
