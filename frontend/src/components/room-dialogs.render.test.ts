import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import BlockedPlayersPanel from './BlockedPlayersPanel.vue';
import TeamInspectDialog from './TeamInspectDialog.vue';
import WagerInspectDialog from './WagerInspectDialog.vue';

/**
 * 房间体验的两个新弹窗（SSR 冒烟）：PixelDialog 用 teleport，正文在 ssrContext.teleports.body 里，
 * 这里断言弹窗真的渲染出了标题与关闭按钮（onMounted 的数据加载在 SSR 下不执行）。
 */
vi.mock('@/api/battles', () => ({
  listBlockedPlayers: async () => [],
  blockPlayer: async () => ({ playerId: 'x' }),
  unblockPlayer: async () => undefined,
  getRoomDetail: async () => null,
}));

function render(component: unknown, props: Record<string, unknown> = {}) {
  const ctx: { teleports?: Record<string, string> } = {};
  return renderToString(createSSRApp({ render: () => h(component as never, props) }), ctx).then(
    (html) => ({ html, body: ctx.teleports?.body ?? '' }),
  );
}

describe('房间弹窗渲染冒烟', () => {
  it('查看押注弹窗：标题 + 加载态 + 关闭按钮', async () => {
    const { body } = await render(WagerInspectDialog, { roomId: 'r_1' });
    expect(body).toContain('查看押注');
    expect(body).toContain('加载押注明细');
    expect(body).toContain('关闭');
  });

  it('查看队伍弹窗：标题 + 加载态 + 关闭按钮', async () => {
    const { body } = await render(TeamInspectDialog, { roomId: 'r_1' });
    expect(body).toContain('查看队伍');
    expect(body).toContain('加载出战队伍');
    expect(body).toContain('关闭');
  });

  it('屏蔽名单弹窗：标题 + 说明 + 名单为空', async () => {
    const { body } = await render(BlockedPlayersPanel);
    expect(body).toContain('屏蔽名单（30 分钟）');
    expect(body).toContain('无法加入你创建的任何对战房间');
    expect(body).toContain('名单为空');
  });
});
