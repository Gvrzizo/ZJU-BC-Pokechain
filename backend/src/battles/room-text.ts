/**
 * 房名 / 备注 / 加入留言 / 模板名的统一处理（docs/backend-api.md §5）：
 * 去掉首尾空白与控制字符后做 HTML 转义，保证写进房间（Redis JSON）与 PG 的文本
 * 不含可注入的标签。DTO 层负责"用户输入 ≤ N 字"，这里负责落库前的清洗。
 */

/** 单字符转义后的最长膨胀倍数（`"` → `&quot;`），DB 列宽按它预留。 */
export const ESCAPE_MAX_EXPANSION = 6;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** trim + 控制字符清理 + HTML 转义；非字符串（未传字段）返回空串。 */
export function sanitizeRoomText(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  // 控制字符（含换行/制表/零宽段）在像素风单行文本里没有意义，一并折叠成空格
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  return cleaned.trim().replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}
