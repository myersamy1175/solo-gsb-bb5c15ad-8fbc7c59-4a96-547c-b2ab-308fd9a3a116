// 术语检查核心：术语表解析、全片扫描、冲突判定、替换预览 JSON 生成。
// 纯函数、无 DOM 依赖；扫描结果只描述“原词 → 建议词”，绝不改写任何字幕数据。

import { SrtCue } from './srt'

/** 术语表中的一条（用户导入格式） */
export interface Term {
  /** 标准词 */
  standard: string
  /** 别名（误写 / 旧称 / 异体），命中即建议替换为标准词 */
  aliases: string[]
  /** 大小写敏感：开启后标准词的错误大小写也算命中；关闭则忽略大小写 */
  caseSensitive: boolean
}

export interface ParsedGlossary {
  terms: Term[]
  /** 解析阶段的提示（跳过行、字段异常等） */
  warnings: string[]
}

/** 合并内置词库后的运行时术语（id 从 1 开始，全局连续编号） */
export interface MergedTerm extends Term {
  id: number
  /** 来自内置同音误写词库（命中默认需人工确认） */
  builtin: boolean
}

export type TermHitSource = 'alias' | 'case' | 'builtin'

/** 单次命中（定位到具体字幕的具体行、码点偏移） */
export interface TermHit {
  termId: number
  standard: string
  /** 实际命中的原词（保留字幕中的原始大小写） */
  found: string
  /** 建议替换词 */
  suggested: string
  /** 字幕全局序号（0 基） */
  cueIndex: number
  /** 行号（0 基） */
  line: number
  /** 行内码点偏移（含起点、不含终点） */
  start: number
  end: number
  source: TermHitSource
  /** 需人工确认：内置同音词、或发生术语冲突 */
  review: boolean
  conflict: boolean
  conflictReason?: string
}

export interface ScanResult {
  terms: MergedTerm[]
  hits: TermHit[]
  /** 术语表层面的冲突描述（同一别名指向多个标准词等） */
  conflicts: string[]
  warnings: string[]
}

/** 替换预览 JSON 中的单条替换 */
export interface PreviewReplacement {
  termIndex: number
  term: string
  from: string
  to: string
  /** 1 基行号 */
  line: number
  start: number
  end: number
  source: TermHitSource
  /** auto=可直接替换；review=建议项需人工确认；conflict=术语冲突，保留原文 */
  mode: 'auto' | 'review' | 'conflict'
  reason?: string
}

export interface PreviewCue {
  cueIndex: number
  startMs: number
  endMs: number
  originalText: string
  /** 仅应用 mode=auto 后的逐行预览（行数组）；review/conflict 不动 */
  previewLines: string[]
  replacements: PreviewReplacement[]
}

export interface ReplacementPreview {
  generatedAt: string
  kind: 'srt-term-replacement-preview'
  version: 1
  summary: {
    cuesTotal: number
    cuesWithHits: number
    totalHits: number
    autoReplacements: number
    reviewItems: number
    conflictItems: number
  }
  cues: PreviewCue[]
  note: string
}

// ---------------------------------------------------------------------------
// 内置常见同音 / 近音误写词库：[正确词, 误写词]。
// 仅收录高置信度的成词对照（2 字以上），单字误写一律不收，避免大面积误伤。
// 内置命中一律标记 review（需人工确认），不自动替换。
// ---------------------------------------------------------------------------
export const BUILTIN_HOMOPHONES: Array<[string, string]> = [
  ['安排', '按排'],
  ['辩论', '辨论'],
  ['辨别', '辩别'],
  ['部署', '布署'],
  ['沧海桑田', '苍海桑田'],
  ['虎视眈眈', '虎视耽耽'],
  ['重叠', '重迭'],
  ['度假村', '渡假村'],
  ['妨碍', '防碍'],
  ['一鼓作气', '一股作气'],
  ['甘拜下风', '甘败下风'],
  ['凑合', '凑和'],
  ['即使', '既使'],
  ['既然', '即然'],
  ['针灸', '针炙'],
  ['痉挛', '痉孪'],
  ['万籁俱寂', '万赖俱寂'],
  ['喉咙', '喉笼'],
  ['风靡', '风糜'],
  ['缅怀', '湎怀'],
  ['明信片', '名信片'],
  ['墨守成规', '默守成规'],
  ['精辟', '精僻'],
  ['招聘', '招娉'],
  ['罄竹难书', '磬竹难书'],
  ['融洽', '溶洽'],
  ['杂糅', '杂揉'],
  ['骚扰', '搔扰'],
  ['有恃无恐', '有持无恐'],
  ['追溯', '追朔'],
  ['纷至沓来', '纷至踏来'],
  ['偏袒', '偏坦'],
  ['趋之若鹜', '趋之若骛'],
  ['好高骛远', '好高鹜远'],
  ['通宵', '通霄'],
  ['九霄云外', '九宵云外'],
  ['寒暄', '寒喧'],
  ['喧闹', '暄闹'],
  ['栩栩如生', '诩诩如生'],
  ['博弈', '博奕'],
  ['世外桃源', '世外桃园'],
  ['赃款', '脏款'],
  ['瞻仰', '赡仰'],
  ['蛰伏', '蜇伏'],
  ['装帧', '装祯'],
  ['九州', '九洲'],
  ['坐落', '座落'],
  ['脉搏', '脉博'],
  ['粗犷', '粗旷'],
  ['走投无路', '走头无路'],
  ['饮鸩止渴', '饮鸠止渴'],
  ['迫不及待', '迫不急待'],
  ['一如既往', '一如继往'],
  ['川流不息', '穿流不息'],
  ['草菅人命', '草管人命'],
  ['脍炙人口', '烩炙人口'],
  ['矫揉造作', '娇揉造作'],
  ['候车室', '侯车室'],
]

// ---------------------------------------------------------------------------
// 术语表解析（JSON / CSV / TSV）
// ---------------------------------------------------------------------------

const SENSITIVE_RE = /^(1|true|yes|y|是|区分大小写|on)$/i
const UNSENSITIVE_RE = /^(0|false|no|n|否|不敏感|忽略大小写|off)$/i

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(/[|、,，;；\n\r]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

function pickField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k]
  }
  return undefined
}

function termFromObject(obj: Record<string, unknown>): Term | null {
  const standard = String(
    pickField(obj, ['standard', 'term', '标准词', '标准', '规范词', '词']) ?? ''
  ).trim()
  if (!standard) return null
  const aliasesRaw = pickField(obj, ['aliases', 'alias', '别名', '异体', '旧称'])
  const sensRaw = pickField(obj, ['caseSensitive', 'caseSensitive', 'sensitive', '大小写敏感', '区分大小写', '大小写'])
  let caseSensitive = false
  if (typeof sensRaw === 'boolean') caseSensitive = sensRaw
  else if (typeof sensRaw === 'number') caseSensitive = sensRaw !== 0
  else if (typeof sensRaw === 'string' && SENSITIVE_RE.test(sensRaw.trim())) caseSensitive = true
  const aliases = [...new Set(asArray(aliasesRaw))].filter((a) => a !== standard)
  return { standard, aliases, caseSensitive }
}

/** 极简 CSV/TSV 行解析（支持双引号包裹与 "" 转义），delimiter 自动识别 tab/逗号 */
function splitDelimited(text: string): string[][] {
  const delim = /\t/.test(text.split(/\r?\n/)[0] ?? '') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      pushField()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (field !== '' || row.length > 0) pushRow()
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

/** 解析导入的术语表文本：JSON（数组或 {terms:[...]}）或 CSV/TSV */
export function parseGlossary(raw: string): ParsedGlossary {
  const warnings: string[] = []
  const terms: Term[] = []
  const text = raw.replace(/^﻿/, '').trim()
  if (!text) return { terms, warnings }

  if (text[0] === '[' || text[0] === '{') {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (e) {
      warnings.push('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)))
      return { terms, warnings }
    }
    const arr: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.terms)
        ? ((data as Record<string, unknown>).terms as unknown[])
        : []
    if (arr.length === 0) warnings.push('JSON 中未找到术语数组（应为 [{...}] 或 {"terms":[...]}）')
    arr.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        warnings.push(`第 ${i + 1} 条不是对象，已跳过`)
        return
      }
      const t = termFromObject(item as Record<string, unknown>)
      if (!t) warnings.push(`第 ${i + 1} 条缺少标准词，已跳过`)
      else terms.push(t)
    })
    return { terms: dedupeTerms(terms, warnings), warnings }
  }

  // CSV / TSV
  const rows = splitDelimited(text)
  let startRow = 0
  const first = rows[0]?.map((c) => c.trim().toLowerCase()) ?? []
  if (first.some((c) => /标准|standard|规范/.test(c)) || first.some((c) => /别名|alias/.test(c))) {
    startRow = 1
  }
  for (let r = startRow; r < rows.length; r++) {
    const cells = rows[r]
    const standard = (cells[0] ?? '').trim()
    if (!standard) {
      if (cells.some((c) => c.trim() !== '')) warnings.push(`第 ${r + 1} 行缺少标准词，已跳过`)
      continue
    }
    const aliases = asArray(cells[1] ?? '')
    const sensCell = (cells[2] ?? '').trim()
    let caseSensitive = false
    if (sensCell !== '') {
      if (SENSITIVE_RE.test(sensCell)) caseSensitive = true
      else if (!UNSENSITIVE_RE.test(sensCell)) warnings.push(`第 ${r + 1} 行大小写选项「${sensCell}」无法识别，按忽略大小写处理`)
    }
    terms.push({ standard, aliases, caseSensitive })
  }
  return { terms: dedupeTerms(terms, warnings), warnings }
}

function dedupeTerms(terms: Term[], warnings: string[]): Term[] {
  const byStandard = new Map<string, Term>()
  for (const t of terms) {
    const key = t.standard
    const exist = byStandard.get(key)
    if (exist) {
      warnings.push(`标准词「${key}」重复，已合并别名`)
      exist.aliases = [...new Set([...exist.aliases, ...t.aliases])]
      exist.caseSensitive = exist.caseSensitive || t.caseSensitive
    } else {
      byStandard.set(key, { ...t, aliases: [...t.aliases] })
    }
  }
  return [...byStandard.values()]
}

// ---------------------------------------------------------------------------
// 合并用户术语表与内置同音词库
// ---------------------------------------------------------------------------

export function mergeGlossary(parsed: ParsedGlossary, builtinEnabled: boolean): ScanResult['terms'] {
  const merged: MergedTerm[] = parsed.terms.map((t, i) => ({
    ...t,
    aliases: [...t.aliases],
    id: i + 1,
    builtin: false,
  }))

  if (builtinEnabled) {
    // 用户术语中出现的字面值（标准词或别名，不分大小写）会抑制对应内置对照：
    // 用户术语表拥有最高优先级，避免与用户自己的命名决策冲突。
    const userLiterals = new Set<string>()
    for (const t of parsed.terms) {
      userLiterals.add(t.standard.toLowerCase())
      t.aliases.forEach((a) => userLiterals.add(a.toLowerCase()))
    }
    const seenWrong = new Set<string>()
    for (const [right, wrong] of BUILTIN_HOMOPHONES) {
      const w = wrong.toLowerCase()
      if (userLiterals.has(right.toLowerCase()) || userLiterals.has(w)) continue
      if (seenWrong.has(w)) continue
      seenWrong.add(w)
      merged.push({ standard: right, aliases: [wrong], caseSensitive: false, id: merged.length + 1, builtin: true })
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

const LATIN_EDGE_RE = /[A-Za-z0-9_]/

function cpArray(s: string): string[] {
  return Array.from(s)
}

/** 匹配字面量候选（未做边界/重叠处理） */
interface Candidate {
  start: number
  end: number
  found: string
  term: MergedTerm
  source: TermHitSource
}

function literalCandidates(
  lineChars: string[],
  literal: string,
  term: MergedTerm,
  source: TermHitSource,
  caseSensitive: boolean
): Candidate[] {
  const out: Candidate[] = []
  const lit = cpArray(literal)
  const m = lit.length
  const n = lineChars.length
  if (m === 0 || m > n) return out
  const firstIsLatin = LATIN_EDGE_RE.test(lit[0])
  const lastIsLatin = LATIN_EDGE_RE.test(lit[m - 1])

  for (let i = 0; i + m <= n; i++) {
    let ok = true
    for (let j = 0; j < m; j++) {
      const a = lineChars[i + j]
      const b = lit[j]
      if (caseSensitive ? a !== b : a.toLowerCase() !== b.toLowerCase()) {
        ok = false
        break
      }
    }
    if (!ok) continue
    // 拉丁侧做词边界检查，避免 USB 命中到 USBS / busby；中文侧不做限制
    if (firstIsLatin && i > 0 && LATIN_EDGE_RE.test(lineChars[i - 1])) continue
    if (lastIsLatin && i + m < n && LATIN_EDGE_RE.test(lineChars[i + m])) continue
    const found = lineChars.slice(i, i + m).join('')
    // 标准词的大小写检查：命中串与标准词完全一致时不算问题
    if (source === 'case' && found === term.standard) continue
    out.push({ start: i, end: i + m, found, term, source })
  }
  return out
}

/**
 * 扫描全部字幕。
 * 规则：
 *  - 用户术语别名命中：可自动替换；
 *  - 大小写敏感术语的错误大小写命中：可自动替换；
 *  - 内置同音误写命中：review，需人工确认；
 *  - 同一别名被多个标准词声明 / 同一位置被多个术语命中：conflict，保留原文。
 */
export function scanTerms(cues: SrtCue[], terms: MergedTerm[]): ScanResult {
  const warnings: string[] = []
  const conflicts: string[] = []
  const hits: TermHit[] = []

  // 术语表级冲突：同一别名（忽略大小写）指向多个不同标准词
  const aliasOwners = new Map<string, Set<string>>()
  for (const t of terms) {
    if (t.builtin) continue
    for (const a of t.aliases) {
      const key = a.toLowerCase()
      let set = aliasOwners.get(key)
      if (!set) {
        set = new Set()
        aliasOwners.set(key, set)
      }
      set.add(t.standard)
    }
  }
  const sharedAlias = new Map<string, string[]>()
  for (const [alias, owners] of aliasOwners) {
    if (owners.size > 1) {
      const list = [...owners]
      sharedAlias.set(alias, list)
      conflicts.push(`别名「${alias}」同时指向多个标准词：${list.join(' / ')}；相关命中保留原文，需人工确认`)
    }
  }

  for (let ci = 0; ci < cues.length; ci++) {
    const cue = cues[ci]
    for (let li = 0; li < cue.lines.length; li++) {
      const lineChars = cpArray(cue.lines[li])
      const raw: Candidate[] = []

      // 1) 用户术语
      for (const t of terms) {
        if (t.builtin) continue
        for (const a of t.aliases) {
          raw.push(...literalCandidates(lineChars, a, t, 'alias', t.caseSensitive))
        }
        if (t.caseSensitive && /[A-Za-z]/.test(t.standard)) {
          raw.push(...literalCandidates(lineChars, t.standard, t, 'case', false))
        }
      }

      // 2) 每术语内保最长（起止相同时优先级 alias > case），并记录已覆盖区间
      const perTerm = new Map<number, Candidate[]>()
      for (const c of raw) {
        const arr = perTerm.get(c.term.id) ?? []
        arr.push(c)
        perTerm.set(c.term.id, arr)
      }
      const importedSelected: Candidate[] = []
      for (const arr of perTerm.values()) {
        arr.sort((a, b) => a.start - b.start || b.end - a.end || (a.source === 'alias' ? -1 : 1))
        let lastEnd = -1
        for (const c of arr) {
          if (c.start < lastEnd) continue
          importedSelected.push(c)
          lastEnd = c.end
        }
      }

      // 已被用户术语覆盖的码点，内置同音词不再扫描（用户术语优先）
      const covered = new Array<boolean>(lineChars.length).fill(false)
      for (const c of importedSelected) {
        for (let k = c.start; k < c.end; k++) covered[k] = true
      }

      const builtinCands: Candidate[] = []
      for (const t of terms) {
        if (!t.builtin) continue
        for (const c of literalCandidates(lineChars, t.aliases[0], t, 'builtin', false)) {
          let overlap = false
          for (let k = c.start; k < c.end; k++) {
            if (covered[k]) {
              overlap = true
              break
            }
          }
          if (!overlap) builtinCands.push(c)
        }
      }

      // 3) 跨术语重叠：全部标记冲突，预览时保留原文
      const selected = [...importedSelected, ...builtinCands].sort(
        (a, b) => a.start - b.start || b.end - a.end
      )
      const conflictFlags = new Array<boolean>(selected.length).fill(false)
      for (let x = 0; x < selected.length; x++) {
        for (let y = x + 1; y < selected.length; y++) {
          if (selected[y].start >= selected[x].end) break
          if (selected[x].term.id !== selected[y].term.id) {
            conflictFlags[x] = true
            conflictFlags[y] = true
          }
        }
      }

      selected.forEach((c, idx) => {
        const owners = c.source === 'alias' ? sharedAlias.get(c.found.toLowerCase()) : undefined
        const isShared = !!owners && owners.length > 1
        const isConflict = conflictFlags[idx] || isShared
        let reason: string | undefined
        if (isShared) reason = `别名同时指向多个标准词：${owners!.join(' / ')}`
        else if (conflictFlags[idx]) reason = '同一位置命中多个术语（匹配重叠）'
        hits.push({
          termId: c.term.id,
          standard: c.term.standard,
          found: c.found,
          suggested: c.term.standard,
          cueIndex: ci,
          line: li,
          start: c.start,
          end: c.end,
          source: c.source,
          review: c.term.builtin,
          conflict: isConflict,
          conflictReason: reason,
        })
      })
    }
  }

  // 稳定排序：按字幕、行、位置
  hits.sort((a, b) => a.cueIndex - b.cueIndex || a.line - b.line || a.start - b.start)
  return { terms, hits, conflicts, warnings }
}

// ---------------------------------------------------------------------------
// 替换预览 JSON（不修改原字幕，仅描述预览）
// ---------------------------------------------------------------------------

export function buildReplacementPreview(cues: SrtCue[], scan: ScanResult): ReplacementPreview {
  const previewCues: PreviewCue[] = []
  let auto = 0
  let review = 0
  let conflict = 0

  for (let ci = 0; ci < cues.length; ci++) {
    const cueHits = scan.hits.filter((h) => h.cueIndex === ci)
    if (cueHits.length === 0) continue
    const cue = cues[ci]
    const lines = cue.lines.map((l) => l)

    const replacements: PreviewReplacement[] = cueHits.map((h) => {
      const mode: PreviewReplacement['mode'] = h.conflict ? 'conflict' : h.review ? 'review' : 'auto'
      if (mode === 'auto') auto++
      else if (mode === 'review') review++
      else conflict++
      return {
        termIndex: h.termId,
        term: h.standard,
        from: h.found,
        to: h.suggested,
        line: h.line + 1,
        start: h.start,
        end: h.end,
        source: h.source,
        mode,
        reason: h.conflictReason,
      }
    })

    // 仅自动项进入逐行替换预览；review/conflict 保持原文
    const autoHits = cueHits
      .filter((h) => !h.conflict && !h.review)
      .sort((a, b) => b.line - a.line || b.start - a.start)
    for (const h of autoHits) {
      const chars = cpArray(lines[h.line])
      chars.splice(h.start, h.end - h.start, h.suggested)
      lines[h.line] = chars.join('')
    }

    previewCues.push({
      cueIndex: ci,
      startMs: cue.startMs,
      endMs: cue.endMs,
      originalText: cue.lines.join('\n'),
      previewLines: lines,
      replacements,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    kind: 'srt-term-replacement-preview',
    version: 1,
    summary: {
      cuesTotal: cues.length,
      cuesWithHits: previewCues.length,
      totalHits: scan.hits.length,
      autoReplacements: auto,
      reviewItems: review,
      conflictItems: conflict,
    },
    cues: previewCues,
    note: '本文件仅为替换预览，未改写原始 SRT，也不影响节奏修复选区。mode=auto 可直接参考替换；mode=review 为内置同音建议、mode=conflict 为术语冲突，二者均保留原文，需人工确认。',
  }
}

/** 汇总行：同一术语下同一原词的命中聚合 */
export interface TermSummaryRow {
  termId: number
  standard: string
  found: string
  suggested: string
  source: TermHitSource
  builtin: boolean
  review: boolean
  conflict: boolean
  count: number
  cueIndexes: number[]
}

export function summarizeHits(hits: TermHit[], terms: MergedTerm[]): TermSummaryRow[] {
  const map = new Map<string, TermSummaryRow>()
  for (const h of hits) {
    const key = `${h.termId} ${h.found}`
    let row = map.get(key)
    if (!row) {
      row = {
        termId: h.termId,
        standard: h.standard,
        found: h.found,
        suggested: h.suggested,
        source: h.source,
        builtin: terms.find((t) => t.id === h.termId)?.builtin ?? false,
        review: h.review,
        conflict: h.conflict,
        count: 0,
        cueIndexes: [],
      }
      map.set(key, row)
    }
    row.count++
    if (!row.cueIndexes.includes(h.cueIndex)) row.cueIndexes.push(h.cueIndex)
    row.review = row.review || h.review
    row.conflict = row.conflict || h.conflict
  }
  return [...map.values()].sort(
    (a, b) =>
      Number(b.conflict) - Number(a.conflict) ||
      a.termId - b.termId ||
      a.found.localeCompare(b.found, 'zh-Hans-CN')
  )
}
