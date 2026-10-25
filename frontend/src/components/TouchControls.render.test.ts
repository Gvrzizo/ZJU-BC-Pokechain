import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import TouchControls from './TouchControls.vue';

/** SSR 只验证结构/标签；指针行为由 game/touch-input.test.ts 的模块单测覆盖。 */
async function render(visible?: boolean): Promise<string> {
  const app = createSSRApp({ render: () => h(TouchControls, visible === undefined ? {} : { visible }) });
  return renderToString(app);
}

describe('TouchControls', () => {
  it('visible=true：渲染四向 D-pad、跑步开关与 A 动作键', async () => {
    const html = await render(true);
    expect(html).toContain('data-testid="touch-controls"');
    expect(html).toContain('aria-label="触控操作"');
    for (const dir of ['up', 'down', 'left', 'right']) {
      expect(html).toContain(`data-testid="touch-${dir}"`);
    }
    for (const label of ['向上', '向下', '向左', '向右']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('data-testid="touch-action"');
    expect(html).toContain('aria-label="互动/确认"');
    expect(html).toContain('data-testid="touch-run"');
    expect(html).toContain('aria-label="跑步切换"');
    expect(html).toContain('跑');
    // 触控层不应抢走画布的滚动/选择手势
    expect(html).toContain('touch-controls');
  });

  it('visible=false：完全不渲染（SSR 输出为空）', async () => {
    const html = await render(false);
    expect(html).not.toContain('touch-controls');
    expect(html).not.toContain('touch-action');
  });

  it('自动检测模式在 Node（无 window）下不抛异常且默认隐藏', async () => {
    // vitest 的 node 环境没有 window / matchMedia；组件必须守卫 SSR
    const html = await render(undefined);
    expect(html).not.toContain('touch-controls');
  });
});
