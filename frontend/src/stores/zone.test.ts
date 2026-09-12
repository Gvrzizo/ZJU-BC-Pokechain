import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_ZONE_ID,
  ZONES,
  ZONE_ALIASES,
  lureAllowed,
  resolveZoneId,
  useZoneStore,
  zoneById,
  zoneHint,
  zoneLabel,
  zoneLevelText,
} from './zone';

/** 区域表（docs/backend-api.md §2「区域与栖息地野生池」）：前端镜像后端 encounter.data.ts */
describe('区域表与 id 解析', () => {
  it('覆盖前端安全区 + 七块普通区 + 六个传说区', () => {
    const ids = ZONES.map((z) => z.id);
    expect(ids).toEqual([
      'town',
      'route-grass',
      'forest',
      'route-mid',
      'cave',
      'coast',
      'route-north',
      'volcano',
      'sky-pillar',
      'seafloor',
      'magma',
      'ruins',
      'southern-island',
      'birth-island',
    ]);
  });

  it('等级带与阶段门槛与后端契约一致', () => {
    expect(zoneById('route-grass')).toMatchObject({ minLevel: 2, maxLevel: 6, maxStage: 0 });
    expect(zoneById('forest')).toMatchObject({ minLevel: 4, maxLevel: 10, maxStage: 0 });
    expect(zoneById('route-mid')).toMatchObject({ minLevel: 8, maxLevel: 16, maxStage: 1 });
    expect(zoneById('cave')).toMatchObject({ minLevel: 12, maxLevel: 20, maxStage: 1 });
    expect(zoneById('coast')).toMatchObject({ minLevel: 15, maxLevel: 25, maxStage: 1 });
    expect(zoneById('route-north')).toMatchObject({ minLevel: 17, maxLevel: 28, maxStage: 2 });
    expect(zoneById('volcano')).toMatchObject({ minLevel: 20, maxLevel: 30, maxStage: 2 });
    // 展示名与后端一致（HUD / 图鉴「出现区域」）
    expect(zoneById('route-grass').name).toBe('101 号道路·草丛');
    expect(zoneById('route-north').name).toBe('冠军之路');
    expect(zoneById('volcano').name).toBe('烟囱山');
  });

  it('普通区等级带单调抬升（越深入越强）', () => {
    const wild = ZONES.filter((z) => !z.safe && !z.legendary);
    for (let i = 1; i < wild.length; i++) {
      expect(wild[i].minLevel!).toBeGreaterThan(wild[i - 1].minLevel!);
      expect(wild[i].maxLevel!).toBeGreaterThan(wild[i - 1].maxLevel!);
    }
  });

  it('传说区：固定高等级 + 钥匙 + 池内传说（烈空坐/盖欧卡/固拉多/三神柱/拉帝兄弟/代欧奇希斯）', () => {
    const legendary = ZONES.filter((z) => z.legendary);
    expect(legendary).toHaveLength(6);
    for (const zone of legendary) {
      expect(zoneLevelText(zone)).toMatch(/^Lv4\d-\d\d$/);
      expect(zone.legendary!.keyTypeId).toBeTruthy();
      expect(zone.legendary!.speciesIds.length).toBeGreaterThan(0);
      // 传说区禁止诱饵（后端 LURE_NOT_ALLOWED）
      expect(lureAllowed(zone)).toBe(false);
    }
    expect(zoneById('sky-pillar').legendary).toMatchObject({ speciesIds: [384], keyTypeId: 'sky-key' });
    expect(zoneById('seafloor').legendary).toMatchObject({ speciesIds: [382], keyTypeId: 'ocean-key' });
    expect(zoneById('magma').legendary).toMatchObject({ speciesIds: [383], keyTypeId: 'magma-key' });
    expect(zoneById('ruins').legendary).toMatchObject({ speciesIds: [377, 378, 379], keyTypeId: 'ruins-key' });
    expect(zoneById('southern-island').legendary).toMatchObject({ speciesIds: [380, 381], keyTypeId: 'island-key' });
    expect(zoneById('birth-island').legendary).toMatchObject({ speciesIds: [386], keyTypeId: 'birth-key' });
    expect(zoneById('ruins').legendary?.name).toContain('雷吉斯奇鲁');
  });

  it('旧 id 兼容别名：south/mid/north → 三个 route 区', () => {
    expect(ZONE_ALIASES).toEqual({ south: 'route-grass', mid: 'route-mid', north: 'route-north' });
    expect(resolveZoneId('south')).toBe('route-grass');
    expect(resolveZoneId('north')).toBe('route-north');
    expect(zoneById('mid').id).toBe('route-mid');
    expect(zoneById('nope').id).toBe(DEFAULT_ZONE_ID);
    expect(resolveZoneId('nope')).toBeUndefined();
  });

  it('zoneLabel / zoneHint / 安全区文案', () => {
    expect(zoneLabel(zoneById('route-grass'))).toBe('101 号道路·草丛 Lv2-6');
    expect(zoneLabel(zoneById('route-north'))).toBe('冠军之路 Lv17-28');
    expect(zoneLabel(zoneById('sky-pillar'))).toBe('天空之柱 Lv45-50');
    expect(zoneLabel(zoneById('town'))).toBe('未白镇');
    expect(zoneHint(zoneById('route-grass'))).toBe('未进化型出没');
    expect(zoneHint(zoneById('coast'))).toBe('可见进化型');
    expect(zoneHint(zoneById('route-north'))).toBe('进化型领地');
    expect(zoneHint(zoneById('sky-pillar'))).toBe('传说出没：烈空坐');
    expect(zoneHint(zoneById('town'))).toBe('没有野生宝可梦');
    expect(lureAllowed(zoneById('route-grass'))).toBe(true);
    expect(lureAllowed(zoneById('town'))).toBe(true);
  });
});

describe('zone store', () => {
  it('enter 接受新 id 与旧别名，非法值回退缺省区', () => {
    setActivePinia(createPinia());
    const store = useZoneStore();
    store.enter('cave');
    expect(store.id).toBe('cave');
    expect(store.label).toBe('石之洞窟 Lv12-20');
    store.enter('south');
    expect(store.id).toBe('route-grass');
    store.enter('not-a-zone');
    expect(store.id).toBe(DEFAULT_ZONE_ID);
  });
});
