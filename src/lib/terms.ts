// 术语检查：术语表解析、全片扫描（别名 / 同音误写）、冲突判定与替换预览 JSON。
// 只读模块：扫描与预览均不改写原字幕，也不触碰当前修复选区。

import { SrtCue } from './srt'
import { charsOf } from './text'

/** 术语表条目 */
export interface GlossaryEntry {
  /** 条目序号（从 1 开始，按导入顺序） */
  id: number
  /** 标准词（建议词） */
  term: string
  /** 别名 / 同音误写（字幕中需要被发现的写法） */
  aliases: string[]
  /** 大小写敏感（仅影响拉丁字母匹配；中文不受影响） */
  caseSensitive: boolean
}

/** 一条命中记录 */
export interface TermHit {
  /** 命中字幕的全局下标（0 基） */
  cueIndex: number
  /** 命中条目序号 */
  entryId: number
  /** 建议词（标准词） */
  term: string
  /** 术语表中的别名 */
  alias: string
  /** 字幕中实际命中的文字 */
  found: string
  /** 在展平字幕文本中的码点区间 [start, end) */
  start: number
  end: number
  /** 是否冲突：冲突时保留原文，需人工确认 */
  conflict: boolean
  /** 冲突原因 */
  reason?: string
}

/** 展平一条字幕的文本（与求解器一致：逐行 trim、丢弃空行、行间以空格连接） */
export function flattenCueText(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
}

// ---------------------------------------------------------------------------
// 术语表解析
// ---------------------------------------------------------------------------

/** 文本格式中别名之间的分隔符 */
const ALIAS_SPLIT_RE = /[|、；;/]/

function splitAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  if (typeof raw === 'string') return raw.split(ALIAS_SPLIT_RE)
  return []
}

/** 解析大小写敏感标志：是/否、true/false、1/0、敏感/不敏感 等 */
function parseCaseFlag(raw: string | undefined): { value: boolean; ok: boolean } {
  if (raw === undefined || raw.trim() === '') return { value: false, ok: true }
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', '是', '敏感', '区分', '区分大小写'].includes(v)) return { value: true, ok: true }
  if (['0', 'false', 'no', 'n', '否', '不敏感', '不区分', '不区分大小写'].includes(v)) return { value: false, ok: true }
  return { value: false, ok: false }
}

/** 构造并校验一个条目；不合法时返回 null 并记录警告 */
function buildEntry(
  id: number,
  termRaw: unknown,
  aliasesRaw: unknown,
  csRaw: unknown,
  where: string,
  warnings: string[]
): GlossaryEntry | null {
  const term = typeof termRaw === 'string' ? termRaw.trim() : ''
  if (!term) {
    warnings.push(`${where}：缺少标准词，已跳过`)
    return null
  }
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const a0 of splitAliases(aliasesRaw)) {
    const a = a0.trim()
    if (!a) continue
    if (a === term) {
      warnings.push(`${where}：别名「${a}」与标准词相同，已忽略该别名`)
      continue
    }
    if (seen.has(a)) continue
    seen.add(a)
    aliases.push(a)
  }
  if (aliases.length === 0) {
    warnings.push(`${where}：标准词「${term}」没有可用别名，已跳过`)
    return null
  }
  let caseSensitive = false
  if (typeof csRaw === 'boolean') caseSensitive = csRaw
  else if (csRaw !== undefined && csRaw !== null && String(csRaw).trim() !== '') {
    const f = parseCaseFlag(String(csRaw))
    if (!f.ok) warnings.push(`${where}：大小写敏感选项「${String(csRaw)}」无法识别，按不敏感处理`)
    caseSensitive = f.value
  }
  return { id, term, aliases, caseSensitive }
}

/**
 * 解析术语表，支持两种格式：
 * - JSON：[{ "term": "标准词", "aliases": ["别名1", "别名2"], "caseSensitive": false }, ...]
 *   （也接受 { "entries": [...] } 包装；aliases 可写数组或用 |、；、;、/、、分隔的字符串）
 * - 文本（.csv/.tsv/.txt）：每行「标准词, 别名1|别名2, 大小写敏感(可选)」，
 *   列分隔符自动识别制表符或逗号；# 开头为注释；首行若为「标准词,…」表头则跳过；
 *   末列可识别为标志（是/否/true/false/1/0…）时按标志处理，否则并入别名。
 */
export function parseGlossary(raw: string): { entries: GlossaryEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = text.trim()
  if (!trimmed) return { entries: [], warnings: ['术语表内容为空'] }

  const entries: GlossaryEntry[] = []

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch (e) {
      return { entries: [], warnings: [`JSON 解析失败：${(e as Error).message}`] }
    }
    const list: unknown[] | null = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).entries)
        ? ((data as Record<string, unknown>).entries as unknown[])
        : null
    if (!list) return { entries: [], warnings: ['JSON 结构应为条目数组，或含 entries 数组的对象'] }
    list.forEach((item, i) => {
      const where = `第 ${i + 1} 项`
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        warnings.push(`${where}：不是对象，已跳过`)
        return
      }
      const o = item as Record<string, unknown>
      const e = buildEntry(
        entries.length + 1,
        o.term ?? o.standard ?? o['标准词'],
        o.aliases ?? o.alias ?? o['别名'],
        o.caseSensitive ?? o.cs,
        where,
        warnings
      )
      if (e) entries.push(e)
    })
    return { entries, warnings }
  }

  // 文本格式
  const lines = text.split('\n')
  let firstDataLine = true
  lines.forEach((line0, li) => {
    const line = line0.trim()
    if (!line || line.startsWith('#')) return
    const cells = (line.includes('\t') ? line0.split('\t') : line0.split(',')).map((c) => c.trim())
    if (firstDataLine) {
      firstDataLine = false
      if (/^(标准词|标准术语|术语|term|standard)$/i.test(cells[0] ?? '')) return // 表头
    }
    const where = `第 ${li + 1} 行`
    // 末列可识别为大小写标志 → 标志列；否则整段并入别名
    const rest = cells.slice(1)
    let flagRaw: string | undefined
    let aliasCells = rest
    if (rest.length >= 2) {
      const last = rest[rest.length - 1]
      if (last !== '' && parseCaseFlag(last).ok) {
        flagRaw = last
        aliasCells = rest.slice(0, -1)
      }
    }
    const e = buildEntry(entries.length + 1, cells[0], aliasCells.join('|'), flagRaw, where, warnings)
    if (e) entries.push(e)
  })
  return { entries, warnings }
}

// ---------------------------------------------------------------------------
// 全片扫描
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ASCII_ALNUM_RE = /^[A-Za-z0-9]$/

/** 拉丁词边界：别名首/尾为 ASCII 字母数字时，相邻字符不得也是 ASCII 字母数字（避免 api 命中 rapid） */
function boundaryOk(text: string, start: number, end: number, alias: string): boolean {
  if (ASCII_ALNUM_RE.test(alias[0]) && start > 0 && ASCII_ALNUM_RE.test(text[start - 1])) return false
  if (ASCII_ALNUM_RE.test(alias[alias.length - 1]) && end < text.length && ASCII_ALNUM_RE.test(text[end]))
    return false
  return true
}

/** 在 text 中查找 alias 的全部出现，返回 UTF-16 偏移区间 */
function findOccurrences(text: string, alias: string, caseSensitive: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = new RegExp(escapeRegExp(alias), caseSensitive ? 'gu' : 'giu')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length])
    if (m[0].length === 0) re.lastIndex++ // 防御：空匹配避免死循环（别名非空，正常不会触发）
  }
  return out
}

/** UTF-16 下标 → 码点下标 */
function toCodePoint(text: string, idx: number): number {
  let cp = 0
  for (let i = 0; i < idx; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < idx) i++ // 跳过代理对低位
    cp++
  }
  return cp
}

/** 归一化比较键：大小写折叠（冲突判定从严，宁可多报人工确认） */
function normKey(s: string): string {
  return s.toLowerCase()
}

interface GlossaryIndex {
  /** 归一化别名 → 建议词集合 */
  aliasTerms: Map<string, Set<string>>
  /** 归一化标准词 → 首个条目序号 */
  termOwner: Map<string, number>
}

function buildGlossaryIndex(entries: GlossaryEntry[]): GlossaryIndex {
  const aliasTerms = new Map<string, Set<string>>()
  const termOwner = new Map<string, number>()
  for (const e of entries) {
    const tk = normKey(e.term)
    if (!termOwner.has(tk)) termOwner.set(tk, e.id)
    for (const a of e.aliases) {
      const k = normKey(a)
      let set = aliasTerms.get(k)
      if (!set) {
        set = new Set()
        aliasTerms.set(k, set)
      }
      set.add(e.term)
    }
  }
  return { aliasTerms, termOwner }
}

/** 术语表层面的冲突：别名对应多个标准词，或别名本身是另一条目的标准词 */
function glossaryConflict(idx: GlossaryIndex, e: GlossaryEntry, alias: string): string | undefined {
  const k = normKey(alias)
  const terms = idx.aliasTerms.get(k)
  if (terms && terms.size > 1) {
    return `别名「${alias}」对应多个标准词（${[...terms].join('、')}），无法自动判断`
  }
  const owner = idx.termOwner.get(k)
  if (owner !== undefined && owner !== e.id) {
    return `别名「${alias}」本身是条目 #${owner} 的标准词，替换可能误伤正确用法`
  }
  return undefined
}

/**
 * 扫描整部 SRT，找出术语表中登记的别名 / 同音误写。
 * 命中按（字幕下标, 起始偏移）排序；冲突命中保留在结果中并标记 conflict。
 */
export function scanTerms(cues: SrtCue[], entries: GlossaryEntry[]): TermHit[] {
  const idx = buildGlossaryIndex(entries)
  const hits: TermHit[] = []

  cues.forEach((cue, cueIndex) => {
    const flat = flattenCueText(cue.lines)
    if (!flat) return

    // 收集候选命中（码点偏移）
    const cands: TermHit[] = []
    for (const e of entries) {
      for (const alias of e.aliases) {
        const gReason = glossaryConflict(idx, e, alias)
        for (const [s16, e16] of findOccurrences(flat, alias, e.caseSensitive)) {
          if (!boundaryOk(flat, s16, e16, alias)) continue
          const found = flat.slice(s16, e16)
          if (found === e.term) continue // 与标准词完全一致，无需替换
          cands.push({
            cueIndex,
            entryId: e.id,
            term: e.term,
            alias,
            found,
            start: toCodePoint(flat, s16),
            end: toCodePoint(flat, e16),
            conflict: !!gReason,
            reason: gReason,
          })
        }
      }
    }
    if (cands.length === 0) return

    // 去重：相同区间且相同建议词的候选（来自重复/等价条目）只保留一个
    const seenKey = new Set<string>()
    const deduped = cands.filter((c) => {
      const key = `${c.start}:${c.end}:${c.term}`
      if (seenKey.has(key)) return false
      seenKey.add(key)
      return true
    })

    // 重叠分组：按起点升序、同起点长者优先
    deduped.sort((a, b) => a.start - b.start || b.end - a.end || a.entryId - b.entryId || a.alias.localeCompare(b.alias))
    const groups: TermHit[][] = []
    let cur: TermHit[] = []
    let curEnd = -1
    for (const c of deduped) {
      if (cur.length > 0 && c.start < curEnd) {
        cur.push(c)
        curEnd = Math.max(curEnd, c.end)
      } else {
        if (cur.length > 0) groups.push(cur)
        cur = [c]
        curEnd = c.end
      }
    }
    if (cur.length > 0) groups.push(cur)

    for (const g of groups) {
      if (g.length === 1) {
        hits.push(g[0])
        continue
      }
      const entryIds = new Set(g.map((h) => h.entryId))
      if (entryIds.size === 1) {
        // 同一条目的多个别名重叠：建议词一致，保留最左最长者
        hits.push(g[0])
        continue
      }
      // 不同条目的命中相互重叠：全部保留原文，标记需人工确认
      for (const h of g) {
        const others = [
          ...new Set(g.filter((o) => o !== h).map((o) => `#${o.entryId}「${o.found}→${o.term}」`)),
        ]
        const overlapReason = `与条目 ${others.join('、')} 的命中重叠`
        hits.push({
          ...h,
          conflict: true,
          reason: h.reason ? `${h.reason}；${overlapReason}` : overlapReason,
        })
      }
    }
  })

  return hits
}

// ---------------------------------------------------------------------------
// 替换预览 JSON（只读，不改写任何字幕数据）
// ---------------------------------------------------------------------------

export interface PreviewReplacement {
  /** 条目序号 */
  entry: number
  /** 建议词（标准词） */
  term: string
  /** 术语表中的别名 */
  alias: string
  /** 字幕中实际命中的文字 */
  found: string
  /** 码点区间 [start, end)（基于 original 展平文本） */
  start: number
  end: number
  /** replace=可替换；conflict=冲突保留原文 */
  status: 'replace' | 'conflict'
  /** 是否需人工确认 */
  needsReview: boolean
  reason?: string
}

/**
 * 生成替换预览 JSON：仅包含命中字幕的原文与预览（非冲突命中已替换、冲突处保留原文），
 * 供外部工具或人工核对使用；不改动原字幕与当前修复选区。
 */
export function buildPreviewJson(
  cues: SrtCue[],
  entries: GlossaryEntry[],
  hits: TermHit[],
  generatedAt: string = new Date().toISOString()
) {
  const byCue = new Map<number, TermHit[]>()
  for (const h of hits) {
    const arr = byCue.get(h.cueIndex)
    if (arr) arr.push(h)
    else byCue.set(h.cueIndex, [h])
  }

  const cueObjs = [...byCue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cueIndex, hs]) => {
      const original = flattenCueText(cues[cueIndex].lines)
      // 仅应用非冲突替换（从后往前，保持偏移有效）；冲突处保留原文
      const chars = charsOf(original)
      const applicable = hs.filter((h) => !h.conflict).sort((a, b) => b.start - a.start)
      for (const h of applicable) {
        chars.splice(h.start, h.end - h.start, ...charsOf(h.term))
      }
      const replacements: PreviewReplacement[] = [...hs]
        .sort((a, b) => a.start - b.start || a.entryId - b.entryId)
        .map((h) => ({
          entry: h.entryId,
          term: h.term,
          alias: h.alias,
          found: h.found,
          start: h.start,
          end: h.end,
          status: h.conflict ? ('conflict' as const) : ('replace' as const),
          needsReview: h.conflict,
          ...(h.reason ? { reason: h.reason } : {}),
        }))
      return { index: cueIndex + 1, original, preview: chars.join(''), replacements }
    })

  const conflicts = hits.filter((h) => h.conflict).length
  return {
    kind: 'terminology-replacement-preview',
    version: 1,
    generatedAt,
    glossaryEntries: entries.length,
    summary: {
      totalCues: cues.length,
      cuesWithHits: cueObjs.length,
      hits: hits.length,
      conflicts,
    },
    cues: cueObjs,
  }
}
