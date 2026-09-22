import { useMemo, useState } from 'react'
import {
  GlossaryEntry,
  buildPreviewJson,
  flattenCueText,
  parseGlossary,
  scanTerms,
} from '../lib/terms'
import { SrtCue, msToSrtTime } from '../lib/srt'
import { charsOf } from '../lib/text'

interface TermCheckProps {
  cues: SrtCue[]
  glossary: GlossaryEntry[]
  onGlossaryChange: (entries: GlossaryEntry[]) => void
  /** 点击命中：跳转并高亮对应字幕（下标 0 基） */
  onJumpToCue: (cueIndex: number) => void
  /** 载入内置演示（示例字幕 + 示例术语表） */
  onLoadDemo: () => void
}

const HIT_LIST_LIMIT = 300
/** 命中前后保留的上下文字符数 */
const SNIPPET_CTX = 14

export default function TermCheck({
  cues,
  glossary,
  onGlossaryChange,
  onJumpToCue,
  onLoadDemo,
}: TermCheckProps) {
  const [warnings, setWarnings] = useState<string[]>([])
  /** 按术语条目筛选（null = 全部） */
  const [filterEntry, setFilterEntry] = useState<number | null>(null)

  // 全片扫描：字幕或术语表变化即自动重扫（只读，不改写任何数据）
  const hits = useMemo(
    () => (cues.length > 0 && glossary.length > 0 ? scanTerms(cues, glossary) : []),
    [cues, glossary]
  )

  // 汇总行：按（条目, 别名）分组统计命中次数
  const rows = useMemo(() => {
    const map = new Map<
      string,
      { entryId: number; alias: string; term: string; count: number; conflicts: number }
    >()
    for (const h of hits) {
      const key = `${h.entryId}|${h.alias}`
      let r = map.get(key)
      if (!r) {
        r = { entryId: h.entryId, alias: h.alias, term: h.term, count: 0, conflicts: 0 }
        map.set(key, r)
      }
      r.count++
      if (h.conflict) r.conflicts++
    }
    return [...map.values()].sort((a, b) => a.entryId - b.entryId || a.alias.localeCompare(b.alias))
  }, [hits])

  const filteredHits = useMemo(
    () => (filterEntry === null ? hits : hits.filter((h) => h.entryId === filterEntry)),
    [hits, filterEntry]
  )

  const conflictCount = useMemo(() => hits.filter((h) => h.conflict).length, [hits])
  const cueWithHits = useMemo(() => new Set(hits.map((h) => h.cueIndex)).size, [hits])
  const entriesWithHits = useMemo(
    () => [...new Set(hits.map((h) => h.entryId))].sort((a, b) => a - b),
    [hits]
  )
  const hitCountByEntry = useMemo(() => {
    const m = new Map<number, number>()
    for (const h of hits) m.set(h.entryId, (m.get(h.entryId) ?? 0) + 1)
    return m
  }, [hits])

  const onFile = async (file: File) => {
    const text = await file.text()
    const r = parseGlossary(text)
    setWarnings(r.warnings)
    if (r.entries.length > 0) {
      onGlossaryChange(r.entries)
      setFilterEntry(null)
    }
  }

  const exportJson = () => {
    const data = buildPreviewJson(cues, glossary, hits)
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'terminology-preview.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const termOf = (id: number) => glossary.find((g) => g.id === id)?.term ?? ''

  return (
    <section className="panel">
      <h2>
        <span className="step-num alt">术</span>术语检查（全片扫描 · 只读预览，不改写字幕与选区）
      </h2>

      <div className="row">
        <label className="field">
          <span className="hint">导入术语表（.json / .csv / .tsv / .txt）</span>
          <input
            type="file"
            accept=".json,.csv,.tsv,.txt,application/json,text/plain"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        <button className="ghost" onClick={onLoadDemo}>
          载入术语演示
        </button>
        {glossary.length > 0 && (
          <button
            className="ghost"
            onClick={() => {
              onGlossaryChange([])
              setWarnings([])
              setFilterEntry(null)
            }}
          >
            清空术语表
          </button>
        )}
        <span className="hint">
          {glossary.length > 0 ? `已载入 ${glossary.length} 条术语` : '尚未载入术语表'}
          {cues.length > 0 && glossary.length > 0 && `，已扫描 ${cues.length} 条字幕`}
        </span>
      </div>
      {warnings.length > 0 && (
        <p className="hint" style={{ color: 'var(--warn)', marginTop: 8 }}>
          术语表提示：{warnings.join('；')}
        </p>
      )}
      {cues.length === 0 && (
        <p className="hint" style={{ marginTop: 8 }}>
          请先在第 1 步导入 SRT（或点击「载入术语演示」），导入术语表后自动扫描全片。
        </p>
      )}

      {glossary.length > 0 && cues.length > 0 && (
        <>
          <div className="metrics">
            <div className="metric">
              <div className="v">{hits.length}</div>
              <div className="k">命中总数</div>
            </div>
            <div className="metric">
              <div className="v">{cueWithHits}</div>
              <div className="k">涉及字幕</div>
            </div>
            <div className="metric">
              <div className="v">{conflictCount}</div>
              <div className="k">冲突待人工确认</div>
            </div>
          </div>

          {hits.length === 0 ? (
            <p className="hint">未发现别名或同音误写。</p>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <label className="field" style={{ minWidth: 240 }}>
                  <span className="hint">按术语筛选（点击下表行亦可）</span>
                  <select
                    value={filterEntry === null ? '' : String(filterEntry)}
                    onChange={(e) =>
                      setFilterEntry(e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">全部术语（{hits.length} 次命中）</option>
                    {entriesWithHits.map((id) => (
                      <option key={id} value={id}>
                        #{id} {termOf(id)}（{hitCountByEntry.get(id) ?? 0} 次）
                      </option>
                    ))}
                  </select>
                </label>
                {filterEntry !== null && (
                  <button className="ghost" onClick={() => setFilterEntry(null)}>
                    清除筛选
                  </button>
                )}
              </div>

              <table className="term-table">
                <thead>
                  <tr>
                    <th>条目</th>
                    <th>原词（命中写法）</th>
                    <th>建议词（标准词）</th>
                    <th>命中次数</th>
                    <th>冲突</th>
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .filter((r) => filterEntry === null || r.entryId === filterEntry)
                    .map((r) => (
                      <tr
                        key={`${r.entryId}|${r.alias}`}
                        className={`clickable${filterEntry === r.entryId ? ' active' : ''}`}
                        title="点击按该条目筛选命中"
                        onClick={() => setFilterEntry(filterEntry === r.entryId ? null : r.entryId)}
                      >
                        <td>#{r.entryId}</td>
                        <td>{r.alias}</td>
                        <td>{r.term}</td>
                        <td>{r.count}</td>
                        <td>
                          {r.conflicts > 0 ? (
                            <span className="badge warn">{r.conflicts} 待确认</span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>

              <div className="term-hits">
                {filteredHits.slice(0, HIT_LIST_LIMIT).map((h, i) => {
                  const cue = cues[h.cueIndex]
                  const chars = charsOf(flattenCueText(cue.lines))
                  const s = Math.max(0, h.start - SNIPPET_CTX)
                  const e = Math.min(chars.length, h.end + SNIPPET_CTX)
                  return (
                    <div
                      key={i}
                      className={`term-hit-row${h.conflict ? ' conflict' : ''}`}
                      title={
                        (h.conflict ? `冲突：${h.reason ?? ''}；` : '') + '点击跳转到该字幕'
                      }
                      onClick={() => onJumpToCue(h.cueIndex)}
                    >
                      <span className="idx">#{h.cueIndex + 1}</span>
                      <span className="t">{msToSrtTime(cue.startMs)}</span>
                      <span className="snippet">
                        {s > 0 && '…'}
                        {chars.slice(s, h.start).join('')}
                        <mark className={h.conflict ? 'mark-conflict' : 'mark-hit'}>
                          {chars.slice(h.start, h.end).join('')}
                        </mark>
                        {chars.slice(h.end, e).join('')}
                        {e < chars.length && '…'}
                      </span>
                      <span className="suggest">
                        {h.found} → {h.term}
                      </span>
                      {h.conflict && <span className="badge warn">需人工确认</span>}
                    </div>
                  )
                })}
                {filteredHits.length > HIT_LIST_LIMIT && (
                  <p className="hint" style={{ padding: '8px 12px', margin: 0 }}>
                    仅显示前 {HIT_LIST_LIMIT} 条命中，其余 {filteredHits.length - HIT_LIST_LIMIT}{' '}
                    条请导出 JSON 查看。
                  </p>
                )}
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button onClick={exportJson}>生成替换预览 JSON</button>
                <span className="hint">
                  仅导出替换预览：非冲突命中应用建议词、冲突保留原文并标记
                  needsReview；不改写原字幕与当前修复选区。
                </span>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
