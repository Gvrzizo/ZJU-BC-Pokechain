import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/utils/errors';

/** 昵称长度上限（trim 并折叠内部空白后按 Unicode 码点计，与前端输入框 maxlength 对齐）。 */
export const POKEMON_NAME_MAX = 12;

/** 控制字符（C0/C1 + DEL）：像素风单行文本里没有意义，直接拒绝。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** HTML 特殊字符：昵称会原样写进链上 `name` 并在各处渲染，**拒绝而不是转义**（转义后与玩家输入不一致）。 */
const HTML_SPECIALS = /[<>&"']/;

function invalidName(message: string): never {
  throw new AppException('INVALID_NAME', message, HttpStatus.BAD_REQUEST);
}

/**
 * 昵称清洗 + 校验（docs/backend-api.md §2「改名」）：
 * trim、折叠内部空白（换行/制表符属控制字符，已在前一步拒绝）→ 长度 1-12 个字符（码点）→ 拒绝 `<>&"'`。
 *
 * 与 battles 的 `sanitizeRoomText` 同属"落链前先清洗"的思路；区别是昵称不可转义展示，
 * 出现 HTML 特殊字符时一律拒绝（控制字符同理）。
 */
export function normalizePokemonName(raw: unknown): string {
  if (typeof raw !== 'string') invalidName('name must be a string');
  if (CONTROL_CHARS.test(raw)) invalidName('name must not contain control characters');
  if (HTML_SPECIALS.test(raw)) invalidName('name must not contain any of <>&"\'');
  const name = raw.replace(/\s+/g, ' ').trim();
  const length = Array.from(name).length;
  if (length < 1 || length > POKEMON_NAME_MAX) {
    invalidName(`name must be 1-${POKEMON_NAME_MAX} characters after trimming (got ${length})`);
  }
  return name;
}
