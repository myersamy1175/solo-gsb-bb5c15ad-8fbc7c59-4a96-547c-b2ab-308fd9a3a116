// 术语检查内置示例：故意写错的演示字幕 + 简体中文术语表（含别名、大小写敏感）
import { Term } from './terms'

export const SAMPLE_GLOSSARY: Term[] = [
  { standard: '人工智能', aliases: ['AI技术', 'AI 技术'], caseSensitive: false },
  { standard: 'Wi-Fi', aliases: ['wifi', 'WiFi', '无线网'], caseSensitive: false },
  { standard: 'USB', aliases: ['usb'], caseSensitive: true },
  { standard: '3D建模', aliases: ['3D模型'], caseSensitive: false },
  // 故意制造术语冲突：「3D模型」同时是「三维模型」的别名
  { standard: '三维模型', aliases: ['3D模型'], caseSensitive: false },
  { standard: '登录', aliases: ['登陆'], caseSensitive: false },
  { standard: '账户', aliases: ['帐号'], caseSensitive: false },
]

export const SAMPLE_GLOSSARY_TEXT = JSON.stringify(
  {
    说明: '简体中文术语表示例：standard=标准词，aliases=别名（命中即建议改为标准词），caseSensitive=大小写敏感（仅拉丁词生效）',
    terms: SAMPLE_GLOSSARY,
  },
  null,
  2
)

// 每一条都故意包含术语问题：用户别名 / 错误大小写 / 内置同音误写 / 术语冲突
export const SAMPLE_TERM_SRT = `1
00:00:01,000 --> 00:00:03,000
欢迎使用AI技术演示
今天聊聊术语检查

2
00:00:03,040 --> 00:00:05,000
请用 usb 接口连接设备
注意大小写规范

3
00:00:05,040 --> 00:00:07,000
这里的 wifi 信号很好
也可以写作无线网

4
00:00:07,040 --> 00:00:09,000
帐号异常请重新登陆系统
我们会尽快处理

5
00:00:09,040 --> 00:00:11,200
这一讲介绍3D模型的流程
建模完成后导出文件

6
00:00:11,240 --> 00:00:13,200
周末我们去渡假村休息
顺便欣赏苍海桑田般的晚霞

7
00:00:13,240 --> 00:00:15,400
做事不能默守成规
好高鹜远只会一事无成

8
00:00:15,440 --> 00:00:18,000
他迫不急待地冲向候车室
结果还是走头无路
`
