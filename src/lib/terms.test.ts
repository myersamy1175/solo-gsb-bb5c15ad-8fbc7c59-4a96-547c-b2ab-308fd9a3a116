// 术语检查模块测试（非生产代码）：
//  - 术语表解析（JSON / 文本两种格式、校验与警告）
//  - 全片扫描（别名与同音误写、大小写敏感、拉丁词边界、码点偏移）
//  - 冲突判定（一别名多标准词 / 别名即他人标准词 / 跨条目重叠）
//  - 替换预览 JSON（仅预览、冲突保留原文、偏移正确）
import { parseSrt } from './srt'
import { SAMPLE_GLOSSARY, SAMPLE_TERMS_SRT } from './sample'
import {
  GlossaryEntry,
  buildPreviewJson,
  flattenCueText,
  parseGlossary,
  scanTerms,
} from './terms'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) pass++
  else {
    fail++
    console.error('  ✗ ' + msg)
  }
}

function cuesOf(srt: string) {
  return parseSrt(srt).cues
}

function entry(id: number, term: string, aliases: string[], caseSensitive = false): GlossaryEntry {
  return { id, term, aliases, caseSensitive }
}

// ===========================================================================
console.log('== 术语表解析：JSON 格式 ==')
{
  const r = parseGlossary(`[
    { "term": "账号", "aliases": ["帐号"] },
    { "term": "SRT", "aliases": ["srt"], "caseSensitive": true },
    { "term": "阈值", "aliases": "阀值|閾值" }
  ]`)
  assert(r.warnings.length === 0, `合法 JSON 无警告（实际 ${r.warnings.join('；')}）`)
  assert(r.entries.length === 3, '解析出 3 个条目')
  assert(r.entries[0].id === 1 && r.entries[1].id === 2 && r.entries[2].id === 3, '条目序号从 1 递增')
  assert(r.entries[0].caseSensitive === false, 'caseSensitive 缺省为 false')
  assert(r.entries[1].caseSensitive === true, 'caseSensitive 显式 true 生效')
  assert(r.entries[2].aliases.join(',') === '阀值,閾值', 'aliases 字符串按分隔符拆分')
}
{
  const r = parseGlossary(`{ "entries": [ { "term": "字幕", "alias": "字慕" } ] }`)
  assert(r.entries.length === 1 && r.entries[0].aliases[0] === '字慕', '支持 entries 包装与 alias 单数键')
}
{
  const r = parseGlossary(`[
    { "term": "", "aliases": ["x"] },
    { "term": "部署", "aliases": [] },
    { "term": "视频", "aliases": ["视频"] },
    { "term": "节奏", "aliases": ["节凑", "节凑", " 节凑 "] },
    "not-an-object"
  ]`)
  assert(r.entries.length === 1, '非法条目均被跳过，仅留 1 个有效条目')
  assert(r.entries[0].term === '节奏' && r.entries[0].aliases.length === 1, '别名去重（含空白归一）')
  assert(r.warnings.length >= 4, `每个非法条目都有警告（实际 ${r.warnings.length} 条）`)
}
{
  const r = parseGlossary(`[{ "term": "a", "aliases": ["b"], }]`)
  assert(r.entries.length === 0 && r.warnings.some((w) => w.includes('JSON 解析失败')), '坏 JSON 给出解析失败警告')
}
{
  const r = parseGlossary('   ')
  assert(r.entries.length === 0 && r.warnings.some((w) => w.includes('为空')), '空内容给出警告')
}

// ===========================================================================
console.log('== 术语表解析：文本格式 ==')
{
  const r = parseGlossary(
    [
      '# 注释行被跳过',
      '标准词,别名,大小写敏感',
      '',
      '账号,帐号',
      '阈值\t阀值\t是',
      'SRT,srt,true',
      '视频,视屏|视贫',
      '登录,登陆、登入;登録',
    ].join('\n')
  )
  assert(r.entries.length === 5, `文本格式解析出 5 个条目（实际 ${r.entries.length}）`)
  assert(r.entries[0].term === '账号' && r.entries[0].aliases[0] === '帐号', '逗号分列')
  assert(r.entries[1].term === '阈值' && r.entries[1].caseSensitive === true, '制表符分列 + 「是」标志')
  assert(r.entries[2].caseSensitive === true, 'true 标志')
  assert(r.entries[3].aliases.join(',') === '视屏,视贫', '别名 | 分隔')
  assert(r.entries[4].aliases.join(',') === '登陆,登入,登録', '别名 、; 分隔')
  assert(r.warnings.length === 0, `合法文本无警告（实际 ${r.warnings.join('；')}）`)
}
{
  // 末列无法识别为标志 → 并入别名（逗号格式下逗号分隔的多个别名也可用）
  const r = parseGlossary('视频,视屏,视贫')
  assert(r.entries.length === 1 && r.entries[0].aliases.join(',') === '视屏,视贫', '未识别尾列并入别名')
  assert(r.entries[0].caseSensitive === false, '缺省不敏感')
}
{
  const r = parseGlossary(['没有别名的词,', '部署,布署,maybe'].join('\n'))
  // 第一行：无别名 → 跳过；第二行：maybe 不是标志 → 并入别名
  assert(r.entries.length === 1 && r.entries[0].aliases.join(',') === '布署,maybe', '尾列非标志时按别名处理')
  assert(r.warnings.some((w) => w.includes('没有可用别名')), '无别名条目有警告')
}

// ===========================================================================
console.log('== 扫描：基本命中与大小写 ==')
{
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
这个帐号的阀值不对

2
00:00:02,000 --> 00:00:03,000
帐号又出现
`)
  const g = [entry(1, '账号', ['帐号']), entry(2, '阈值', ['阀值'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 3, `共 3 次命中（实际 ${hits.length}）`)
  assert(hits[0].cueIndex === 0 && hits[0].found === '帐号' && hits[0].term === '账号', '命中记录原词与建议词')
  assert(hits[0].start === 2 && hits[0].end === 4, '码点偏移正确')
  assert(hits[2].cueIndex === 1, '命中按字幕顺序排列')
  assert(hits.every((h) => !h.conflict), '无冲突标记')
}
{
  // 大小写不敏感：Api/API/api 都命中；但与标准词完全一致的跳过
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
使用 Api 与 api 还有 API 接口
`)
  const g = [entry(1, 'API', ['api'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 2, `不敏感匹配命中 2 处（实际 ${hits.length}）`)
  assert(hits[0].found === 'Api' && hits[1].found === 'api', '命中保留原文大小写')
  assert(hits.every((h) => h.term === 'API'), '建议词统一为标准词')
}
{
  // 大小写敏感：只认完全一致
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
导出 srt 而不是 SRT 或 Srt
`)
  const g = [entry(1, 'SRT', ['srt'], true)]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && hits[0].found === 'srt', '敏感匹配仅命中全小写')
}
{
  // 拉丁词边界：rapid 里的 pi 不命中；独立 pi 命中；pi3 / 3pi 不命中
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
rapid 与 pi 值以及 pi3 和 3pi 还有 (pi)
`)
  const g = [entry(1, 'PI', ['pi'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 2, `词边界过滤后命中 2 处（实际 ${hits.length}）`)
  assert(hits[0].found === 'pi' && hits[1].found === 'pi', '边界内命中为独立词')
}
{
  // 中文无词边界要求；emoji 前导时码点偏移正确
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
👋你好这字慕不错
`)
  const g = [entry(1, '字幕', ['字慕'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1, '中文命中')
  assert(hits[0].start === 4 && hits[0].end === 6, `emoji 后码点偏移正确（实际 ${hits[0].start},${hits[0].end}）`)
}
{
  // 多行字幕展平后匹配
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
先按装
再启动
`)
  const g = [entry(1, '安装', ['按装'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && hits[0].start === 1 && hits[0].end === 3, '多行展平后命中')
  assert(flattenCueText(cues[0].lines) === '先按装 再启动', '展平规则：行间空格连接')
}

// ===========================================================================
console.log('== 扫描：冲突判定 ==')
{
  // 1) 同一别名对应多个标准词
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
他去了銀行
`)
  const g = [entry(1, '银行', ['銀行']), entry(2, '银号', ['銀行'])]
  // 归一化别名相同（銀行）但标准词不同 → 冲突
  const hits = scanTerms(cues, g)
  assert(hits.length === 2 && hits.every((h) => h.conflict), '一别名多标准词：全部冲突')
  assert(hits[0].reason!.includes('多个标准词'), '冲突原因说明多个标准词')
}
{
  // 1b) 同一别名同一标准词（重复条目）→ 去重为一次命中，不算冲突
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
这个帐号
`)
  const g = [entry(1, '账号', ['帐号']), entry(2, '账号', ['帐号'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && !hits[0].conflict, '同别名同标准词去重且不判冲突')
}
{
  // 2) 别名本身是另一条目的标准词
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
请先登陆再操作
`)
  const g = [entry(1, '登录', ['登陆']), entry(2, '登陆', ['登入'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && hits[0].conflict, '别名即他人标准词：冲突')
  assert(hits[0].reason!.includes('标准词'), '冲突原因提及标准词')
}
{
  // 3) 不同条目命中重叠
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
一二三
`)
  const g = [entry(1, '一', ['一二']), entry(2, '二', ['二三'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 2 && hits.every((h) => h.conflict), '跨条目重叠：全部冲突')
  assert(hits[0].reason!.includes('重叠'), '冲突原因提及重叠')
}
{
  // 3b) 同条目别名重叠 → 保留最左最长，不判冲突
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
一二三
`)
  const g = [entry(1, '一', ['一二', '二三'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && hits[0].found === '一二' && !hits[0].conflict, '同条目重叠保留最左最长')
}
{
  // 3c) 同条目同起点不同长度 → 保留最长
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
一二三
`)
  const g = [entry(1, '一', ['一二', '一二三'])]
  const hits = scanTerms(cues, g)
  assert(hits.length === 1 && hits[0].found === '一二三', '同起点保留最长匹配')
}

// ===========================================================================
console.log('== 替换预览 JSON ==')
{
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
先登陆你的帐号再按装

2
00:00:02,000 --> 00:00:03,000
没有命中的一行
`)
  const g = [
    entry(1, '登录', ['登陆']),
    entry(2, '登陆', ['登入']),
    entry(3, '账号', ['帐号']),
    entry(4, '安装', ['按装']),
  ]
  const hits = scanTerms(cues, g)
  assert(hits.length === 3 && hits.filter((h) => h.conflict).length === 1, '3 次命中 1 次冲突')
  const json = buildPreviewJson(cues, g, hits, '2026-09-21T00:00:00.000Z')
  assert(json.kind === 'terminology-replacement-preview' && json.version === 1, 'JSON 头部字段')
  assert(json.generatedAt === '2026-09-21T00:00:00.000Z', '生成时间可注入（可复现）')
  assert(json.summary.totalCues === 2 && json.summary.cuesWithHits === 1, '汇总：仅含命中字幕')
  assert(json.summary.hits === 3 && json.summary.conflicts === 1, '汇总：命中与冲突计数')
  assert(json.cues.length === 1 && json.cues[0].index === 1, '字幕序号为 1 基')
  const c0 = json.cues[0]
  assert(c0.original === '先登陆你的帐号再按装', 'original 为展平原文')
  assert(c0.preview === '先登陆你的账号再安装', `预览：非冲突已替换、冲突保留原文（实际 ${c0.preview}）`)
  assert(c0.replacements.length === 3, '替换明细完整')
  const r0 = c0.replacements[0]
  assert(r0.status === 'conflict' && r0.needsReview === true && !!r0.reason, '冲突条目标记 needsReview')
  const r1 = c0.replacements[1]
  assert(r1.status === 'replace' && r1.needsReview === false, '正常条目标记 replace')
  assert(r1.start === 5 && r1.end === 7 && r1.found === '帐号' && r1.term === '账号', '替换明细偏移与内容')
}
{
  // 同一字幕多处替换的偏移正确性
  const cues = cuesOf(`1
00:00:01,000 --> 00:00:02,000
帐号和帐号都要改
`)
  const g = [entry(1, '账号', ['帐号'])]
  const hits = scanTerms(cues, g)
  const json = buildPreviewJson(cues, g, hits, 't')
  assert(json.cues[0].preview === '账号和账号都要改', '多处替换全部应用')
}
{
  const json = buildPreviewJson(cuesOf(`1
00:00:01,000 --> 00:00:02,000
干净文本
`), [entry(1, '账号', ['帐号'])], [], 't')
  assert(json.cues.length === 0 && json.summary.hits === 0, '无命中时预览为空')
}

// ===========================================================================
console.log('== 内置演示：示例术语表 × 示例字幕 ==')
{
  const g = parseGlossary(SAMPLE_GLOSSARY)
  assert(g.warnings.length === 0, `示例术语表无警告（实际 ${g.warnings.join('；')}）`)
  assert(g.entries.length === 10, `示例术语表 10 条（实际 ${g.entries.length}）`)
  const cues = cuesOf(SAMPLE_TERMS_SRT)
  const hits = scanTerms(cues, g.entries)
  assert(hits.length === 9, `演示共 9 次命中（实际 ${hits.length}）`)
  const conflicts = hits.filter((h) => h.conflict)
  assert(conflicts.length === 1 && conflicts[0].found === '登陆', '演示含 1 处冲突（登陆）')
  const json = buildPreviewJson(cues, g.entries, hits, 't')
  assert(json.summary.cuesWithHits === 7, '演示 7 条字幕有命中')
  const cue3 = json.cues.find((c) => c.index === 3)!
  assert(cue3.preview === '先登陆你的账号再操作', '演示预览：登陆保留、帐号已替换')
}

// ===========================================================================
console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
