// 术语检查核心测试：解析、扫描、大小写、冲突、内置同音词、替换预览
import { parseSrt } from './srt'
import {
  parseGlossary,
  mergeGlossary,
  scanTerms,
  buildReplacementPreview,
  summarizeHits,
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
function eq<T>(a: T, b: T, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）`)
}

function srt(text: string) {
  return parseSrt(text).cues
}

// ---- 1. JSON 解析 ----
{
  const g = parseGlossary(JSON.stringify({ terms: [
    { 标准词: '人工智能', aliases: ['AI技术', '人工智能'], '大小写敏感': true },
    { standard: 'USB', aliases: ['usb'], caseSensitive: true },
    { aliases: ['x'] },
  ] }))
  eq(g.terms.length, 2, 'JSON：缺少标准词的条目被跳过')
  eq(g.terms[0].standard, '人工智能', 'JSON：中文字段名')
  eq(g.terms[0].caseSensitive, true, 'JSON：中文字段名大小写敏感')
  eq(g.terms[0].aliases, ['AI技术'], 'JSON：与标准词相同的别名被剔除')
  assert(g.warnings.some((w) => w.includes('缺少标准词')), 'JSON：缺少标准词产生提示')
}

// ---- 2. CSV/TSV 解析（表头、分隔符、多别名、引号） ----
{
  const csv = '标准词,别名,大小写敏感\n人工智能,AI技术|AI 技术,是\nUSB,"usb,USB口",true\n裸词|别名2\n'
  const g = parseGlossary(csv)
  eq(g.terms.length, 3, 'CSV：解析三行')
  eq(g.terms[0].aliases, ['AI技术', 'AI 技术'], 'CSV：| 分隔多别名')
  eq(g.terms[0].caseSensitive, true, 'CSV：是 → 大小写敏感')
  eq(g.terms[1].aliases, ['usb', 'USB口'], 'CSV：引号包裹逗号字段')
  eq(g.terms[2].caseSensitive, false, 'CSV：无表头数据行也可解析')

  const tsv = '标准词\t别名\n云服务\t云伺服器'
  assert(parseGlossary(tsv).terms[0].aliases[0] === '云伺服器', 'TSV：tab 分隔')

  const bad = parseGlossary('{bad json')
  assert(bad.warnings.length > 0 && bad.terms.length === 0, '坏 JSON：警告且无术语')
}

// ---- 3. 重复标准词合并 ----
{
  const g = parseGlossary(JSON.stringify([
    { standard: 'A', aliases: ['a1'], caseSensitive: false },
    { standard: 'A', aliases: ['a1', 'a2'], caseSensitive: true },
  ]))
  eq(g.terms.length, 1, '重复标准词合并为一条')
  eq(g.terms[0].aliases, ['a1', 'a2'], '重复标准词合并别名')
  eq(g.terms[0].caseSensitive, true, '重复标准词大小写选项取或')
}

// ---- 4. 基础扫描：别名命中与行/偏移定位 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n人工智能来了 AI技术\n第二行也是 AI技术\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '人工智能', aliases: ['AI技术'] },
  ])), false)
  const scan = scanTerms(cues, terms)
  eq(scan.hits.length, 2, '别名命中 2 次（标准词本身不命中）')
  assert(scan.hits[0].line === 0 && scan.hits[0].start === 7 && scan.hits[0].end === 11, '命中行内码点偏移')
  assert(scan.hits[1].line === 1, '命中第二行')
  assert(!scan.hits[0].review && !scan.hits[0].conflict, '用户别名：自动替换，无需复核')
  eq(scan.hits[0].suggested, '人工智能', '建议词为标准词')
}

// ---- 5. 大小写敏感 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\nusb 接口 USB 接口\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: 'USB', aliases: ['usb'], caseSensitive: true },
  ])), false)
  const scan = scanTerms(cues, terms)
  // usb（别名）+ USB（标准词本身）……标准词本身完全一致不算命中，故只 1 次
  eq(scan.hits.length, 1, '大小写敏感：标准词正确大小写不算命中，仅别名 1 次')
  eq(scan.hits[0].found, 'usb', '大小写敏感：小写 usb 命中')

  // 标准词出现错误大小写（Usb）时也算命中
  const cues2 = srt('1\n00:00:01,000 --> 00:00:02,000\nUsb 和 usb\n')
  const scan2 = scanTerms(cues2, terms)
  eq(scan2.hits.length, 2, '大小写敏感：错误大小写 Usb 与别名 usb 均命中')
  assert(scan2.hits.some((h) => h.found === 'Usb' && h.source === 'case'), '错误大小写来源为 case')
}

// ---- 6. 忽略大小写时标准词/别名的不同大小写均命中别名 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\nWiFi 与 WIFI\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: 'Wi-Fi', aliases: ['WiFi'], caseSensitive: false },
  ])), false)
  const scan = scanTerms(cues, terms)
  eq(scan.hits.length, 2, '忽略大小写：WiFi / WIFI 均命中')
  eq([...new Set(scan.hits.map((h) => h.found))], ['WiFi', 'WIFI'], '保留原词大小写')
}

// ---- 7. 拉丁词边界（不做子串误命中）----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\nUSBX 与 xUSB 与 USB 与 usb\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: 'USB', aliases: [], caseSensitive: true },
  ])), false)
  const scan = scanTerms(cues, terms)
  eq(scan.hits.length, 1, '拉丁词边界：仅独立小写 usb 命中，USBX/xUSB/正确 USB 不命中')
}

// ---- 8. 内置同音误写：命中并需人工确认 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:03,000\n这里是渡假村，安排就绪\n')
  const terms = mergeGlossary(parseGlossary(''), true)
  const scan = scanTerms(cues, terms)
  const du = scan.hits.filter((h) => h.found === '渡假村')
  eq(du.length, 1, '内置：渡假村 → 度假村')
  assert(du[0].review && !du[0].conflict, '内置命中：review 需人工确认')
  eq(du[0].suggested, '度假村', '内置建议词正确')
  // 正确写法不命中
  const ok = scanTerms(srt('1\n00:00:01,000 --> 00:00:02,000\n度假村真美\n'), terms)
  eq(ok.hits.filter((h) => h.found.includes('度假')).length, 0, '内置：正确写法不命中')
}

// ---- 9. 用户术语抑制内置对照 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n渡假村\n')
  const g = parseGlossary(JSON.stringify([{ standard: '渡假村', aliases: [] }]))
  const terms = mergeGlossary(g, true)
  const scan = scanTerms(cues, terms)
  eq(scan.hits.length, 0, '用户术语表中的字面值抑制内置同音对照')
}

// ---- 10. 关闭内置词库 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n渡假村\n')
  const terms = mergeGlossary(parseGlossary(''), false)
  eq(scanTerms(cues, terms).hits.length, 0, '关闭内置词库：无命中')
}

// ---- 11. 术语表级冲突：同一别名指向多个标准词 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n3D模型展示\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '三维模型', aliases: ['3D模型'] },
    { standard: '3D建模', aliases: ['3D模型'] },
  ])), false)
  const scan = scanTerms(cues, terms)
  eq(scan.hits.length, 2, '共享别名：两个标准词各产生一条命中')
  assert(scan.hits.every((h) => h.conflict), '共享别名：全部标记 conflict')
  assert(scan.conflicts.length === 1, '术语表冲突描述 1 条')
}

// ---- 12. 位置级冲突：两个术语在同一处重叠 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n人工智能建模\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: 'AI', aliases: ['人工智能'] },
    { standard: '建模X', aliases: ['智能建模'] },
  ])), false)
  const scan = scanTerms(cues, terms)
  assert(scan.hits.every((h) => h.conflict), '重叠命中：双方均标 conflict')
  assert(scan.hits[0].conflictReason?.includes('重叠'), '冲突原因说明')
}

// ---- 13. 替换预览：只应用 auto，review/conflict 保留原文 ----
{
  const cues = srt(
    '1\n00:00:01,000 --> 00:00:02,000\n渡假村的 AI技术\n' +
    '\n2\n00:00:03,000 --> 00:00:04,000\n没有问题的一条\n'
  )
  const g = parseGlossary(JSON.stringify([{ standard: '人工智能', aliases: ['AI技术'] }]))
  const terms = mergeGlossary(g, true)
  const scan = scanTerms(cues, terms)
  const pv = buildReplacementPreview(cues, scan)
  eq(pv.summary.cuesTotal, 2, '预览：总条数')
  eq(pv.summary.cuesWithHits, 1, '预览：仅 1 条有命中')
  eq(pv.summary.autoReplacements, 1, '预览：1 个自动替换')
  eq(pv.summary.reviewItems, 1, '预览：1 个需人工确认')
  const c0 = pv.cues[0]
  eq(c0.previewLines, ['渡假村的 人工智能'], '预览：仅 auto 应用，渡假村保留原文')
  eq(c0.originalText, '渡假村的 AI技术', '预览：原文保留')
  assert(pv.note.includes('未改写原始 SRT'), '预览：包含说明')

  // 无命中的 cue 不在预览中
  eq(pv.cues.length, 1, '预览：无命中条不出现在 cues')
}

// ---- 14. 冲突项保留原文 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n3D模型\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '三维模型', aliases: ['3D模型'] },
    { standard: '3D建模', aliases: ['3D模型'] },
  ])), false)
  const scan = scanTerms(cues, terms)
  const pv = buildReplacementPreview(cues, scan)
  eq(pv.summary.conflictItems, 2, '预览：2 个冲突项')
  eq(pv.cues[0].previewLines, ['3D模型'], '预览：冲突时保留原文')
  assert(pv.cues[0].replacements.every((r) => r.mode === 'conflict'), '预览：冲突 mode=conflict')
}

// ---- 15. 一条字幕多个 auto 替换、偏移不互相干扰 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\nusb 与 USB口\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: 'USB', aliases: ['usb', 'USB口'], caseSensitive: true },
  ])), false)
  const scan = scanTerms(cues, terms)
  const pv = buildReplacementPreview(cues, scan)
  eq(pv.cues[0].previewLines, ['USB 与 USB'], '同条多个 auto 全部替换（基于原始偏移倒序应用）')
}

// ---- 16. 汇总：条目序号、原词、建议词、命中次数、按条去重 ----
{
  const cues = srt(
    '1\n00:00:01,000 --> 00:00:02,000\nAI技术 AI技术\n' +
    '\n2\n00:00:03,000 --> 00:00:04,000\nAI技术\n'
  )
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '人工智能', aliases: ['AI技术'] },
  ])), false)
  const rows = summarizeHits(scanTerms(cues, terms).hits, terms)
  eq(rows.length, 1, '汇总：同术语同原词合并为一行')
  eq(rows[0].count, 3, '汇总：命中次数 3')
  eq(rows[0].cueIndexes, [0, 1], '汇总：命中的字幕序号（去重）')
  eq(rows[0].termId, 1, '汇总：条目序号（术语表序号）')
}

// ---- 17. 不扫描标准词本身 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n人工智能\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '人工智能', aliases: ['人工智能', 'AI技术'] },
  ])), false)
  eq(scanTerms(cues, terms).hits.length, 0, '别名等于标准词时不扫描标准词自身')
}

// ---- 18. 多行字幕只替换命中行 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:03,000\n第一行没问题\n第二行 AI技术\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '人工智能', aliases: ['AI技术'] },
  ])), false)
  const pv = buildReplacementPreview(cues, scanTerms(cues, terms))
  eq(pv.cues[0].previewLines, ['第一行没问题', '第二行 人工智能'], '多行：仅命中行参与替换')
}

// ---- 19. 内置 id 排在用户术语之后且连续 ----
{
  const g = parseGlossary(JSON.stringify([
    { standard: 'A', aliases: ['a'] },
    { standard: 'B', aliases: ['b'] },
  ]))
  const terms = mergeGlossary(g, true)
  assert(terms.every((t, i) => t.id === i + 1), '合并术语 id 从 1 连续编号')
  assert(terms.slice(0, 2).every((t) => !t.builtin), '用户术语在前')
  assert(terms.slice(2).every((t) => t.builtin), '内置术语在后')
}

// ---- 20. 代理对 / emoji 不破坏偏移 ----
{
  const cues = srt('1\n00:00:01,000 --> 00:00:02,000\n😀AI技术\n')
  const terms = mergeGlossary(parseGlossary(JSON.stringify([
    { standard: '人工智能', aliases: ['AI技术'] },
  ])), false)
  const scan = scanTerms(cues, terms)
  eq([scan.hits[0].start, scan.hits[0].end], [1, 5], '码点偏移：emoji 占 1 个码点')
}

console.log(`\n术语检查测试：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
