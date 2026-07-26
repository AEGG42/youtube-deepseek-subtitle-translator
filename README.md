# YouTube DeepSeek 字幕翻译

本人在使用沉浸式翻译和别的翻译插件都感到不顺心称手，都遇到过翻译质量不稳定，翻译突然离线和收费等问题。于是我使用codex辅助并制作了这款本地插件
这款插件使用你自己的 DeepSeek API Key，在 Chrome / Edge 中实时翻译 YouTube 字幕。支持整段预翻译、实时翻译、双语字幕和英文单词查询，下载压缩包既可。
插件完全本地，安全方面已使用grok4.5，fable5，gpt5.6sol进行交叉测试，可以放心使用。
具体方法如下

## 下载与安装

**最新版：** [下载 v1.8.6 ZIP](./youtube-deepseek-translator-v1.8.6.zip)

1. 下载并解压 ZIP。
2. 打开 Chrome 的 `chrome://extensions/`，或 Edge 的 `edge://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的文件夹。
5. 在自动打开的设置页中填写自己的 DeepSeek API Key。

安装或更新后，请刷新已经打开的 YouTube 页面。

## 主要功能

- 翻译 YouTube 普通字幕、自动字幕和直播字幕
- 优先预翻译完整字幕，无法预取时自动切换为实时翻译
- 支持双语字幕或仅显示译文
- 结合前后文翻译完整句子，减少断句和译文跳变
- 英文单词悬停查词，常用词优先使用内置离线词典
- 支持 11 种目标语言及字幕字号、背景和位置调节

## 使用方法

1. 打开带字幕的 YouTube 视频。
2. 扩展会自动获取字幕并开始翻译。
3. 如果没有自动显示，请打开 YouTube 播放器的 **CC** 字幕。
4. 点击浏览器工具栏中的扩展图标，可以暂停、查看进度或重译当前字幕。

## API Key 与隐私

- 项目不包含、生成或代填任何 API Key。
- API Key 保存在浏览器本地扩展存储中，只由扩展后台读取。
- 字幕和必要上下文会发送到 DeepSeek API；翻译会消耗你的 API 额度。
- 预翻译和查词缓存仅保留在当前浏览器会话中。
- 共享电脑使用完毕后，建议在设置页清除 API Key。

DeepSeek 接口说明：[API 文档](https://api-docs.deepseek.com/api/deepseek-api) · [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)

## 开发检查

项目没有第三方运行时依赖。

```powershell
npm test
npm run check
```

`npm run check` 会检查 Manifest、JavaScript、资源路径和疑似硬编码的 API Key。

## 已知限制

- 视频需要提供 YouTube 字幕轨；直播和无法预取的字幕使用实时模式。
- 字幕标点或时间轴质量较差时，翻译可能延迟或断句不准确。
- 当前只支持 DeepSeek 官方 API 地址。
- 离线词典为通用释义，复杂词义可选择使用 DeepSeek 补充。

## 许可

项目采用 [MIT License](./LICENSE)。离线词典来源于 [ECDICT](https://github.com/skywind3000/ECDICT)，许可与修改说明见 [`assets/dictionary/NOTICE.txt`](./assets/dictionary/NOTICE.txt)。
