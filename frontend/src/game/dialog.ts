/**
 * 对话框状态机（纯逻辑，不依赖 Phaser）：逐句翻页，翻完最后一句后结束。
 * `DialogBox`（Phaser 渲染）与单测共用它，保证"翻页 → 结束 → 触发动作"的顺序一致。
 */
export interface DialogPage {
  /** 说话人（NPC 名 / 「路牌」 / 建筑名）；空串表示旁白 */
  speaker: string;
  lines: string[];
}

export class DialogSession {
  private pageIndex = 0;
  private lineIndex = 0;
  private finished = false;

  constructor(private readonly pages: DialogPage[]) {
    if (pages.length === 0) this.finished = true;
  }

  get isOpen(): boolean {
    return !this.finished;
  }

  get speaker(): string {
    return this.pages[this.pageIndex]?.speaker ?? '';
  }

  /** 当前显示的一行（对话已结束时为空串） */
  get line(): string {
    if (this.finished) return '';
    return this.pages[this.pageIndex]?.lines[this.lineIndex] ?? '';
  }

  /** 当前是不是最后一行（渲染层据此显示 ▼ / ● 结束标记） */
  get isLastLine(): boolean {
    if (this.finished) return true;
    const page = this.pages[this.pageIndex];
    const lastPage = this.pageIndex === this.pages.length - 1;
    return lastPage && this.lineIndex >= (page?.lines.length ?? 1) - 1;
  }

  /** 第几页 / 共几页（1 起，渲染层显示 1/2） */
  get progress(): { page: number; total: number } {
    return { page: Math.min(this.pageIndex + 1, this.pages.length), total: this.pages.length };
  }

  /**
   * 翻到下一句。返回 true 表示对话**已结束**（调用方此时执行待办动作：治疗 / 进商店 / 传送）。
   */
  advance(): boolean {
    if (this.finished) return true;
    const page = this.pages[this.pageIndex];
    if (this.lineIndex < (page?.lines.length ?? 1) - 1) {
      this.lineIndex += 1;
      return false;
    }
    if (this.pageIndex < this.pages.length - 1) {
      this.pageIndex += 1;
      this.lineIndex = 0;
      return false;
    }
    this.finished = true;
    return true;
  }

  close(): void {
    this.finished = true;
  }
}

/** 把多段对话拼成 session（`speaker` 相同的连续段合并成同一页） */
export function sessionFrom(pages: DialogPage[]): DialogSession {
  const merged: DialogPage[] = [];
  for (const page of pages) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === page.speaker) last.lines = [...last.lines, ...page.lines];
    else merged.push({ speaker: page.speaker, lines: [...page.lines] });
  }
  return new DialogSession(merged.filter((p) => p.lines.length > 0));
}
