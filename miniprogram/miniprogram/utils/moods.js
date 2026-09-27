// 心情与标签，和网页版保持一致
const MOODS = [
  { id: 'angry', label: '暴躁', emoji: '😤', line: '#E8452F', note: '#FFE0D6', ink: '#7A2416' },
  { id: 'wronged', label: '委屈', emoji: '🥺', line: '#3F7BE0', note: '#DDE9FF', ink: '#17356B' },
  { id: 'meh', label: '无语', emoji: '😐', line: '#6B7280', note: '#E9ECF0', ink: '#31373F' },
  { id: 'melt', label: '崩溃', emoji: '🤯', line: '#9B57E0', note: '#EDE0FF', ink: '#46216E' },
  { id: 'numb', label: '麻木', emoji: '😪', line: '#2F9C77', note: '#D9F2E7', ink: '#14513B' },
  { id: 'warm', label: '小确幸', emoji: '🥰', line: '#E0A000', note: '#FFF1C2', ink: '#6B4A00' }
]

const TAGS = ['工作', '学习', '家人', '恋爱', '朋友', '生活', '网上冲浪', '自己']

function moodOf(id) {
  return MOODS.find(m => m.id === id) || MOODS[0]
}

function relTime(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  const m = Math.floor(diff / 60000)
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 30) return d + ' 天前'
  return Math.floor(d / 30) + ' 个月前'
}

// 给列表里的每条吐槽补上展示用的字段
function decorate(p) {
  const m = moodOf(p.mood)
  return Object.assign({}, p, {
    emoji: m.emoji,
    moodLabel: m.label,
    moodColor: m.line,
    noteColor: m.note,
    inkColor: m.ink,
    timeText: relTime(p.createdAt),
    replyCount: (p.replies || []).length,
    shortText: p.text.length > 70 ? p.text.slice(0, 70) + '…' : p.text
  })
}

module.exports = { MOODS, TAGS, moodOf, relTime, decorate }
