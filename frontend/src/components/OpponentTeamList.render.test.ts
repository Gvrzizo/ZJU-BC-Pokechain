import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OpponentTeamList from './OpponentTeamList.vue';
import type { RankedOpponentPokemon } from '@/types';

/**
 * 排位接受期的对手阵容预览（SSR）：只渲染服务端给的公开字段
 * （昵称/等级/闪光/最终能力值），IV/EV/性格根本不在类型里。
 */
async function render(props: Record<string, unknown>) {
  return renderToString(createSSRApp({ render: () => h(OpponentTeamList as never, props) }));
}

const mon = (over: Partial<RankedOpponentPokemon> = {}): RankedOpponentPokemon => ({
  id: 'p_1',
  name: 'pikachu',
  speciesId: 25,
  nameZh: '皮卡丘',
  level: 20,
  shiny: false,
  stats: { hp: 44, atk: 35, def: 28, spatk: 30, spdef: 30, speed: 41 },
  ...over,
});

describe('接受期对手阵容渲染（docs/backend-api.md §11.1）', () => {
  it('渲染昵称/种族名、等级、闪光标记与最终能力值', async () => {
    const html = await render({
      team: [mon(), mon({ id: 'p_2', name: 'charmander', speciesId: 4, nameZh: '小火龙', level: 12, shiny: true })],
      title: '对手出战队伍（2 只）',
      hint: '只能看到昵称/等级/闪光与最终能力值',
    });
    expect(html).toContain('对手出战队伍（2 只）');
    expect(html).toContain('皮卡丘');
    expect(html).toContain('Lv20');
    expect(html).toContain('小火龙');
    expect(html).toContain('Lv12');
    expect(html).toContain('★');
    expect(html).toContain('攻击35'); // statsLine 一行能力值
    expect(html).toContain('只能看到昵称/等级/闪光与最终能力值');
    // 渲染结果里没有 IV / EV / 性格（这些字段不属于对手视图）
    expect(html).not.toMatch(/ivs|evs|nature/i);
  });

  it('改名后的昵称优先展示（链上 name 与种族名不同）', async () => {
    const html = await render({ team: [mon({ name: '闪电小子' })], title: '对手出战队伍（1 只）' });
    expect(html).toContain('闪电小子');
    expect(html).not.toContain('皮卡丘');
  });
});
